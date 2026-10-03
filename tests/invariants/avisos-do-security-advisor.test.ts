import { describe, expect, it } from "vitest";

import { lastLine, sql } from "./gov-helpers";

/**
 * Os dois avisos do Security Advisor do Supabase que a migration 0521 fecha
 * (PR #2125, @usebeehub). Sem este arquivo, nada impede a volta deles:
 *
 *   - `function_search_path_mutable`: um `create or replace function` sem
 *     `set search_path` APAGA o `alter function ... set search_path` anterior.
 *     Basta um apêndice novo redefinir uma das 7 funções para o aviso voltar,
 *     em silêncio, em toda instalação que roda o `update.sh`.
 *   - `fn_resolve_inbound_number` é definer ESTÁVEL, então a varredura de
 *     `hardening-definer-varredura.test.ts` (que vigia só as voláteis) não a
 *     alcança — e foi assim que o EXECUTE de `authenticated` passou.
 *
 * A consulta segue a regra do lint 0011 do Supabase (splinter): função de
 * `public` que não pertence a extensão e não tem `search_path` em `proconfig`.
 */
function semSearchPath(): string[] {
  const out = sql(`
    select p.oid::regprocedure::text
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and not exists (
         select 1 from pg_depend d
          where d.classid = 'pg_proc'::regclass and d.objid = p.oid and d.deptype = 'e')
       and not exists (
         select 1 from unnest(coalesce(p.proconfig, '{}')) c where c like 'search_path=%')
     order by 1;
  `);
  return out.split("\n").filter((l) => l.trim() !== "");
}

/** Chama a função com o papel dado e devolve 'ok' ou 'negado' — comportamento, não catálogo. */
function chamaComo(papel: string): string {
  return lastLine(sql(`
    set role ${papel};
    do $$
    begin
      perform * from public.fn_resolve_inbound_number('+550000000000');
      perform set_config('tri.r', 'ok', false);
    exception when insufficient_privilege then
      perform set_config('tri.r', 'negado', false);
    end $$;
    select current_setting('tri.r');
  `));
}

describe("avisos do Security Advisor (migration 0521)", () => {
  it("o inventário de funções de public não vem vazio (guarda de vacuidade)", () => {
    const total = Number(
      sql(`select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'public';`),
    );
    expect(total).toBeGreaterThan(100);
  });

  it("nenhuma função de public fica sem search_path fixo", () => {
    expect(
      semSearchPath(),
      "Função sem `set search_path` — `create or replace function` sem a cláusula " +
        "apaga o `alter function ... set search_path` anterior. Ponha " +
        "`set search_path = ''` (ou `= public`) na própria definição, na migration " +
        "E no apêndice do baseline.",
    ).toEqual([]);
  });

  it("fn_resolve_inbound_number: authenticated e anon não executam; service_role sim", () => {
    expect(chamaComo("authenticated")).toBe("negado");
    expect(chamaComo("anon")).toBe("negado");
    expect(chamaComo("service_role")).toBe("ok");
  });

  it("os validadores de CHECK seguem respondendo com search_path vazio", () => {
    expect(
      sql(`select public.fn_degraus_de_lembrete_validos(array[15, 60])::text
               || ',' || public.fn_degraus_de_lembrete_validos(array[5])::text
               || ',' || public.fn_corpos_de_lembrete_validos('{"1":"oi"}'::jsonb)::text
               || ',' || public.fn_corpos_de_lembrete_validos('{"x":1}'::jsonb)::text;`),
    ).toBe("true,false,true,false");
  });
});
