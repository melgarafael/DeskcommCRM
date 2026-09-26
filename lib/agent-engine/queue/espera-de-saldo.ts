/**
 * PROVEDOR SEM SALDO — a resposta ESPERA a recarga, em vez de morrer.
 *
 * ## O que acontecia
 *
 * Quando a conta do provedor de IA fica sem crédito, toda chamada volta
 * recusada ("Your credit balance is too low to access the Anthropic API", 400).
 * A fila tratava isso como qualquer falha: 5 tentativas com espera de 10 s a
 * 80 s — **dois minutos e meio** — e depois `dead` + `job_dead` na Central.
 * Só que saldo não volta sozinho em dois minutos e meio: volta quando alguém
 * recarrega, e isso leva o tempo de a pessoa perceber.
 *
 * Medido numa instalação real (24/09/2026): o saldo acabou às 09:48, a recarga
 * entrou às 11:02. Nesse intervalo 19 chamadas foram recusadas; um cliente foi
 * respondido 67 minutos depois (por sorte, pelo follow-up que caiu depois da
 * recarga) e outro NUNCA foi respondido pela IA — o job dele tinha morrido às
 * 09:51. Na Central, três "Uma tarefa do assistente falhou e parou de tentar",
 * que não dizem que a causa era uma só e que se resolvia com uma recarga.
 *
 * ## O que muda
 *
 *   - o job que falhou por falta de saldo volta à fila SEM gastar tentativa
 *     (`rescheduleJob`), a cada 2 min na primeira meia hora e a cada 10 min
 *     depois — quem recarrega logo é respondido logo;
 *   - a espera tem teto: `JANELA_DA_ESPERA_MS` a partir da criação do job.
 *     Passado o teto, o erro segue o caminho de sempre (`failJob` → `job_dead`),
 *     e a conversa aparece na Central como qualquer outra que falhou;
 *   - UM aviso na Central, por organização, que diz a causa e o remédio — e que
 *     some sozinho quando a primeira resposta que esperava sai (o saldo voltou);
 *   - a resposta que esperou não sai se, enquanto isso, alguém do nosso lado já
 *     respondeu o cliente (`jaNaoHaOQueResponder`): uma espera de horas deixa de
 *     ser invisível para a conversa, e a IA não pode repetir quem já atendeu.
 *
 * ## Por que 6 horas
 *
 * É o tempo de alguém ver o aviso num dia de trabalho e recarregar, e fica longe
 * da janela de 24 h do WhatsApp oficial (fora dela a resposta livre é recusada
 * pela plataforma). Uma resposta 3 h atrasada é ruim; nenhuma resposta é pior.
 */
import type pg from 'pg';

import { traduzir } from '@/lib/i18n/dicionario';
import { normalizarIdioma } from '@/lib/i18n/idiomas';

import { insertInboxItem } from '../db/repository';
import { rescheduleJob, type JobRow, type Queryable } from './queue';

/** Teto da espera, contado da criação do job. */
export const JANELA_DA_ESPERA_MS = 6 * 60 * 60_000;

/** Marca no `last_error` do job que está esperando saldo (é o que o distingue na volta). */
export const PREFIXO_DA_ESPERA = 'aguardando saldo do provedor de IA: ';

/** Título do aviso na Central, em português — a chave do dicionário. */
export const TITULO_DO_AVISO = 'A IA está sem saldo no provedor';

const CORPO_DO_AVISO =
  'As respostas aos clientes estão esperando. Recarregue o saldo na conta do provedor: elas saem sozinhas quando o saldo voltar, durante até 6 horas. Depois disso, a conversa que não foi respondida aparece aqui na Central.';

/**
 * As frases com que cada provedor diz "sem crédito". São frases e não o status
 * HTTP porque o status não distingue: a Anthropic devolve 400 (o mesmo de um
 * pedido malformado) e a OpenAI devolve 429 (o mesmo de um limite de ritmo, que
 * passa sozinho e JÁ tem a espera curta da fila).
 */
const FRASES_DE_SEM_SALDO: ReadonlyArray<{ padrao: RegExp; provedor: 'anthropic' | 'openai' }> = [
  { padrao: /credit balance is too low/i, provedor: 'anthropic' },
  { padrao: /insufficient_quota|exceeded your current quota/i, provedor: 'openai' },
];

/** As mensagens do erro e das causas (o SDK às vezes embrulha o erro do provedor). */
function mensagens(err: unknown): string[] {
  const saida: string[] = [];
  let atual: unknown = err;
  for (let i = 0; i < 4 && atual !== undefined && atual !== null; i += 1) {
    saida.push(atual instanceof Error ? atual.message : String(atual));
    atual = typeof atual === 'object' ? (atual as { cause?: unknown }).cause : undefined;
  }
  return saida;
}

/** De qual provedor é a falta de saldo — `null` quando o erro é outro. */
export function provedorSemSaldo(err: unknown): 'anthropic' | 'openai' | null {
  for (const texto of mensagens(err)) {
    for (const f of FRASES_DE_SEM_SALDO) if (f.padrao.test(texto)) return f.provedor;
  }
  return null;
}

/** O job deve esperar a recarga? Só se o erro é falta de saldo e o teto não venceu. */
export function deveEsperarSaldo(
  job: Pick<JobRow, 'created_at'>,
  err: unknown,
  agora: number = Date.now(),
): boolean {
  if (provedorSemSaldo(err) === null) return false;
  return agora - new Date(job.created_at).getTime() < JANELA_DA_ESPERA_MS;
}

/**
 * Quanto esperar até a próxima tentativa: 2 min na primeira meia hora (quem
 * recarrega logo é respondido logo), 10 min depois (sem encher `llm_calls` de
 * recusas durante horas).
 */
export function intervaloDaEspera(job: Pick<JobRow, 'created_at'>, agora: number = Date.now()): number {
  const esperando = agora - new Date(job.created_at).getTime();
  return esperando < 30 * 60_000 ? 2 * 60_000 : 10 * 60_000;
}

/** Este job voltou de uma espera de saldo? */
export function esperouPorSaldo(job: Pick<JobRow, 'last_error'>): boolean {
  return job.last_error?.startsWith(PREFIXO_DA_ESPERA) ?? false;
}

/** Devolve o job à fila sem gastar tentativa, marcado como "esperando saldo". */
export async function adiarAteORecarregar(
  db: Queryable,
  job: Pick<JobRow, 'id' | 'created_at'>,
  workerId: string,
  err: unknown,
  acquiredAt?: string,
  agora: number = Date.now(),
): Promise<JobRow | null> {
  const motivo = (mensagens(err)[0] ?? '').split('\n', 1)[0] ?? '';
  return rescheduleJob(db, job.id, workerId, {
    delayMs: intervaloDaEspera(job, agora),
    reason: PREFIXO_DA_ESPERA + motivo,
    acquiredAt,
  });
}

/**
 * Alguém do nosso lado já falou com o cliente depois da última mensagem dele?
 * Vale só para `inbound_turn`: é o único job que existe PARA responder uma
 * mensagem. Um follow-up que esperou continua fazendo sentido, e a resposta de
 * um caso leva a palavra de uma pessoa ao cliente.
 */
export async function jaNaoHaOQueResponder(
  db: Queryable,
  job: Pick<JobRow, 'kind' | 'organization_id' | 'payload'>,
): Promise<boolean> {
  if (job.kind !== 'inbound_turn') return false;
  const conversa = job.payload.conversation_id;
  if (typeof conversa !== 'string') return false;
  const { rows } = await db.query<{ respondida: boolean }>(
    `select (last_outbound_at is not null
             and (last_inbound_at is null or last_outbound_at >= last_inbound_at)) as respondida
       from conversations
      where id = $1 and organization_id = $2`,
    [conversa, job.organization_id],
  );
  return rows[0]?.respondida === true;
}

async function idiomaDaOrganizacao(db: Queryable, orgId: string) {
  const { rows } = await db.query<{ locale: string | null }>(
    'select locale from organizations where id = $1',
    [orgId],
  );
  return normalizarIdioma(rows[0]?.locale ?? null);
}

/**
 * Abre o aviso na Central — um por organização enquanto estiver aberto. Aponta
 * para a credencial da organização daquele provedor quando ela existe; com a
 * chave da instalação (sem linha em `ai_provider_credentials`) o aviso fica sem
 * destino e o corpo diz o que fazer.
 */
export async function avisarFaltaDeSaldo(
  db: Pick<pg.Pool, 'query'>,
  orgId: string,
  err: unknown,
): Promise<void> {
  const provedor = provedorSemSaldo(err);
  const idioma = await idiomaDaOrganizacao(db, orgId);
  const { rows } = await db.query<{ id: string }>(
    `select id from ai_provider_credentials
      where organization_id = $1 and provider = $2 and is_active
      order by updated_at desc
      limit 1`,
    [orgId, provedor],
  );
  const credencial = rows[0]?.id;
  await insertInboxItem(
    db,
    orgId,
    {
      kind: 'other',
      severity: 'critical',
      title: traduzir(TITULO_DO_AVISO, idioma),
      body: `${traduzir(CORPO_DO_AVISO, idioma)}${provedor ? `\n${traduzir('Provedor', idioma)}: ${provedor}` : ''}`,
      ...(credencial ? { refKind: 'ai_provider_credential', refId: credencial } : {}),
    },
    'kind_e_titulo',
  );
}

/**
 * O saldo voltou: a primeira resposta que esperava saiu. O aviso se fecha
 * sozinho — deixá-lo aberto diria ao dono que ainda falta recarregar.
 */
export async function encerrarAvisoDeFaltaDeSaldo(db: Queryable, orgId: string): Promise<number> {
  const idioma = await idiomaDaOrganizacao(db, orgId);
  const { rowCount } = await db.query(
    `update agent_inbox_items
        set status = 'resolved', resolved_at = now()
      where organization_id = $1 and kind = 'other' and status = 'open' and title = $2`,
    [orgId, traduzir(TITULO_DO_AVISO, idioma)],
  );
  return rowCount ?? 0;
}
