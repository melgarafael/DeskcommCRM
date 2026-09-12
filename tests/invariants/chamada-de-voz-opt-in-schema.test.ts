/**
 * O SCHEMA DO OPT-IN DE CHAMADA DE VOZ — catálogo, e só catálogo.
 *
 * ⚠️ ESTA CONEXÃO É `postgres` (`rolbypassrls = t`), então NADA aqui exercita
 * policy em vigor. Quem prova comportamento é
 * `chamada-de-voz-opt-in-rbac.test.ts`, que roda como `authenticated` com o JWT
 * de cada papel. O que este arquivo cobre é regressão grosseira e barata:
 * alguém apagou a tabela, desligou a RLS, ou devolveu a tabela à `anon`.
 *
 * O caso da `anon` é o que justifica o arquivo existir. `baseline.sql` tem
 * `ALTER DEFAULT PRIVILEGES ... GRANT ALL ON TABLES TO anon, authenticated`, e
 * isso vale para toda tabela criada depois dele. A anon key vai para o browser
 * de qualquer visitante — sem o `revoke`, a decisão de risco da organização
 * ficaria alcançável sem sessão nenhuma. Não é hipótese: foi medido em
 * `org_guardrail_layers` e virou a migration 0143.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";

const container = process.env.TEST_DB_CONTAINER;
if (!container) {
  throw new Error("TEST_DB_CONTAINER not set — rode via `pnpm test:db` (scripts/test-db.sh)");
}

const PORT = Number(process.env.TEST_DB_PORT ?? 54329);
const pool = new pg.Pool({
  connectionString: `postgresql://postgres:postgres@127.0.0.1:${PORT}/postgres`,
  max: 2,
});

const ORG = "0be7a70c-0000-4000-8000-000000000031";

beforeAll(async () => {
  await pool.query(
    `insert into organizations (id, slug, legal_name, display_name)
     values ($1, 'org-voz-schema', 'Org Voz', 'Org Voz') on conflict (id) do nothing`,
    [ORG],
  );
  // Controle positivo: no banco errado a fixture não chega e os casos abaixo
  // mediriam nada.
  const { rows } = await pool.query<{ n: string }>(
    `select count(*)::text as n from organizations where id = $1`,
    [ORG],
  );
  if (rows[0]?.n !== "1") throw new Error(`fixture não chegou ao banco da porta ${PORT}`);
});

afterAll(async () => {
  await pool.query(`delete from organizations where id = $1`, [ORG]);
  await pool.end();
});

describe("schema do opt-in de chamada de voz", () => {
  it("a chave é a própria organização — uma decisão por organização, não uma lista", async () => {
    const { rows } = await pool.query<{ cols: string }>(
      `select string_agg(a.attname, ',' order by a.attnum) as cols
         from pg_constraint c
         join unnest(c.conkey) k(attnum) on true
         join pg_attribute a on a.attrelid = c.conrelid and a.attnum = k.attnum
        where c.conrelid = 'public.org_voice_calls'::regclass and c.contype = 'p'`,
    );
    expect(rows[0]?.cols).toBe("organization_id");
  });

  it("a RLS está ligada e as duas policies existem", async () => {
    const { rows: rls } = await pool.query<{ relrowsecurity: boolean }>(
      `select relrowsecurity from pg_class where oid = 'public.org_voice_calls'::regclass`,
    );
    expect(rls[0]?.relrowsecurity, "RLS desligada em org_voice_calls").toBe(true);

    const { rows: pol } = await pool.query<{ policyname: string }>(
      `select policyname from pg_policies
        where schemaname = 'public' and tablename = 'org_voice_calls' order by policyname`,
    );
    const nomes = pol.map((p) => p.policyname);

    // CONTÉM, e não IGUAL — e a diferença foi medida, não suposta. A primeira
    // versão deste caso exigia exatamente estas duas e reprovou porque a tabela
    // tinha CINCO: o baseline varre as tabelas tenant-aware e planta
    // `support_write_{insert,update,delete}` em cada uma
    // (`fn_support_write_allowed`, o bloqueio de escrita durante impersonação).
    //
    // Isso é BOA notícia — a proteção alcançou a tabela nova sozinha, e o
    // `requireSupportWrite()` da rota deixa de ser a única linha de defesa —,
    // mas transforma "só estas duas" numa asserção que reprova o correto. O que
    // este caso guarda é a PRESENÇA das minhas duas.
    expect(nomes).toContain("org_voice_calls_select");
    expect(nomes).toContain("org_voice_calls_admin_write");

    // Guarda do instrumento: a consulta precisa ter enxergado a tabela.
    expect(nomes.length, "pg_policies não devolveu policy nenhuma").toBeGreaterThanOrEqual(2);
  });

  it("a `anon` não tem privilégio nenhum sobre a tabela", async () => {
    // A razão de este arquivo existir. Sem o `revoke`, o ALTER DEFAULT
    // PRIVILEGES do baseline deixa a tabela concedida à chave que vai para o
    // browser de qualquer visitante.
    const { rows } = await pool.query<{ privilege_type: string }>(
      `select privilege_type from information_schema.role_table_grants
        where table_schema = 'public' and table_name = 'org_voice_calls' and grantee = 'anon'`,
    );
    expect(
      rows.map((r) => r.privilege_type),
      "org_voice_calls voltou a nascer concedida à anon — é o defeito da 0142 de novo",
    ).toEqual([]);
  });

  it("uma linha inserida sem dizer nada nasce DESLIGADA", async () => {
    // A condição do dono, medida no banco e não no TypeScript: ninguém ganha a
    // capacidade por acidente de default.
    await pool.query(`delete from public.org_voice_calls where organization_id = $1`, [ORG]);
    await pool.query(`insert into public.org_voice_calls (organization_id) values ($1)`, [ORG]);
    const { rows } = await pool.query<{ enabled: boolean }>(
      `select enabled from public.org_voice_calls where organization_id = $1`,
      [ORG],
    );
    expect(rows[0]?.enabled).toBe(false);
    await pool.query(`delete from public.org_voice_calls where organization_id = $1`, [ORG]);
  });

  it("apagar a organização leva a decisão junto", async () => {
    // `on delete cascade`: uma linha órfã de opt-in é uma autorização sem dono.
    const { rows } = await pool.query<{ confdeltype: string }>(
      `select confdeltype from pg_constraint
        where conrelid = 'public.org_voice_calls'::regclass and contype = 'f'
          and confrelid = 'public.organizations'::regclass`,
    );
    expect(rows[0]?.confdeltype, "a FK para organizations não é cascade").toBe("c");
  });
});
