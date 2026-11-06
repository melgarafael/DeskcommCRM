import { beforeAll, describe, expect, it } from "vitest";

import { GOV_VIEWER, seedGov, sql } from "./gov-helpers";
import { motivoDoErro } from "./psql-transporte";

/**
 * 0755 — a tabela de códigos de recuperação é lida e gravada só pelo servidor.
 *
 * As três ações que escrevem em `user_recovery_codes` usam o client de serviço,
 * depois das checagens de sessão de cada uma. Pelo PostgREST, com a anon key ou
 * com o JWT do próprio usuário (em qualquer nível de sessão), a tabela não
 * aceita nada. O controle positivo é o caminho do app: `service_role` troca o
 * conjunto (delete + insert) e marca um código como usado.
 */

const HASH = `'\\x${"ab".repeat(32)}'::bytea`;

/** Roda `dml` com o papel e as claims dadas; devolve null se passou, ou o erro. */
function tentar(papel: "anon" | "authenticated", aal: "aal1" | "aal2" | null, dml: string): string | null {
  const claims = aal ? `{"sub":"${GOV_VIEWER}","role":"authenticated","aal":"${aal}"}` : `{"role":"anon"}`;
  try {
    sql(`
      begin;
      set local role ${papel};
      select set_config('request.jwt.claims', '${claims}', true) is not null;
      ${dml};
      rollback;`);
    return null;
  } catch (err) {
    return motivoDoErro(err);
  }
}

const ESCRITAS = {
  insert: `insert into public.user_recovery_codes (user_id, code_hash) values ('${GOV_VIEWER}', ${HASH})`,
  update: `update public.user_recovery_codes set used_at = now() where user_id = '${GOV_VIEWER}'`,
  delete: `delete from public.user_recovery_codes where user_id = '${GOV_VIEWER}'`,
  select: `select count(*) from public.user_recovery_codes where user_id = '${GOV_VIEWER}'`,
};

beforeAll(() => {
  seedGov();
});

describe("0755 — user_recovery_codes só pelo servidor", () => {
  for (const aal of ["aal1", "aal2"] as const) {
    for (const [op, dml] of Object.entries(ESCRITAS)) {
      it(`o próprio usuário (sessão ${aal}) não faz ${op} — 42501`, () => {
        const erro = tentar("authenticated", aal, dml);
        expect(erro, `authenticated ${aal} fez ${op} sem erro`).not.toBeNull();
        expect(erro).toContain("permission denied");
      });
    }
  }

  for (const [op, dml] of Object.entries(ESCRITAS)) {
    it(`anon não faz ${op} — 42501`, () => {
      const erro = tentar("anon", null, dml);
      expect(erro, `anon fez ${op} sem erro`).not.toBeNull();
      expect(erro).toContain("permission denied");
    });
  }

  it("nenhuma policy da tabela abre escrita", () => {
    const abertas = sql(`
      select coalesce(string_agg(policyname || ':' || cmd, ','), '') from pg_policies
       where schemaname = 'public' and tablename = 'user_recovery_codes'
         and cmd in ('ALL', 'INSERT', 'UPDATE', 'DELETE');`);
    expect(abertas).toBe("");
  });

  it("CONTROLE POSITIVO: service_role troca o conjunto e marca um código como usado", () => {
    const saida = sql(`
      begin;
      set local role service_role;
      delete from public.user_recovery_codes where user_id = '${GOV_VIEWER}';
      insert into public.user_recovery_codes (user_id, code_hash) values ('${GOV_VIEWER}', ${HASH});
      update public.user_recovery_codes set used_at = now(), used_ip = '127.0.0.1'
       where user_id = '${GOV_VIEWER}' and code_hash = ${HASH} and used_at is null;
      select 'USADOS:' || count(*) from public.user_recovery_codes
       where user_id = '${GOV_VIEWER}' and used_at is not null;
      rollback;`);
    expect(saida).toContain("USADOS:1");
  });
});
