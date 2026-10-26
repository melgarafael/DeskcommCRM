import { execFileSync } from "node:child_process";

import { beforeAll, describe, expect, it } from "vitest";

/**
 * AS APROVAÇÕES DA AGÊNCIA (migration 9009, docs/agencia/SPEC-aprovacoes.md) —
 * isolamento entre organizações e escrita só pelo servidor.
 *
 * Arquivo próprio, como `golden-candidates.test.ts`: a varredura
 * `rls-completude-varredura.test.ts` aponta para cá em `PROVA_PROPRIA`.
 * Conectar como `postgres` mediria nada (bypassa RLS): aqui é `set role
 * authenticated` + `request.jwt.claims`, o caminho da produção.
 */
const container = process.env.TEST_DB_CONTAINER;
if (!container) throw new Error("TEST_DB_CONTAINER not set — rode esta suíte via `pnpm test:db` (scripts/test-db.sh)");
const containerName: string = container;

function sql(script: string): string {
  return execFileSync("docker", ["exec", "-i", containerName, "psql", "-U", "postgres", "-d", "postgres", "-v", "ON_ERROR_STOP=1", "-tA", "-f", "-"], {
    input: script,
    encoding: "utf8",
  }).trim();
}
const ultimaLinha = (saida: string) => saida.split("\n").pop() ?? "";

function contarComo(usuario: string, consulta: string): number {
  const n = ultimaLinha(
    sql(`
      set role authenticated;
      select set_config('request.jwt.claims', '{"sub":"${usuario}"}', false);
      ${consulta}
    `),
  );
  if (!/^\d+$/.test(n)) throw new Error(`saída inesperada do psql: ${n}`);
  return Number(n);
}

const ORG_A = "90090009-0000-4000-8000-00000000000a";
const ORG_B = "90090009-0000-4000-8000-00000000000b";
const MEMBRO_A = "90090009-1111-4000-8000-00000000000a";
const MEMBRO_B = "90090009-1111-4000-8000-00000000000b";
const CLIENTE_A = "90090009-2222-4000-8000-00000000000a";
const CLIENTE_B = "90090009-2222-4000-8000-00000000000b";

beforeAll(() => {
  sql(`
    insert into auth.users (id, email) values
      ('${MEMBRO_A}', 'aprov-9009-a@invariant.test'),
      ('${MEMBRO_B}', 'aprov-9009-b@invariant.test')
      on conflict do nothing;
    insert into public.organizations (id, slug, legal_name, display_name) values
      ('${ORG_A}', 'aprov-9009-a', 'Aprovações A', 'Aprovações A'),
      ('${ORG_B}', 'aprov-9009-b', 'Aprovações B', 'Aprovações B')
      on conflict (id) do nothing;
    insert into public.user_organizations (user_id, organization_id, role, accepted_at) values
      ('${MEMBRO_A}', '${ORG_A}', 'agent', now()),
      ('${MEMBRO_B}', '${ORG_B}', 'agent', now())
      on conflict do nothing;
    insert into public.agencia_clientes (id, nome, organization_id) values
      ('${CLIENTE_A}', 'Cliente 9009 A', '${ORG_A}'),
      ('${CLIENTE_B}', 'Cliente 9009 B', '${ORG_B}')
      on conflict (id) do nothing;
    insert into public.agencia_aprovacoes (organization_id, cliente_id, tipo, titulo)
    select v.org, v.cli, 'video', 'Vídeo do mês'
      from (values ('${ORG_A}'::uuid, '${CLIENTE_A}'::uuid), ('${ORG_B}'::uuid, '${CLIENTE_B}'::uuid)) as v(org, cli)
     where not exists (select 1 from public.agencia_aprovacoes a where a.organization_id = v.org);
  `);
});

describe("agencia_aprovacoes — isolamento entre organizações", () => {
  it.each([
    ["A", MEMBRO_A, ORG_A, ORG_B],
    ["B", MEMBRO_B, ORG_B, ORG_A],
  ])("o membro de %s lê as da própria organização e ZERO das do vizinho", (_lado, usuario, propria, vizinha) => {
    expect(contarComo(usuario, `select count(*) from public.agencia_aprovacoes where organization_id = '${propria}';`)).toBeGreaterThan(0);
    expect(contarComo(usuario, `select count(*) from public.agencia_aprovacoes where organization_id = '${vizinha}';`)).toBe(0);
    expect(contarComo(usuario, "select count(*) from public.agencia_aprovacoes;")).toBe(
      contarComo(usuario, `select count(*) from public.agencia_aprovacoes where organization_id = '${propria}';`),
    );
  });

  it("a anon key não lê nada", () => {
    const saida = sql(`
      set role anon;
      do $$
      begin
        perform 1 from public.agencia_aprovacoes limit 1;
        raise exception 'anon leu';
      exception when insufficient_privilege then null;
      end
      $$;
      select 'recusado';
    `);
    expect(ultimaLinha(saida)).toBe("recusado");
  });

  it("ninguém com sessão escreve: aprovar é ato do servidor", () => {
    const tentativas = ["insert into public.agencia_aprovacoes (organization_id, cliente_id, tipo, titulo) values ('" + ORG_A + "', '" + CLIENTE_A + "', 'arte', 'forjada')", "update public.agencia_aprovacoes set situacao = 'aprovado' where organization_id = '" + ORG_A + "'", "delete from public.agencia_aprovacoes where organization_id = '" + ORG_A + "'"];
    for (const dml of tentativas) {
      const saida = sql(`
        set role authenticated;
        select set_config('request.jwt.claims', '{"sub":"${MEMBRO_A}"}', false);
        do $$
        begin
          ${dml};
          raise exception 'a sessão escreveu';
        exception when insufficient_privilege then null;
        end
        $$;
        select 'recusado';
      `);
      expect(ultimaLinha(saida)).toBe("recusado");
    }
    expect(Number(ultimaLinha(sql(`select count(*) from public.agencia_aprovacoes where organization_id = '${ORG_A}' and situacao = 'aprovado';`)))).toBe(0);
  });

  it("agencia_clientes (que tem organization_id só como ligação) não é lida nem pelo membro da organização ligada", () => {
    for (const usuario of [MEMBRO_A, MEMBRO_B]) {
      const saida = sql(`
        set role authenticated;
        select set_config('request.jwt.claims', '{"sub":"${usuario}"}', false);
        do $$
        begin
          perform 1 from public.agencia_clientes limit 1;
          raise exception 'a sessão leu agencia_clientes';
        exception when insufficient_privilege then null;
        end
        $$;
        select 'recusado';
      `);
      expect(ultimaLinha(saida)).toBe("recusado");
    }
  });

  it("tipo e situação fechados; link só https", () => {
    for (const valores of [`'festa', 'X', null`, `'video', 'X', 'http://inseguro.test'`]) {
      const saida = sql(`
        do $$
        begin
          insert into public.agencia_aprovacoes (organization_id, cliente_id, tipo, titulo, link) values ('${ORG_A}', '${CLIENTE_A}', ${valores});
          raise exception 'aceitou';
        exception when check_violation then null;
        end
        $$;
        select 'recusado';
      `);
      expect(ultimaLinha(saida)).toBe("recusado");
    }
  });
});
