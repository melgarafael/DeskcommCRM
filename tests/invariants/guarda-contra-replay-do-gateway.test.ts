import { describe, expect, it } from "vitest";

import { sql } from "./gov-helpers";

/**
 * A GUARDA CONTRA REPLAY DO GATEWAY RESPONDE 409 — E SÓ A QUEM É REPLAY.
 *
 * ## O defeito que fez este arquivo existir (migration 0237)
 *
 * Em 2026-09-11 o produto inteiro respondia "Algo deu errado": o PostgREST não
 * conseguia carregar o schema cache (503 PGRST002) porque o gateway do Supabase
 * reexecutava, ~2.300×/s, oito requisições de dois dias antes que terminavam em
 * `raise ... errcode='40001'` — um conflito benigno que o PostgREST devolve como
 * HTTP 500, e 5xx o gateway trata como transitório. O hook `pgrst.db_pre_request`
 * lê o `sb-request-id` (UUIDv7) e responde `PT409` a requisição aceita há mais de
 * 5 minutos; 4xx não é reexecutado.
 *
 * ## O que se prova aqui
 *
 * O hook roda ANTES de toda query, sob o papel da requisição. Errar para o lado
 * restritivo é pior do que não ter hook: um falso 409 recusaria requisição
 * legítima, e um erro interno da guarda seria mais um 5xx a reexecutar. Então
 * as três negativas (id recente, sem cabeçalho, cabeçalho fora do formato) valem
 * tanto quanto a positiva.
 *
 * O papel `authenticator` não existe no Postgres descartável do `test:db`, e o
 * baseline pula o `alter role` de propósito — o próprio run deste arquivo prova
 * que o install fresco não cai por isso. O registro no papel é vigiado no
 * ambiente que o tem: `docs/runbooks/postgrest-replay-do-gateway.md`.
 */

/**
 * Chama a guarda com um `request.headers` simulado e devolve o SQLSTATE ('00000' = passou).
 * O resultado sai por SELECT (stdout), nunca por NOTICE: o helper `sql()` só devolve stdout.
 */
function sqlstateDaGuarda(headersJson: string | null): string {
  const set = headersJson === null ? "" : `perform set_config('request.headers', $h$${headersJson}$h$, true);`;
  // psql -tA ainda imprime os rótulos de comando (CREATE TABLE, DELETE, DO); só a linha do SELECT interessa.
  const saida = sql(`
    create temp table if not exists guarda_resultado (sqlstate text);
    delete from guarda_resultado;
    do $t$
    begin
      ${set}
      perform public.fn_pgrst_recusar_replay_do_gateway();
      insert into guarda_resultado values ('00000');
    exception when others then
      insert into guarda_resultado values (sqlstate);
    end $t$;
    select 'SQLSTATE=' || sqlstate from guarda_resultado;
  `);
  return saida.match(/SQLSTATE=[0-9A-Z]{5}/)?.[0] ?? `sem SQLSTATE na saída: ${saida}`;
}

/** UUIDv7 cujo instante embutido é `agoraMs - idadeMs`. */
function uuidv7(idadeMs: number): string {
  const hex = (Date.now() - idadeMs).toString(16).padStart(12, "0");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-7abc-8def-0123456789ab`;
}

describe("0237 — guarda contra replay do gateway do Supabase", () => {
  it("existe, não é definer, e os três papéis de requisição podem executá-la (senão a guarda vira 5xx)", () => {
    const linha = sql(`
      select p.prosecdef,
             has_function_privilege('anon', p.oid, 'EXECUTE'),
             has_function_privilege('authenticated', p.oid, 'EXECUTE'),
             has_function_privilege('service_role', p.oid, 'EXECUTE')
        from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and p.proname = 'fn_pgrst_recusar_replay_do_gateway';
    `).trim();
    expect(linha).toBe("f|t|t|t");
  });

  it("requisição aceita há mais de 5 minutos recebe PT409 (HTTP 409, que o gateway não reexecuta)", () => {
    const idVelho = uuidv7(6 * 60 * 1000);
    expect(sqlstateDaGuarda(JSON.stringify({ "sb-request-id": idVelho }))).toBe("SQLSTATE=PT409");
  });

  it("as oito de 2026-09-09 (o caso real) recebem PT409", () => {
    expect(sqlstateDaGuarda(JSON.stringify({ "sb-request-id": "01a08690-28dd-73b2-a7a5-823fb6f76ab1" }))).toBe(
      "SQLSTATE=PT409",
    );
  });

  it("requisição recente passa", () => {
    expect(sqlstateDaGuarda(JSON.stringify({ "sb-request-id": uuidv7(2_000) }))).toBe("SQLSTATE=00000");
  });

  it("sem cabeçalho de requisição (chamada fora do PostgREST) passa", () => {
    expect(sqlstateDaGuarda(null)).toBe("SQLSTATE=00000");
  });

  it("sb-request-id que não é UUIDv7 passa — a guarda só decide quando há instante para ler", () => {
    expect(sqlstateDaGuarda(JSON.stringify({ "sb-request-id": "req-abc-123" }))).toBe("SQLSTATE=00000");
    expect(sqlstateDaGuarda(JSON.stringify({ "sb-request-id": "01a08690-28dd-43b2-a7a5-823fb6f76ab1" }))).toBe(
      "SQLSTATE=00000",
    );
  });

  it("cabeçalho que não é JSON não derruba a requisição", () => {
    expect(sqlstateDaGuarda("isto não é json")).toBe("SQLSTATE=00000");
  });
});
