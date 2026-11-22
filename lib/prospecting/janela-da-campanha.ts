/**
 * A JANELA DA CAMPANHA DE PROSPECÇÃO (#4830, saída 1).
 *
 * O PROBLEMA: a janela de disparo de hoje é do NÚMERO (`channel_knobs`: dias
 * próprios da prospecção + horas de disparo). Quem usa um número só para dois
 * nichos — um de manhã, outro à tarde — pausa e retoma a mão a cada troca.
 *
 * A RÉGUA NOVA: a campanha ganha, OPCIONALMENTE, "rodar só em tais dias entre X
 * e Y horas", no fuso da ORGANIZAÇÃO (`organizations.timezone`). Vazia = o
 * comportamento de hoje, byte por byte.
 *
 * AS DUAS JANELAS SE CRUZAM, NÃO SE SUBSTITUEM. A do número é a régua
 * anti-banimento (aquecimento, teto, cadência do número); a da campanha é a
 * régua do DIA DE TRABALHO de quem opera. Uma campanha só dispara onde as duas
 * estão abertas: `sendNextCandidate` consulta a do número como sempre e, logo
 * depois, esta — fora dela, a fila ESPERA (`next_send_at`), sem tentar, sem
 * queimar quota e sem marcar candidato.
 *
 * A TRAVA DE UMA CAMPANHA POR NÚMERO CONTINUA VALENDO (#3896/#3102, saída 2 da
 * issue é decisão de produto e não entra aqui). Por isso a pausa e a retomada
 * automáticas passam pelo MESMO caminho que a tela usa: `status='paused'` e
 * `assertCanalLivre` na volta. Quando a janela de uma campanha abre com OUTRA
 * `running` no mesmo número, a trava decide — e a espera é NOMEADA na coluna
 * `error` da campanha ("a janela abriu, mas o número está com outra campanha em
 * andamento; volta sozinha quando o número ficar livre"), nunca silenciosa.
 *
 * `pausada_pela_janela` é o que separa a pausa AUTOMÁTICA da pausa de quem
 * opera: só a automática volta sozinha. Pausa manual, arquivamento e início
 * limpam a marca. INVARIANTE (é dela que as consultas daqui vivem sem repetir
 * `status='paused'`): a marca só é verdadeira enquanto a campanha está pausada —
 * quem a grava é o UPDATE da pausa (que exige `running`) e quem a limpa é todo
 * caminho que devolve a campanha a `running`.
 */
import type pg from "pg";
import { z } from "zod";

import { instantFromWall, wallClock } from "@/lib/agent-engine/pacing/relogio-de-parede";
import { assertCanalLivre, canalDaCampanha } from "./canal-da-campanha";
import { ProspectingError } from "./provider";

/** Dia da semana na convenção JS (`getDay`): 0=domingo … 6=sábado. */
const DIA_POR_NOME: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

/**
 * A janela da campanha: dias (0..6), hora de início e hora de fim.
 *
 * `inicio < fim` e dias não vazios, conferidos AQUI porque as duas pontas
 * precisam da mesma régua: o `start`/`adjust` (servidor) e o formulário da
 * tela. Dia vazio significaria "nunca dispara" — pausa permanente disfarçada
 * de configuração —, e uma janela que atravessa a meia-noite teria duas
 * leituras possíveis ("hoje 22h-02h" ou "ontem 22h-02h"); quem precisa de duas
 * faixas usa duas campanhas, que é o caso de uso da issue.
 */
export const janelaDaCampanhaSchema = z
  .object({
    dias: z
      .array(z.number().int().min(0).max(6))
      .min(1)
      .max(7)
      .transform((dias) => [...new Set(dias)].sort((a, b) => a - b)),
    inicio: z.number().int().min(0).max(23),
    fim: z.number().int().min(1).max(24),
  })
  .strict()
  .superRefine((janela, ctx) => {
    if (janela.inicio >= janela.fim)
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "A janela da campanha precisa começar antes de terminar (ex.: 7h às 12h).",
      });
  });

export type JanelaDaCampanha = z.infer<typeof janelaDaCampanhaSchema>;

/**
 * A janela gravada na campanha, ou `null` quando ela não tem (ou tem uma
 * inválida). Inválida NÃO derruba nada: a régua que decide é a do número, e
 * uma configuração que ninguém consegue ler não pode calar a campanha.
 */
export function janelaDa(config: unknown): JanelaDaCampanha | null {
  const bruta = (config as { janela?: unknown } | null)?.janela;
  if (bruta == null) return null;
  const lida = janelaDaCampanhaSchema.safeParse(bruta);
  return lida.success ? lida.data : null;
}

/** A campanha pode disparar AGORA pela janela dela? Sem janela = sempre. */
export function janelaDaCampanhaAberta(
  now: Date,
  janela: JanelaDaCampanha,
  timezone: string,
): boolean {
  const w = wallClock(now, timezone);
  if (!janela.dias.includes(DIA_POR_NOME[w.weekday] ?? -1)) return false;
  return w.h >= janela.inicio && w.h < janela.fim;
}

/** Próxima abertura da janela ESTRITAMENTE depois de `now`, no fuso dado. */
export function proximaAberturaDaJanelaDaCampanha(
  now: Date,
  janela: JanelaDaCampanha,
  timezone: string,
): Date {
  const w = wallClock(now, timezone);
  // 8 dias cobrem qualquer combinação de dias (o pior caso é hoje + 7).
  for (let add = 0; add <= 7; add += 1) {
    const candidate = instantFromWall(w.y, w.mo, w.d + add, janela.inicio, timezone);
    if (candidate.getTime() <= now.getTime()) continue;
    const dia = wallClock(candidate, timezone).weekday;
    if (!janela.dias.includes(DIA_POR_NOME[dia] ?? -1)) continue;
    return candidate;
  }
  // Inalcançável com `dias` não vazio (o schema garante); devolve a próxima
  // madrugada em vez de laço infinito.
  return instantFromWall(w.y, w.mo, w.d + 1, janela.inicio, timezone);
}

/**
 * O motivo gravado quando a campanha pausa porque a janela fechou.
 *
 * Texto FIXO, sem interpolação: a tela traduz `error` por `t(erro)`, cuja chave
 * é o texto em português — uma frase montada com nome e hora não teria como
 * ganhar espanhol e sairia crua para quem opera em espanhol. A janela em si (e
 * o fuso) aparecem no cartão da campanha, que os lê do `config`.
 */
export const MOTIVO_DA_PAUSA_PELA_JANELA =
  "Fora do horário da campanha. Ela volta sozinha na próxima abertura.";

/** O motivo gravado quando a janela abre mas o número está ocupado (espera NOMEADA). */
export const MOTIVO_DA_ESPERA_PELO_NUMERO =
  "O horário da campanha abriu, mas o número está com outra campanha em andamento. Ela retoma sozinha quando o número ficar livre.";

type LinhaComJanela = {
  id: string;
  name: string;
  config: unknown;
  channel_session_id?: string | null;
};

/**
 * PAUSA as campanhas `running` cuja janela fechou. É o MESMO caminho de pausa
 * da tela (rota `pause`): `status='paused'` + motivo em `error`. A diferença é
 * a marca `pausada_pela_janela`, que é o que autoriza a volta automática.
 *
 * Roda dentro do bloqueio da organização, no tick, ANTES da retomada — é essa
 * ordem que libera o número para a campanha do próximo horário no MESMO tick.
 */
export async function pausarCampanhasForaDaJanela(
  db: pg.PoolClient,
  org: string,
  now: Date,
  timezone: string,
): Promise<Array<{ id: string; name: string }>> {
  const { rows } = await db.query<LinhaComJanela>(
    "select id,name,config from prospecting_campaigns where organization_id=$1 and status='running' and config ? 'janela'",
    [org],
  );
  const pausadas: Array<{ id: string; name: string }> = [];
  for (const linha of rows) {
    const janela = janelaDa(linha.config);
    if (!janela) continue;
    if (janelaDaCampanhaAberta(now, janela, timezone)) continue;
    const mudou = await db.query<{ id: string }>(
      "update prospecting_campaigns set status='paused',pausada_pela_janela=true,error=$3,updated_at=now() where organization_id=$1 and id=$2 and status='running' returning id",
      [org, linha.id, MOTIVO_DA_PAUSA_PELA_JANELA],
    );
    if (mudou.rows.length) pausadas.push({ id: linha.id, name: linha.name });
  }
  return pausadas;
}

/**
 * RETOMA as campanhas que a janela pausou e cuja janela está aberta — pelo
 * MESMO caminho da rota `resume`: `assertCanalLivre` antes do `status='running'`.
 *
 * Se o número ainda estiver com outra campanha, NÃO retoma e grava o motivo da
 * espera na campanha: a trava decide e a espera é nomeada. O `23505`
 * (`prospecting_one_running_canal`, alguém ocupou o número entre a checagem e o
 * UPDATE) cai no mesmo aviso — nunca num 500 nem num silêncio.
 */
export async function retomarCampanhasNaJanela(
  db: pg.PoolClient,
  org: string,
  now: Date,
  timezone: string,
): Promise<{ retomadas: string[]; esperando: string[] }> {
  const { rows } = await db.query<LinhaComJanela>(
    "select id,name,config,channel_session_id from prospecting_campaigns where organization_id=$1 and pausada_pela_janela and coalesce(config->>'arquivada_em','') = '' order by next_send_at asc, id asc",
    [org],
  );
  const retomadas: string[] = [];
  const esperando: string[] = [];
  for (const linha of rows) {
    const janela = janelaDa(linha.config);
    if (janela && !janelaDaCampanhaAberta(now, janela, timezone)) continue;
    try {
      await assertCanalLivre(db, org, linha.id, canalDaCampanha(linha));
      // A marca entra no WHERE de novo, e não só no SELECT acima: a rota `pause`
      // não espera o bloqueio do tick, então uma pausa da pessoa pode chegar
      // entre a leitura e esta escrita. Ela zera a marca e o status continua
      // 'paused'; sem a marca aqui, o tick desfaria a pausa de quem apertou.
      const { rows: acordou } = await db.query<{ id: string }>(
        "update prospecting_campaigns set status='running',pausada_pela_janela=false,error=null,channel_down_since=null,next_send_at=greatest(next_send_at,now()+interval '1 minute'),updated_at=now() where organization_id=$1 and id=$2 and status='paused' and pausada_pela_janela returning id",
        [org, linha.id],
      );
      if (acordou.length > 0) retomadas.push(linha.id);
    } catch (error) {
      const ocupada =
        error instanceof ProspectingError && error.codigo === "prospecting_channel_busy";
      const corrida = (error as { code?: string }).code === "23505";
      if (!ocupada && !corrida) throw error;
      // A espera é NOMEADA: o motivo vai para a coluna `error` da campanha, que é
      // o que o cartão mostra — nunca um silêncio, nunca um 500. Sem nome do
      // ocupante aqui: a frase precisa ser a MESMA chave de tradução do dicionário.
      await db.query(
        "update prospecting_campaigns set error=$3,updated_at=now() where organization_id=$1 and id=$2 and pausada_pela_janela",
        [org, linha.id, MOTIVO_DA_ESPERA_PELO_NUMERO],
      );
      esperando.push(linha.id);
    }
  }
  return { retomadas, esperando };
}
