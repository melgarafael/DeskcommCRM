import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Pool } from "pg";

// O schema do token do módulo `connected` (spec 33, F2, migration 9117). O token do módulo é uma linha
// de `api_tokens` cujo dono é a INSTALAÇÃO, não uma pessoa: `created_by` aceita nulo, mas a CHECK
// `api_tokens_dono_check` não deixa nascer token sem nenhum dono, e o índice único parcial garante um
// token vivo por (organização, instalação). O segredo da instalação e os nonces vivem em tabelas só de
// servidor: RLS ligada, nenhuma policy, nenhum privilégio para anon/authenticated.
if (!process.env.TEST_DB_PORT) throw new Error("TEST_DB_PORT ausente — execute pnpm test:db");
const pool = new Pool({
  connectionString: `postgresql://postgres:postgres@127.0.0.1:${process.env.TEST_DB_PORT}/postgres`,
  max: 4,
});
const query = (text: string, values: unknown[] = []) => pool.query(text, values);
const hash = (v: unknown) => createHash("sha256").update(JSON.stringify(v)).digest("hex");

const dono = "c0ae0000-0000-4000-8000-000000000003";
const instalador = "c0ae0000-0000-4000-8000-000000000004";
const orgA = "c0ae0000-0000-4000-8000-0000000000a3";
const orgB = "c0ae0000-0000-4000-8000-0000000000b3";
const SERVICO = "https://servico.tokenmodulo.test";
let seq = 0;
const origem = () => `https://tokenmodulo-${++seq}.invariant.test`;

const display = {
  title: { "pt-BR": "Serviço externo" },
  summary: { "pt-BR": "Lê contatos do CRM" },
  category: "productivity",
  icon: "ListChecks",
};

/** Um manifesto `connected` mínimo e válido (mesmo molde de `extensoes-interruptor.test.ts`). */
function conectado() {
  return {
    format_version: 1,
    profile: "connected",
    publisher: "tokenmodulo",
    name: "servico-externo",
    version: "1.0.0",
    license: "MIT",
    host_api: { min: 2, max: 2 },
    permissions: ["area.contatos.leitura"],
    dependencies: [],
    data: { mode: "none" },
    display,
    configuration: {},
    contributions: {},
  };
}

function entrada(m: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  const doc = JSON.stringify(m);
  return {
    publisher: m.publisher,
    name: m.name,
    version: m.version,
    license: m.license,
    host_api: m.host_api,
    display: m.display,
    permissions: m.permissions,
    sha256: hash(m),
    byte_length: Buffer.byteLength(doc),
    ...extra,
  };
}

/** Chama uma RPC `fn_extensions_*` como `service_role`, que é quem tem o grant. */
async function rpc(nome: string, args: unknown[]) {
  const c = await pool.connect();
  try {
    await c.query("begin");
    await c.query("set local role service_role");
    await c.query("select set_config('request.jwt.claims', $1, true)", [
      JSON.stringify({ sub: dono, role: "service_role" }),
    ]);
    const r = await c.query(
      `select public.fn_extensions_${nome}(${args.map((_, i) => `$${i + 1}`).join(",")}) resultado`,
      args,
    );
    await c.query("commit");
    return r.rows[0].resultado;
  } catch (e) {
    await c.query("rollback");
    throw e;
  } finally {
    c.release();
  }
}

const admitir = (entradas: unknown[], url = origem()) => {
  const snapshot = { format_version: 1, origin: url, revision: 1, entries: entradas };
  return rpc("admit_catalog", [dono, randomUUID(), JSON.stringify(snapshot), hash(snapshot)]);
};

/** O caminho inteiro da instalação de um módulo `connected`; devolve o id da instalação. */
async function instalarConectado(): Promise<string> {
  const m = conectado();
  const e = entrada(m, { service_origin: SERVICO });
  const catalogo = (await admitir([e])).catalog_id as string;
  const preparo = await rpc("prepare_install", [dono, randomUUID(), catalogo, e.publisher, e.name, e.version, null]);
  const recibo = await rpc("finish_install", [
    dono, preparo.id, JSON.stringify(m), e.sha256, e.byte_length, JSON.stringify(m),
  ]);
  return recibo.installation_id as string;
}

/** Insere um token como o dono do banco (superusuário). `hashHex` único por chamada. */
async function inserirToken(o: {
  org: string;
  criadoPor?: string | null;
  instalacao?: string | null;
  slug?: string | null;
  revogado?: boolean;
}) {
  const sufixo = randomUUID().replace(/-/g, "").slice(0, 8);
  return query(
    `insert into public.api_tokens
       (organization_id, created_by, extension_installation_id, module_slug, name, prefix, token_hash, scopes, revoked_at)
     values ($1, $2, $3, $4, 'Módulo teste', $5, decode(md5(random()::text), 'hex'), '["mcp:read"]'::jsonb,
             case when $6::boolean then now() else null end)
     returning id`,
    [o.org, o.criadoPor ?? null, o.instalacao ?? null, o.slug ?? null, sufixo, o.revogado ?? false],
  );
}

/** Roda `sql` sob um papel de API, dentro de uma transação que sempre volta. */
async function como(papel: "anon" | "authenticated" | "service_role", sql: string, values: unknown[] = []) {
  const c = await pool.connect();
  try {
    await c.query("begin");
    await c.query(`set local role ${papel}`);
    await c.query("select set_config('request.jwt.claims', $1, true)", [
      JSON.stringify({ sub: instalador, role: papel }),
    ]);
    return await c.query(sql, values);
  } finally {
    await c.query("rollback").catch(() => undefined);
    c.release();
  }
}

async function codigoDoErro(p: Promise<unknown>): Promise<{ code?: string; constraint?: string }> {
  try {
    await p;
  } catch (e) {
    const err = e as { code?: string; constraint?: string };
    return { code: err.code, constraint: err.constraint };
  }
  return {};
}

async function limpar() {
  await query("delete from public.api_tokens where organization_id in ($1, $2)", [orgA, orgB]);
  await query("delete from public.extension_operations where actor_id = $1", [dono]);
  await query("delete from public.extension_installations where publisher = 'tokenmodulo'");
  await query("delete from public.extension_catalogs where origin like 'https://tokenmodulo-%.invariant.test'");
  await query("delete from public.extension_artifacts where manifest->>'publisher' = 'tokenmodulo'");
}

beforeAll(async () => {
  for (const id of [dono, instalador]) {
    await query("insert into auth.users(id, email) values ($1, $2) on conflict(id) do nothing", [
      id,
      `${id}@invariant.test`,
    ]);
  }
  await query(
    `insert into platform_admins(user_id, granted_by, scope, mfa_required, reason)
     values ($1, $1, 'full', false, 'Teste do token do módulo conectado')
     on conflict(user_id) do update set revoked_at = null, scope = 'full'`,
    [dono],
  );
  for (const [id, slug] of [[orgA, "tokenmodulo-a"], [orgB, "tokenmodulo-b"]]) {
    await query(
      "insert into organizations(id,slug,legal_name,display_name) values($1,$2,'Token do módulo','Token do módulo') on conflict(id) do nothing",
      [id, slug],
    );
  }
});
beforeEach(limpar);
afterAll(async () => {
  await limpar();
  await query("delete from public.organizations where id in ($1, $2)", [orgA, orgB]);
  await query("delete from auth.users where id = $1", [instalador]);
  await pool.end();
});

describe("token do módulo: a CHECK de dono", () => {
  it("recusa token sem pessoa e sem instalação", async () => {
    const erro = await codigoDoErro(inserirToken({ org: orgA, criadoPor: null, instalacao: null }));
    expect(erro).toEqual({ code: "23514", constraint: "api_tokens_dono_check" });
  });

  it("aceita token de pessoa (created_by) e token de módulo (instalação, created_by nulo)", async () => {
    const id = await instalarConectado();
    await expect(inserirToken({ org: orgA, criadoPor: dono })).resolves.toBeDefined();
    const modulo = await inserirToken({ org: orgA, criadoPor: null, instalacao: id, slug: "tokenmodulo/servico-externo" });
    const linha = await query(
      "select created_by, extension_installation_id, module_slug from public.api_tokens where id = $1",
      [modulo.rows[0].id],
    );
    expect(linha.rows[0]).toEqual({
      created_by: null,
      extension_installation_id: id,
      module_slug: "tokenmodulo/servico-externo",
    });
  });

  it("a FK da instalação recusa instalação que não existe", async () => {
    const erro = await codigoDoErro(inserirToken({ org: orgA, instalacao: randomUUID() }));
    expect(erro.code).toBe("23503");
  });
});

describe("token do módulo: um vivo por organização e instalação", () => {
  it("o segundo token vivo do mesmo par é recusado pelo índice único", async () => {
    const id = await instalarConectado();
    await inserirToken({ org: orgA, instalacao: id });

    const erro = await codigoDoErro(inserirToken({ org: orgA, instalacao: id }));

    expect(erro).toEqual({ code: "23505", constraint: "api_tokens_modulo_vivo_idx" });
  });

  it("revogado libera o par; outra organização com a mesma instalação não conflita", async () => {
    const id = await instalarConectado();
    await inserirToken({ org: orgA, instalacao: id });
    // Outra organização, mesma instalação: par diferente.
    await expect(inserirToken({ org: orgB, instalacao: id })).resolves.toBeDefined();

    await query(
      "update public.api_tokens set revoked_at = now() where organization_id = $1 and extension_installation_id = $2",
      [orgA, id],
    );
    await expect(inserirToken({ org: orgA, instalacao: id })).resolves.toBeDefined();

    const vivos = await query(
      "select count(*)::int n from public.api_tokens where organization_id = $1 and extension_installation_id = $2 and revoked_at is null",
      [orgA, id],
    );
    expect(vivos.rows[0].n).toBe(1);
  });

  it("token de pessoa não entra na conta do índice (vários vivos convivem)", async () => {
    await inserirToken({ org: orgA, criadoPor: dono });
    await expect(inserirToken({ org: orgA, criadoPor: dono })).resolves.toBeDefined();
  });
});

describe("token do módulo: apagar quem instalou não apaga o módulo", () => {
  it("o token e o segredo continuam; rotated_by e installed_by viram nulos", async () => {
    const id = await instalarConectado();
    await query("update public.extension_installations set installed_by = $2 where id = $1", [id, instalador]);
    await query(
      "insert into public.extension_installation_secrets(installation_id, ciphertext, rotated_by) values ($1, 'cifrado', $2)",
      [id, instalador],
    );
    const token = await inserirToken({ org: orgA, criadoPor: null, instalacao: id, slug: "tokenmodulo/servico-externo" });

    await query("delete from auth.users where id = $1", [instalador]);

    const t = await query("select revoked_at from public.api_tokens where id = $1", [token.rows[0].id]);
    expect(t.rows).toHaveLength(1);
    expect(t.rows[0].revoked_at).toBeNull();
    const s = await query(
      "select ciphertext, rotated_by from public.extension_installation_secrets where installation_id = $1",
      [id],
    );
    expect(s.rows[0]).toEqual({ ciphertext: "cifrado", rotated_by: null });
    const i = await query("select installed_by from public.extension_installations where id = $1", [id]);
    expect(i.rows[0].installed_by).toBeNull();

    // Devolve o usuário para os testes seguintes.
    await query("insert into auth.users(id, email) values ($1, $2) on conflict(id) do nothing", [
      instalador,
      `${instalador}@invariant.test`,
    ]);
  });
});

describe("segredo e nonce: tabelas só de servidor", () => {
  const TABELAS = ["extension_installation_secrets", "extension_token_nonces"];

  it.each(TABELAS)("%s tem RLS ligada e nenhuma policy", async (tabela) => {
    const rls = await query(
      "select relrowsecurity from pg_class where oid = ('public.' || $1)::regclass",
      [tabela],
    );
    expect(rls.rows[0].relrowsecurity).toBe(true);
    const policies = await query(
      "select count(*)::int n from pg_policies where schemaname = 'public' and tablename = $1",
      [tabela],
    );
    expect(policies.rows[0].n).toBe(0);
  });

  it.each(TABELAS)("%s não é legível nem gravável por anon e authenticated", async (tabela) => {
    for (const papel of ["authenticated", "anon"] as const) {
      const leitura = await codigoDoErro(como(papel, `select * from public.${tabela}`));
      expect(leitura.code, `${papel} leu ${tabela}`).toBe("42501");
      const escrita = await codigoDoErro(como(papel, `delete from public.${tabela}`));
      expect(escrita.code, `${papel} apagou em ${tabela}`).toBe("42501");
    }
  });

  it("service_role lê e grava nas duas (controle positivo)", async () => {
    const id = await instalarConectado();
    const r = await como(
      "service_role",
      `with s as (insert into public.extension_installation_secrets(installation_id, ciphertext) values ($1, 'x') returning 1),
            n as (insert into public.extension_token_nonces(installation_id, nonce) values ($1, 'n1') returning 1)
       select (select count(*) from s)::int segredos, (select count(*) from n)::int nonces`,
      [id],
    );
    expect(r.rows[0]).toEqual({ segredos: 1, nonces: 1 });
  });

  it("o nonce repetido da mesma instalação é recusado; o mesmo nonce em outra instalação passa", async () => {
    const a = await instalarConectado();
    // Segunda instalação: outro nome, para não colidir em (catalog, publisher, name).
    const m = { ...conectado(), name: "servico-externo-b" };
    const e = entrada(m, { service_origin: SERVICO });
    const catalogo = (await admitir([e])).catalog_id as string;
    const preparo = await rpc("prepare_install", [dono, randomUUID(), catalogo, e.publisher, e.name, e.version, null]);
    const b = (
      await rpc("finish_install", [dono, preparo.id, JSON.stringify(m), e.sha256, e.byte_length, JSON.stringify(m)])
    ).installation_id as string;

    await query("insert into public.extension_token_nonces(installation_id, nonce) values ($1, 'mesmo')", [a]);
    const repetido = await codigoDoErro(
      query("insert into public.extension_token_nonces(installation_id, nonce) values ($1, 'mesmo')", [a]),
    );
    expect(repetido.code).toBe("23505");
    await expect(
      query("insert into public.extension_token_nonces(installation_id, nonce) values ($1, 'mesmo')", [b]),
    ).resolves.toBeDefined();
  });
});
