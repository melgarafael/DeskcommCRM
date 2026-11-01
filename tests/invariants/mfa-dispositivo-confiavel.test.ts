import { beforeAll, describe, expect, it } from "vitest";

import { sql } from "./gov-helpers";

/**
 * Migration 0747 — "confiar neste dispositivo". A confiança é uma linha de
 * `mfa_trusted_devices` amarrada ao `session_id` do JWT, e `fn_session_mfa_proven`
 * (a que as definer de agenda, resposta, roteamento etc. chamam) passa a aceitá-la.
 *
 * O caso que importa é o primeiro: se `authenticated` pudesse gravar na tabela,
 * qualquer sessão `aal1` com a senha certa se dispensaria do código sozinha.
 */
const USUARIO = "dddddddd-0707-4000-8000-000000000001";
const OUTRO = "dddddddd-0707-4000-8000-000000000002";
const FATOR = "dddddddd-0707-4000-8000-0000000000f1";
const SESSAO = "dddddddd-0707-4000-8000-0000000000a1";
const OUTRA_SESSAO = "dddddddd-0707-4000-8000-0000000000a2";

function comoUsuario(corpo: string, sessao = SESSAO, aal = "aal1", papel = "authenticated"): string {
  const claims = JSON.stringify({ sub: USUARIO, session_id: sessao, aal });
  return sql(`
    begin;
    set local role ${papel};
    select set_config('request.jwt.claims', '${claims}', true);
    ${corpo}
    rollback;
  `);
}

const provada = (sessao = SESSAO, aal = "aal1") =>
  comoUsuario("select public.fn_session_mfa_proven();", sessao, aal)
    .split("\n")
    .filter((l) => l === "t" || l === "f")
    .pop();

function confiar(userId: string, sessao: string, expira: string) {
  sql(`
    delete from public.mfa_trusted_devices where user_id in ('${USUARIO}','${OUTRO}');
    insert into public.mfa_trusted_devices (user_id, factor_id, token_hash, session_id, expires_at)
    values ('${userId}', '${FATOR}', md5(random()::text), '${sessao}', ${expira});
  `);
}

beforeAll(() => {
  sql(`
    insert into auth.users (id, email) values
      ('${USUARIO}', 'confiavel-0707@example.test'), ('${OUTRO}', 'outro-0707@example.test')
    on conflict (id) do nothing;
    insert into auth.mfa_factors (id, user_id, status, factor_type)
    values ('${FATOR}', '${USUARIO}', 'verified', 'totp') on conflict (id) do nothing;
    delete from public.mfa_trusted_devices where user_id in ('${USUARIO}','${OUTRO}');
  `);
});

describe("0747 — dispositivo confiável da MFA", () => {
  it("authenticated NÃO lê nem grava a tabela (senão se dispensaria do código sozinho)", () => {
    const tentativa = (stmt: string) =>
      comoUsuario(`
        do $$ begin ${stmt}; raise notice 'passou';
        exception when insufficient_privilege then raise exception 'negado'; end $$;
      `);
    for (const stmt of [
      `perform 1 from public.mfa_trusted_devices`,
      `insert into public.mfa_trusted_devices (user_id, factor_id, token_hash, session_id, expires_at)
         values ('${USUARIO}', '${FATOR}', 'x', '${SESSAO}', now() + interval '1 day')`,
    ]) {
      expect(() => tentativa(stmt)).toThrow(/negado/);
    }
  });

  it("CONTROLE: sessão aal1 com fator, sem confiança, não está provada; aal2 está", () => {
    sql(`delete from public.mfa_trusted_devices where user_id = '${USUARIO}';`);
    expect(provada()).toBe("f");
    expect(provada(SESSAO, "aal2")).toBe("t");
  });

  it("confiança válida prova a sessão AMARRADA a ela — e só ela", () => {
    confiar(USUARIO, SESSAO, "now() + interval '30 days'");
    expect(provada()).toBe("t");
    expect(provada(OUTRA_SESSAO)).toBe("f");
  });

  it("fator removido (por QUALQUER caminho) mata a confiança — mesmo com a linha de pé", () => {
    confiar(USUARIO, SESSAO, "now() + interval '30 days'");
    sql(`update auth.mfa_factors set status = 'unverified' where id = '${FATOR}';`);
    try {
      // Sem fator verificado a pessoa nem deve MFA; o que importa é que a
      // confiança não sobreviva a um fator NOVO:
      sql(`insert into auth.mfa_factors (id, user_id, status, factor_type)
           values ('dddddddd-0707-4000-8000-0000000000f2', '${USUARIO}', 'verified', 'totp');`);
      expect(provada()).toBe("f");
    } finally {
      sql(`delete from auth.mfa_factors where id = 'dddddddd-0707-4000-8000-0000000000f2';
           update auth.mfa_factors set status = 'verified' where id = '${FATOR}';`);
    }
  });

  it("confiança vencida não prova nada", () => {
    confiar(USUARIO, SESSAO, "now() - interval '1 second'");
    expect(provada()).toBe("f");
  });

  it("a confiança de OUTRA pessoa na mesma sessão não prova a minha", () => {
    confiar(OUTRO, SESSAO, "now() + interval '30 days'");
    expect(provada()).toBe("f");
  });

  it("o app pode perguntar (authenticated executa); a anon key não", () => {
    expect(
      sql(`select has_function_privilege('authenticated', 'public.fn_session_mfa_proven()', 'EXECUTE'),
                  has_function_privilege('anon', 'public.fn_session_mfa_proven()', 'EXECUTE');`),
    ).toBe("t|f");
  });
});
