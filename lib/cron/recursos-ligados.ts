/**
 * A LEITURA COMPARTILHADA de "o que está ligado" nesta instalação (#3694).
 *
 * ─── O que ela resolve ──────────────────────────────────────────────────────
 *
 * Oito rotas de cron rodam a cada minuto e, numa instalação sem campanha, sem
 * importação, sem proposta presa e sem follow-up, voltavam SEMPRE vazias: oito
 * consultas por minuto para descobrir o mesmo nada (medido pelo autor da issue:
 * `campaigns` 2,0/min, `webhook_events_log` 1,2/min, claim do follow-up
 * 1,0/min, e mais cinco em 1,0/min). Cada rota perguntando "tem trabalho?" à
 * própria tabela não economiza nada — a pergunta custa a mesma consulta.
 *
 * O que economiza é perguntar UMA vez por todas: uma chamada a
 * `fn_cron_recursos_ligados()` (migration 9044) por janela de cache, dentro do
 * processo do app, compartilhada pelas rotas que estiverem batendo naquele
 * instante. Instalação parada: ~1 ida ao banco a cada 45 s em vez de oito por
 * minuto.
 *
 * ─── O risco, e o lado para onde ele erra ───────────────────────────────────
 *
 * A rota que sai cedo por engano para de rodar em SILÊNCIO — campanha que não
 * sai, mensagem que não volta. Isso é pior que a consulta vazia. Por isso:
 *
 *   1. cada chave da função é a condição EXATA da consulta que ela substitui,
 *      e `webhook_events_log` é deliberadamente mais larga (superconjunto);
 *   2. QUALQUER dúvida — RPC ausente (migration ainda não aplicada), erro de
 *      rede, corpo fora do contrato — responde **ligado** e a rota roda como
 *      hoje. O gate nunca é o motivo de um recurso parar.
 *
 * ─── Custo de perceber o recurso ligado ─────────────────────────────────────
 *
 * `VALIDADE_MS` = 45 s, dentro da faixa que a issue pede (30–60 s): um recurso
 * que liga é percebido no máximo um tique depois (o cron é de minuto). Para os
 * caminhos em que a espera apareceria na cara de quem agiu, o evento INVALIDA a
 * leitura (`invalidarRecursosLigados()`):
 *
 *   - o botão "Iniciar"/"Agendar" da campanha
 *     (`app/api/v1/campaigns/[id]/[acao]/route.ts`);
 *   - a inscrição manual num fluxo de follow-up (`lib/followup/enroll.ts`);
 *   - a própria rota do follow-up, quando o tick reclamou/avançou ou a varredura
 *     de silêncio inscreveu alguém — o trabalho que ELA criou não pode ficar
 *     invisível para a batida seguinte.
 *
 * Os demais recursos ligam por caminho que este processo não vê (trigger do
 * banco no follow-up, worker em outro contêiner na fila); para eles o teto é o
 * TTL, que é curto de propósito.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { logger } from "@/lib/logger";

/**
 * Os recursos, um por consulta vazia que a issue mediu. A ordem e os nomes são
 * o contrato com `fn_cron_recursos_ligados()`; `tests/unit/cron-recursos-ligados-sql-x-typescript.test.ts`
 * reprova se um lado ganhar chave que o outro não tem (o mesmo desenho do par
 * banco × TypeScript do vocabulário).
 */
export const RECURSOS_DO_CRON = [
  "campanhas",
  "webhook_replay",
  "followup",
  "followup_silencio",
  "fila_followup",
  "pausa_de_canal",
  "historico",
  "propostas",
] as const;

export type RecursoDoCron = (typeof RECURSOS_DO_CRON)[number];
export type RecursosLigados = Record<RecursoDoCron, boolean>;

/**
 * Quanto tempo o processo confia na última leitura. Curto DE PROPÓSITO: é o
 * atraso máximo entre um recurso ligar por um caminho que este processo não vê
 * (trigger no banco, worker em outro contêiner) e a rota voltar a rodar. Acima
 * de um minuto, o conserto passaria a ser pior que a consulta vazia — é
 * exatamente o que a issue adverte.
 */
export const VALIDADE_MS = 45_000;

/** O que a rota devolve quando sai cedo. Distingue "pulado" de "vazio". */
export const MOTIVO_DO_PULO = "recurso_desligado";

type Leitura = { valores: RecursosLigados; ate: number };

let ultima: Leitura | null = null;
/** Uma leitura em voo serve TODAS as rotas que cheguem juntas (ver `ler`). */
let emVoo: Promise<RecursosLigados> | null = null;
/**
 * Contador de invalidações. É o que impede a corrida óbvia: a leitura que já
 * estava em voo quando o evento invalidou NÃO pode regravar o memo com o
 * retrato de antes do evento — seria devolver 45 s de "nada a fazer" para a
 * campanha que acabou de ser iniciada.
 */
let geracao = 0;

const TUDO_LIGADO = Object.fromEntries(RECURSOS_DO_CRON.map((r) => [r, true])) as RecursosLigados;

/**
 * O corpo da RPC é `jsonb`, e jsonb vem como objeto. Só `true` liga: chave
 * ausente, `null`, string ou número viram **ligado** (o lado seguro), nunca
 * desligado — um contrato quebrado não pode calar cinco rotas de uma vez.
 */
function normalizar(bruto: unknown): RecursosLigados {
  if (!bruto || typeof bruto !== "object" || Array.isArray(bruto)) return TUDO_LIGADO;
  const lido = bruto as Record<string, unknown>;
  const valores = { ...TUDO_LIGADO };
  for (const recurso of RECURSOS_DO_CRON) {
    // `false` explícito é a ÚNICA resposta que desliga.
    valores[recurso] = lido[recurso] !== false;
  }
  return valores;
}

async function perguntarAoBanco(db: SupabaseClient): Promise<RecursosLigados> {
  try {
    const { data, error } = await db.rpc("fn_cron_recursos_ligados");
    if (error) {
      // Fail-open: RPC ausente (migration não aplicada ainda), permissão,
      // timeout. A rota roda como ontem e ninguém fica em silêncio.
      logger.warn("[cron] leitura dos recursos ligados falhou — rodando como antes", {
        codigo: error.code,
        detalhe: error.message,
      });
      return TUDO_LIGADO;
    }
    return normalizar(data);
  } catch (erro) {
    logger.warn("[cron] leitura dos recursos ligados lançou — rodando como antes", {
      detalhe: erro instanceof Error ? erro.message : String(erro),
    });
    return TUDO_LIGADO;
  }
}

/**
 * Uma leitura por janela — e uma só, mesmo com as rotas batendo juntas.
 *
 * Sem o coalescing, as rotas que vencem no mesmo segundo (é o caso: o
 * agendador dispara vários crons no mesmo tique) veriam todas o memo vencido e
 * fariam N chamadas. A promessa em voo é o que faz a leitura ser literalmente
 * compartilhada, e não apenas cacheada.
 */
async function ler(db: SupabaseClient, agora: number): Promise<RecursosLigados> {
  if (ultima !== null && ultima.ate > agora) return ultima.valores;
  if (emVoo !== null) return emVoo;

  const minhaGeracao = geracao;
  emVoo = perguntarAoBanco(db).then((valores) => {
    // Só grava se ninguém invalidou no meio do caminho (ver `geracao`).
    if (geracao === minhaGeracao) ultima = { valores, ate: agora + VALIDADE_MS };
    return valores;
  });
  try {
    return await emVoo;
  } finally {
    emVoo = null;
  }
}

/**
 * `true` = a rota deve rodar. `db` é o cliente de serviço que a rota já criou —
 * a leitura não abre cliente nenhum.
 */
export async function recursoLigado(
  db: SupabaseClient,
  recurso: RecursoDoCron,
  agora: number = Date.now(),
): Promise<boolean> {
  const valores = await ler(db, agora);
  return valores[recurso];
}

/**
 * O evento que LIGA um recurso avisa aqui — o tique seguinte já o enxerga, sem
 * esperar o TTL. Hoje quem chama é o botão da campanha (iniciar/retomar/agendar/
 * duplicar); é o único liga/desliga em que 45 s aparecem na cara de quem clicou.
 */
export function invalidarRecursosLigados(): void {
  ultima = null;
  emVoo = null;
  geracao += 1;
}

/** Só para teste: esquece a leitura e a chamada em voo. */
export const esquecerLeituraDosRecursos = invalidarRecursosLigados;
