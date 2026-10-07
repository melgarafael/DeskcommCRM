/**
 * AVISO DE FORA DO HORÁRIO DE ATENDIMENTO — issue #1926.
 *
 * ## O que o pedido diz (a regra mora na issue, não aqui)
 *
 * Quem escreve fora da janela do agente não recebe nada: o turno é ADIADO para
 * a abertura (`janela-de-atendimento.ts`) e a pessoa fica sem saber se a
 * mensagem chegou. O pedido é um texto fixo configurável pela organização,
 * enviado NA HORA quando a mensagem chega fora da janela, no máximo UMA vez
 * por contato por período fechado, nunca para contato bloqueado/opt-out nem
 * para número interno, registrado na conversa.
 *
 * ## As três réguas que este aviso NÃO pode furar
 *
 * 1. **Opt-out / `is_blocked`** (regra dura nº 2) — lido direto da fonte antes
 *    de qualquer coisa cara; o handler de envio ainda barra de novo (403).
 * 2. **Pacing / teto de envio** (F2-11) — o aviso é RESPOSTA (quem escreveu
 *    primeiro é o contato), então lê a janela `resposta*`, o warm-up, o cap
 *    diário e o throttle, e CONTA no `pacing_ledger`: gastou uma mensagem do
 *    número como qualquer outra. Vetado ⇒ não envia agora; anti-ban não é
 *    cortesia, é o que mantém o número vivo.
 * 3. **LGPD** — titular anonimizado não recebe nada (`isAnonymized` veta
 *    QUALQUER envio na cadeia; aqui a mesma régua, antes de gastar rede).
 *
 * O que este aviso NÃO faz: passar na frente da IA. Ele só existe no ramo em
 * que o turno foi adiado; quando a janela abre, o turno roda normalmente e a
 * conversa já tem a linha do aviso — a IA não o repete porque não há nada a
 * repetir, o contato foi atendido.
 *
 * ## PERÍODO FECHADO é a chave de tudo
 *
 * `inicioDoPeriodoFechado` devolve o instante em que a janela fechou. A
 * identidade do aviso é `(conversa, início do período)` — gerada ANTES de
 * enviar e gravada em `messages.metadata.idempotency_key`. A consulta de
 * "já avisado?" é uma leitura por essa chave; o mesmo período devolve a mesma
 * chave e não manda de novo, o próximo período tem chave nova. Sem tabela
 * nova, sem migration, e o registro vive na própria conversa.
 *
 * ## Falha ABERTA, sempre
 *
 * Este módulo toca banco, pacing e canal dentro do RAMO EM QUE O TURNO VAI SER
 * ADIADO de qualquer forma: qualquer erro aqui pode perder um aviso, nunca a
 * resposta (que segue agendada para a abertura). Por isso as portas de
 * produção ficam em import DINÂMICO: o topo deste arquivo tem de carregar num
 * teste unitário sem ambiente, sem `@/lib/env` e sem a cadeia de guardrails.
 */
import type { Queryable } from '../queue/queue';
import { decidePacing } from '../pacing/engine';
import {
  inicioDoPeriodoFechado,
  msAteAJanelaAbrir,
  type JanelaDeAtendimento,
} from './janela-de-atendimento';

/** Marcador gravado em `messages.metadata` — é o que a consulta de dedupe lê. */
export const MARCA_DO_AVISO = 'aviso_fora_do_horario';

/** Teto do texto configurado: jsonb é livre, balão de 40KB não é. */
export const TAMANHO_MAXIMO_DO_TEXTO = 1000;

export interface ContatoDoAviso {
  isBlocked: boolean;
  forceHuman: boolean;
  isAnonymized: boolean;
  phoneNumber: string | null;
}

export type DecisaoDoAviso =
  | { enviar: true; texto: string }
  | { enviar: false; motivo: string };

/**
 * Texto do aviso lido de `trigger_config.filters.business_hours.notice`.
 *
 * `null` = sem aviso (campo ausente, vazio, tipo errado) — a direção segura é
 * NÃO avisar, nunca improvisar frase. Mesma filosofia de
 * `lerJanelaDeAtendimento`: jsonb livre não pode virar mordaça nem fonte de
 * texto inesperado.
 */
export function lerTextoDoAvisoForaDoHorario(triggerConfig: unknown): string | null {
  if (typeof triggerConfig !== 'object' || triggerConfig === null) return null;
  const filters = (triggerConfig as { filters?: unknown }).filters;
  if (typeof filters !== 'object' || filters === null) return null;
  const bh = (filters as { business_hours?: unknown }).business_hours;
  if (typeof bh !== 'object' || bh === null) return null;
  const aviso = (bh as { notice?: unknown }).notice;
  if (typeof aviso !== 'string') return null;
  const texto = aviso.trim();
  if (texto === '') return null;
  return texto.slice(0, TAMANHO_MAXIMO_DO_TEXTO);
}

/**
 * A identidade do aviso: MESMA chave dentro de um período fechado, chave nova
 * quando a janela abre e fecha de novo. Vira `messages.metadata.idempotency_key`,
 * então a mesma pergunta de dedupe é a mesma pergunta de idempotência do envio.
 *
 * O eixo é o CONTATO, não a conversa: o pedido é "uma vez por contato", e um
 * contato com duas conversas (canal diferente, conversa reaberta) continua
 * recebendo um aviso só por período.
 */
export function chaveDoAviso(contactId: string, periodoInicio: Date): string {
  return `aviso-fora-do-horario:${contactId}:${periodoInicio.toISOString()}`;
}

export interface PerguntaDeAviso {
  janela: JanelaDeAtendimento | null;
  agora: Date;
  texto: string | null;
}

/**
 * As três condições que dispensam banco, rede e pacing — na ordem em que se
 * dispensam. Separadas em função porque o chamador de produção quer parar BARATO
 * (turno adiado sem nenhuma ida ao banco) e a regra completa reusa a mesma fonte
 * em vez de ter uma segunda cópia que uma hora diverge.
 */
export function preCheckDoAviso(input: PerguntaDeAviso): DecisaoDoAviso | null {
  // Sem janela declarada o turno nem entra neste ramo — mas a pergunta é do
  // aviso, então ela responde: sem janela não há "fora dela".
  if (input.janela === null) return { enviar: false, motivo: 'sem_janela' };
  // Dentro da janela não há aviso: a IA vai responder agora.
  if (msAteAJanelaAbrir(input.janela, input.agora) === null)
    return { enviar: false, motivo: 'dentro_da_janela' };
  // Sem texto configurado não há o que dizer, e inventar é proibido.
  if (input.texto === null || input.texto.trim() === '')
    return { enviar: false, motivo: 'sem_configuracao' };
  return null;
}

export interface DecisaoCompleta extends PerguntaDeAviso {
  contato: ContatoDoAviso | null;
  ehNumeroInterno: boolean;
  jaAvisado: boolean;
}

/**
 * A REGRA completa, pura: recebe os fatos (relógio, janela, texto, contato,
 * dedupe) e diz enviar/não enviar com o motivo em pt-br. Sem I/O — é ela que o
 * teste de cenário exercita.
 *
 * A ordem dos vetos é a da doutrina da cadeia de envio: irreversíveis primeiro
 * (opt-out, anonimização), depois o escopo (número interno), e o dedupe por
 * último porque ele é o único que depende do período.
 */
export function decideAvisoForaDoHorario(input: DecisaoCompleta): DecisaoDoAviso {
  const preco = preCheckDoAviso(input);
  if (preco) return preco;

  const { contato } = input;
  if (contato === null) return { enviar: false, motivo: 'contato_inexistente' };
  // Opt-out/força-humano: irrevogável, primeira linha (regra dura nº 2).
  if (contato.isBlocked || contato.forceHuman)
    return { enviar: false, motivo: 'opt_out' };
  // LGPD: titular anonimizado não recebe mensagem nenhuma.
  if (contato.isAnonymized) return { enviar: false, motivo: 'titular_anonimizado' };
  // Número da própria organização: laço robô-com-robô (mesma régua do aviso de
  // caso, `destinoEhDaPropriaOrganizacao`).
  if (input.ehNumeroInterno) return { enviar: false, motivo: 'numero_interno' };
  // UMA vez por contato por período fechado.
  if (input.jaAvisado) return { enviar: false, motivo: 'ja_avisado_no_periodo' };

  return { enviar: true, texto: input.texto as string };
}

export interface PortasDoAviso {
  /** Flags do contato lidas DIRETO da fonte (`contacts`), nunca de cache. */
  leContato(organizationId: string, contactId: string): Promise<ContatoDoAviso | null>;
  /** O telefone do contato é um número de conexão ATIVA desta organização? */
  ehNumeroInterno(organizationId: string, phoneNumber: string): Promise<boolean>;
  /** Já existe a linha com esta chave de aviso para ESTE contato? */
  jaAvisado(organizationId: string, contactId: string, chave: string): Promise<boolean>;
  pacing: {
    decide(
      organizationId: string,
      channelSessionId: string,
      agora: Date,
    ): Promise<{ liberado: boolean; motivo?: string }>;
    /** Conta o aviso no `pacing_ledger` — gastou uma mensagem do número. */
    registraEnvio(organizationId: string, channelSessionId: string, quando: Date): Promise<void>;
  };
  envia(entrada: {
    organizationId: string;
    conversationId: string;
    chave: string;
    body: string;
  }): Promise<void>;
}

export interface EntradaDoAviso {
  organizationId: string;
  conversationId: string;
  contactId: string;
  channelSessionId: string;
  texto: string | null;
  janela: JanelaDeAtendimento | null;
  agora: Date;
}

/**
 * Orquestra: regra barata → fatos do banco → regra completa → pacing → envio →
 * contabilidade. Lança só para o chamador registrar (o turno é adiado de
 * qualquer forma); NUNCA grava "já avisado" sem enviar.
 */
export async function enviaAvisoForaDoHorario(
  deps: PortasDoAviso,
  entrada: EntradaDoAviso,
): Promise<DecisaoDoAviso> {
  // 1. As três perguntas baratas, antes de tocar em banco.
  const preco = preCheckDoAviso(entrada);
  if (preco) return preco;

  // 2. O PERÍODO FECHADO vigente: sem régua não dá para prometer "só uma vez".
  const janela = entrada.janela as JanelaDeAtendimento;
  const periodoInicio = inicioDoPeriodoFechado(janela, entrada.agora);
  if (periodoInicio === null) return { enviar: false, motivo: 'sem_periodo' };
  const chave = chaveDoAviso(entrada.contactId, periodoInicio);

  // 3. Os fatos do banco, na ordem do mais barato ao mais caro.
  const contato = await deps.leContato(entrada.organizationId, entrada.contactId);
  const ehNumeroInterno =
    contato?.phoneNumber != null && contato.phoneNumber !== ''
      ? await deps.ehNumeroInterno(entrada.organizationId, contato.phoneNumber)
      : false;
  const jaAvisado = await deps.jaAvisado(entrada.organizationId, entrada.contactId, chave);

  // 4. A regra completa.
  const decisao = decideAvisoForaDoHorario({
    janela,
    agora: entrada.agora,
    texto: entrada.texto,
    contato,
    ehNumeroInterno,
    jaAvisado,
  });
  if (!decisao.enviar) return decisao;

  // 5. Pacing — resposta (não disparo), com warm-up, cap diário e throttle.
  const pacing = await deps.pacing.decide(
    entrada.organizationId,
    entrada.channelSessionId,
    entrada.agora,
  );
  if (!pacing.liberado)
    return { enviar: false, motivo: `pacing:${pacing.motivo ?? 'vetado'}` };

  // 6. O envio. Quem falhar aqui NÃO grava dedupe: o próximo contato do mesmo
  //    período tenta de novo (e, se a linha já tiver sido inserida, o dedupe
  //    alcança antes de qualquer duplicata).
  await deps.envia({
    organizationId: entrada.organizationId,
    conversationId: entrada.conversationId,
    chave,
    body: decisao.texto,
  });

  // 7. Depois do envio, em seu PRÓPRIA try/catch: derrubar aqui reprocessaria o
  //    aviso e o contato receberia duas vezes.
  try {
    await deps.pacing.registraEnvio(
      entrada.organizationId,
      entrada.channelSessionId,
      entrada.agora,
    );
  } catch {
    // O envio já aconteceu; a perda é a contabilidade, não a mensagem.
  }

  return decisao;
}

// ---------------------------------------------------------------------------
// Portas de produção — import DINÂMICO de propósito (ver cabeçalho).
// ---------------------------------------------------------------------------

type LogDoAviso = { warn(mensagem: string, meta?: unknown): void };

/**
 * As portas reais sobre o `pg.Pool` da sessão e o client do app.
 *
 * `supabase` é `unknown` na assinatura e convertido no ponto de uso: este
 * módulo não importa o handler no topo (ele valida ambiente ao carregar, e o
 * teste unitário deste arquivo morreria antes da primeira asserção).
 */
export function portasDeProducao(
  db: Queryable,
  supabase: unknown,
  log?: LogDoAviso,
): PortasDoAviso {
  return {
    async leContato(organizationId, contactId) {
      const sql = (colunas: string) =>
        `select ${colunas} from contacts where organization_id = $1 and id = $2`;
      let rows: Array<Record<string, unknown>>;
      try {
        const res = await db.query<Record<string, unknown>>(
          sql('is_blocked, force_human, is_anonymized, phone_number'),
          [organizationId, contactId],
        );
        rows = res.rows;
      } catch {
        // Clone sem uma das colunas novas: falha ABERTA, mas não em mordaça —
        // sem coluna, a leitura é a mais conservadora (não bloqueado) só para
        // o opt-out, que é a coluna antiga; anonimização/força-humano sem
        // coluna caem no handler, que tem os guardas dele.
        const res = await db.query<Record<string, unknown>>(
          sql('is_blocked, false as force_human, false as is_anonymized, phone_number'),
          [organizationId, contactId],
        );
        rows = res.rows;
      }
      const row = rows[0];
      if (!row) return null;
      return {
        isBlocked: Boolean(row.is_blocked),
        forceHuman: Boolean(row.force_human),
        isAnonymized: Boolean(row.is_anonymized),
        phoneNumber: typeof row.phone_number === 'string' ? row.phone_number : null,
      };
    },

    async ehNumeroInterno(organizationId, phoneNumber) {
      const { phoneLookupVariants } = await import('@/lib/channels/phone-variants');
      const variantes = phoneLookupVariants(phoneNumber)
        .map((v) => v.replace(/\D/g, ''))
        .filter((v) => v !== '');
      if (variantes.length === 0) return false;
      // Só conexão ATIVA: arquivada não envia nem recebe, então não fecha laço.
      const { rows } = await db.query<{ phone_number: string | null }>(
        `select phone_number from channel_sessions
          where organization_id = $1 and archived_at is null and phone_number is not null`,
        [organizationId],
      );
      return rows.some(
        (linha) =>
          linha.phone_number !== null &&
          variantes.includes(linha.phone_number.replace(/\D/g, '')),
      );
    },

    async jaAvisado(organizationId, contactId, chave) {
      const { rows } = await db.query<{ id: string }>(
        `select id from messages
          where organization_id = $1 and contact_id = $2
            and metadata->>'idempotency_key' = $3
          limit 1`,
        [organizationId, contactId, chave],
      );
      return rows.length > 0;
    },

    pacing: {
      async decide(organizationId, channelSessionId, agora) {
        try {
          const [{ loadChannelKnobs, loadPacingState }, { capabilitiesOf }] =
            await Promise.all([
              import('../pacing/store'),
              import('@/lib/channels/capabilities'),
            ]);
          const cfg = await loadChannelKnobs(db, organizationId, channelSessionId);
          const { rows: sessao } = await db.query<{ provider: string | null }>(
            'select provider from channel_sessions where organization_id = $1 and id = $2',
            [organizationId, channelSessionId],
          );
          // Provider fora da matriz → `capabilitiesOf` lança → catch abaixo,
          // fechado: o conservador é contar com risco de banimento.
          const provider = sessao[0]?.provider ?? null;
          const banRisk = provider
            ? capabilitiesOf(provider as never).banRisk
            : true;
          const state = await loadPacingState(db, organizationId, channelSessionId, {
            now: agora,
            timezone: cfg.knobs.timezone,
            numberActivatedAt: cfg.numberActivatedAt,
          });
          const dailyLimit = await db.query<{ daily_message_limit: number | null }>(
            'select daily_message_limit from channel_sessions where organization_id = $1 and id = $2',
            [organizationId, channelSessionId],
          );
          const decision = decidePacing({
            now: agora,
            knobs: cfg.knobs,
            state,
            crmDailyLimit: dailyLimit.rows[0]?.daily_message_limit ?? null,
            banRisk,
            // RESPOSTA: é o contato que escreveu primeiro. O aviso não é
            // disparo ativo, e a janela `resposta*` é a que protege a resposta.
            resposta: true,
          });
          return decision.allow
            ? { liberado: true }
            : { liberado: false, motivo: decision.code };
        } catch (err) {
          // Sem ritmo conhecido não há envio: o anti-ban vale mais que o aviso.
          log?.warn('[aviso-fora-do-horario] pacing indisponível — aviso não enviado', {
            organization_id: organizationId,
            error: (err instanceof Error ? err.message : String(err)).slice(0, 200),
          });
          return { liberado: false, motivo: 'pacing_indisponivel' };
        }
      },

      async registraEnvio(organizationId, channelSessionId, quando) {
        const { recordSend } = await import('../pacing/store');
        await recordSend(db, organizationId, channelSessionId, quando);
      },
    },

    async envia({ organizationId, conversationId, chave, body }) {
      const { sendMessageHandler } = await import('@/app/api/v1/messages/_handler');
      await sendMessageHandler(
        supabase as never,
        {
          organization_id: organizationId,
          // Autoria AUTOMAÇÃO (não IA): ninguém escreveu este texto, uma regra
          // da organização mandou — é o vocabulário de `messages.sent_via`.
          actor: { type: 'webhook_source', id: 'agent-engine' },
          requestId: chave,
        },
        {
          conversation_id: conversationId,
          type: 'text',
          body,
          metadata: {
            idempotency_key: chave,
            [MARCA_DO_AVISO]: true,
          },
        },
      );
    },
  };
}
