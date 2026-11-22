/**
 * QUANTO CUSTOU O TESTE DO AGENTE — a soma que fecha a linha de `ai_agent_runs`
 * (#4664).
 *
 * ─── O defeito medido ──────────────────────────────────────────────────────
 *
 * A rota `POST /api/v1/ai/agents/:id/versions/:vid/test` abre a linha do run
 * (`ai_agent_runs`, `is_dry_run = true`) e a fecha com status, data, latência e
 * texto — mas com `tokens_in`, `tokens_out` e `cost_cents` no padrão 0. O custo
 * REAL de cada chamada está em `llm_calls`, uma linha por chamada. Até aqui as
 * duas pontas se ignoravam: quem abria o run depois via um teste que não custou
 * nada.
 *
 * ─── Por que a chave é o RUN, e nunca a janela de tempo ────────────────────
 *
 * Somar "as chamadas do agente desde que o run começou" mistura dois testes
 * disparados ao mesmo tempo pelo mesmo agente — e a tela mostraria em cada
 * linha o custo dos dois. O elo durável já existe e é o mesmo que a aba
 * "Execuções" usa para achar a pergunta e a resposta do teste: `llm_calls.
 * preview_run_id` → `ai_agent_runs.id` (migration 9348, #4426). É por ele que a
 * soma é feita — sem coluna nova, sem migration nova.
 *
 * `job_id` (a chave do turno real) NÃO serve aqui: na prévia ele é nulo por
 * construção — não há job de fila —, e preenchê-lo com o id do run faria a
 * prévia se passar por turno real em toda consulta que separa os dois.
 *
 * ─── O que fica FORA da soma, de propósito ─────────────────────────────────
 *
 * As chamadas do teste que não carregam o elo — hoje o `checkpoint` do turno de
 * prévia nasce com `preview_run_id` nulo (`inbound-turn.ts`). Ligá-las é o item
 * 2 da #4664, em outro arquivo. Somar por horário para "não perder" essas
 * linhas reintroduziria exatamente a mistura entre testes simultâneos que este
 * módulo existe para impedir: aqui o número é o das chamadas PROVADAMENTE deste
 * run, e a ausência das outras é medida, não adivinhada.
 */
import type pg from "pg";

/** O que se grava nas colunas de custo do run. */
export interface CustoDoRunDePrevia {
  tokens_in: number;
  tokens_out: number;
  cost_cents: number;
}

/**
 * O mínimo que a soma precisa de um pool — o `pg.Pool` de produção e o dublê do
 * teste passam os dois por aqui.
 */
export interface ConsultaDaSoma {
  query<T>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
}

interface LinhaDaSoma {
  tokens_in: number | string | null;
  tokens_out: number | string | null;
  cost_cents: number | string | null;
}

/**
 * Uma instrução, uma ida ao banco: o run de prévia é UM por execução e as
 * chamadas dele são poucas, mas a soma não pode depender de o driver devolver
 * todas as linhas (o cliente do Supabase corta em 1000) — `sum()` no banco não
 * corta nada.
 *
 * `coalesce` nos três: `cost_cents` é nulo quando o preço do modelo é
 * desconhecido (`llm_calls` não inventa 0), e um run sem chamada nenhuma tem de
 * fechar em ZERO — não em nulo nem em erro.
 */
const SQL_DA_SOMA = `select coalesce(sum(input_tokens), 0)::int as tokens_in,
       coalesce(sum(output_tokens), 0)::int as tokens_out,
       coalesce(sum(cost_cents), 0)::numeric as cost_cents
  from public.llm_calls
 where organization_id = $1 and preview_run_id = $2`;

/**
 * Soma tokens e custo das chamadas de modelo DAQUELE run de prévia.
 *
 * Nunca lança: observabilidade não pode derrubar um teste que já rodou (o
 * resultado está pronto e vai para a tela de qualquer jeito). Falha de leitura
 * devolve `null`, e quem chama decide — hoje, deixar as colunas no padrão e
 * deixar rastro no log, em vez de gravar zero como se fosse medição.
 */
export async function somarCustoDoRunDePrevia(
  db: ConsultaDaSoma,
  organizationId: string,
  runId: string,
): Promise<CustoDoRunDePrevia | null> {
  try {
    const { rows } = await db.query<LinhaDaSoma>(SQL_DA_SOMA, [organizationId, runId]);
    const linha = rows[0];
    if (!linha) return { tokens_in: 0, tokens_out: 0, cost_cents: 0 };
    // `numeric` chega como string no driver do Postgres; `int` como número. A
    // conversão é explícita para o valor gravado não depender do driver.
    return {
      tokens_in: Number(linha.tokens_in ?? 0),
      tokens_out: Number(linha.tokens_out ?? 0),
      cost_cents: Number(linha.cost_cents ?? 0),
    };
  } catch {
    return null;
  }
}

/** O tipo do pool que a rota já tem em mãos (`getRequestPool`). */
export type PoolDaSoma = Pick<pg.Pool, "query">;
