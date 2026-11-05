import { createHash, randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Pool } from "pg";

// As funções do token do módulo `connected` (spec 33, F2, migration 9118). A ATIVAÇÃO reserva uma vaga viva
// em `api_tokens` (dono: a instalação), a BUSCA troca o hash dessa vaga, e desativar, remover e desligar
// revogam. Só o perfil `connected` tem token. O teto de 50 tokens ativos por organização vale na ativação:
// a vaga conta, e teto cheio desfaz a ativação inteira (nada pela metade).
if (!process.env.TEST_DB_PORT) throw new Error("TEST_DB_PORT ausente — execute pnpm test:db");
const pool = new Pool({
  connectionString: `postgresql://postgres:postgres@127.0.0.1:${process.env.TEST_DB_PORT}/postgres`,
  max: 6,
});
const query = (text: string, values: unknown[] = []) => pool.query(text, values);
const hash = (v: unknown) => createHash("sha256").update(JSON.stringify(v)).digest("hex");

const dono = "c0ae0000-0000-4000-8000-000000000005";
const orgA = "c0ae0000-0000-4000-8000-0000000000a5";
const orgB = "c0ae0000-0000-4000-8000-0000000000b5";
const SERVICO = "https://servico.tokenfuncoes.test";
const SLUG = "tokenfuncoes/servico-externo";
const CONFIG = { density: "comfortable", show_description: true };
let seq = 0;
const origem = () => `https://tokenfuncoes-${++seq}.invariant.test`;

const display = {
  title: { "pt-BR": "Serviço externo" },
  summary: { "pt-BR": "Lê contatos do CRM" },
  category: "productivity",
  icon: "ListChecks",
};

function conectado(name = "servico-externo") {
  return {
    format_version: 1,
    profile: "connected",
    publisher: "tokenfuncoes",
    name,
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

function declarativo() {
  return {
    format_version: 1,
    profile: "declarative",
    publisher: "tokenfuncoes",
    name: "guia-simples",
    version: "1.0.0",
    license: "MIT",
    host_api: { min: 2, max: 2 },
    permissions: ["navigation.tasks"],
    dependencies: [],
    data: { mode: "none" },
    display,
    configuration: { density: "comfortable", show_description: true },
    contributions: {
      crm_cards: [
        {
          id: "primeira-tarefa",
          title: { "pt-BR": "Começar" },
          description: { "pt-BR": "Passo inicial" },
          icon: "ListChecks",
          blocks: [{ heading: { "pt-BR": "Ação" }, body: { "pt-BR": "Crie sua tarefa" } }],
          action: { label: { "pt-BR": "Abrir tarefas" }, capability: "tasks.open" },
        },
      ],
    },
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

async function instalar(m: Record<string, unknown>, extra: Record<string, unknown> = {}): Promise<string> {
  const e = entrada(m, extra);
  const catalogo = (await admitir([e])).catalog_id as string;
  const preparo = await rpc("prepare_install", [dono, randomUUID(), catalogo, e.publisher, e.name, e.version, null]);
  const recibo = await rpc("finish_install", [
    dono, preparo.id, JSON.stringify(m), e.sha256, e.byte_length, JSON.stringify(m),
  ]);
  return recibo.installation_id as string;
}

const instalarConectado = (name = "servico-externo") => instalar(conectado(name), { service_origin: SERVICO });

const revisaoDoVinculo = async (org: string, inst: string) =>
  ((await query("select revision from public.organization_extensions where organization_id = $1 and installation_id = $2", [org, inst]))
    .rows[0]?.revision ?? 0) as number;

/** Ativa (ou desativa) a instalação na organização, com a revisão do vínculo que o banco tem agora. */
async function configurar(org: string, inst: string, ativo: boolean) {
  return rpc("configure", [dono, org, inst, randomUUID(), await revisaoDoVinculo(org, inst), ativo, JSON.stringify(CONFIG)]);
}
const ativar = (org: string, inst: string) => configurar(org, inst, true);
const desativar = (org: string, inst: string) => configurar(org, inst, false);

const rotacionar = (org: string, inst: string, prefixo = prefixoNovo(), digest = randomBytes(32), expira = daqui(3600)) =>
  rpc("module_token_rotate", [org, inst, prefixo, digest, expira]);
const prefixoNovo = () => `dsk_${randomBytes(4).toString("hex")}`;
const daqui = (segundos: number) => new Date(Date.now() + segundos * 1000).toISOString();

type Linha = {
  id: string;
  organization_id: string;
  created_by: string | null;
  module_slug: string | null;
  name: string;
  prefix: string;
  token_hash: Buffer;
  scopes: string[];
  expires_at: Date;
  revoked_at: Date | null;
  revoked_by: string | null;
};
const tokensDoModulo = async (inst: string, org?: string) =>
  (
    await query(
      `select id, organization_id, created_by, module_slug, name, prefix, token_hash, scopes, expires_at, revoked_at, revoked_by
         from public.api_tokens
        where extension_installation_id = $1 and ($2::uuid is null or organization_id = $2)
        order by created_at, id`,
      [inst, org ?? null],
    )
  ).rows as Linha[];
const vivos = async (inst: string, org?: string) => (await tokensDoModulo(inst, org)).filter((t) => !t.revoked_at);
const vinculo = async (org: string, inst: string) =>
  (await query("select enabled, revision from public.organization_extensions where organization_id = $1 and installation_id = $2", [org, inst]))
    .rows[0] as { enabled: boolean; revision: number } | undefined;

/** Enche a organização com `n` tokens de pessoa vivos (sem expiração). */
async function encher(org: string, n: number) {
  for (let i = 0; i < n; i++) {
    await query(
      `insert into public.api_tokens(organization_id, created_by, name, prefix, token_hash, scopes)
       values ($1, $2, 'Token de pessoa', $3, decode(md5(random()::text), 'hex'), '["mcp:read"]'::jsonb)`,
      [org, dono, `dsk_${randomUUID().replace(/-/g, "").slice(0, 8)}`],
    );
  }
}

async function como(papel: "anon" | "authenticated", sql: string, values: unknown[] = []) {
  const c = await pool.connect();
  try {
    await c.query("begin");
    await c.query(`set local role ${papel}`);
    await c.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: dono, role: papel })]);
    return await c.query(sql, values);
  } finally {
    await c.query("rollback").catch(() => undefined);
    c.release();
  }
}

async function codigoDoErro(p: Promise<unknown>): Promise<{ code?: string; message?: string }> {
  try {
    await p;
  } catch (e) {
    const err = e as { code?: string; message?: string };
    return { code: err.code, message: err.message };
  }
  return {};
}

async function limpar() {
  await query("delete from public.api_tokens where organization_id in ($1, $2)", [orgA, orgB]);
  await query("delete from public.organization_extensions where organization_id in ($1, $2)", [orgA, orgB]);
  await query("delete from public.extension_operations where actor_id = $1", [dono]);
  await query("delete from public.extension_installations where publisher = 'tokenfuncoes'");
  await query("delete from public.extension_catalogs where origin like 'https://tokenfuncoes-%.invariant.test'");
  await query("delete from public.extension_artifacts where manifest->>'publisher' = 'tokenfuncoes'");
}

beforeAll(async () => {
  await query("insert into auth.users(id, email) values ($1, $2) on conflict(id) do nothing", [dono, `${dono}@invariant.test`]);
  await query(
    `insert into platform_admins(user_id, granted_by, scope, mfa_required, reason)
     values ($1, $1, 'full', false, 'Teste das funções do token do módulo conectado')
     on conflict(user_id) do update set revoked_at = null, scope = 'full'`,
    [dono],
  );
  for (const [id, slug] of [[orgA, "tokenfuncoes-a"], [orgB, "tokenfuncoes-b"]]) {
    await query(
      "insert into organizations(id,slug,legal_name,display_name) values($1,$2,'Funções do token','Funções do token') on conflict(id) do nothing",
      [id, slug],
    );
    await query(
      `insert into user_organizations(user_id, organization_id, role, accepted_at) values ($1, $2, 'admin', now())
       on conflict(user_id, organization_id) do update set role = 'admin', accepted_at = now(), revoked_at = null`,
      [dono, id],
    );
  }
});
beforeEach(limpar);
afterAll(async () => {
  await limpar();
  await query("delete from public.organizations where id in ($1, $2)", [orgA, orgB]);
  await pool.end();
});

describe("ativar: a vaga do token", () => {
  it("ativar um módulo connected cria UMA vaga viva, com o escopo e o dono certos", async () => {
    const inst = await instalarConectado();

    await ativar(orgA, inst);

    const tokens = await tokensDoModulo(inst);
    expect(tokens).toHaveLength(1);
    const t = tokens[0]!;
    expect(t.organization_id).toBe(orgA);
    expect(t.created_by).toBeNull();
    expect(t.module_slug).toBe(SLUG);
    expect(t.name).toBe(`Módulo ${SLUG}`);
    expect(t.prefix).toMatch(/^dsk_[0-9a-f]{8}$/);
    expect(t.token_hash).toHaveLength(32);
    expect(t.revoked_at).toBeNull();
    expect(t.scopes).toEqual(["mcp:read", "role:viewer", `actor:module:${SLUG}`]);
    // Validade longa: o gatilho do teto só conta token que NÃO expirou.
    expect(t.expires_at.getTime()).toBeGreaterThan(Date.now() + 99 * 365 * 24 * 3600 * 1000);
  });

  it("ativar de novo (outra configuração) não cria segunda vaga", async () => {
    const inst = await instalarConectado();
    await ativar(orgA, inst);
    const primeira = (await vivos(inst, orgA))[0]!;

    await ativar(orgA, inst);

    const depois = await vivos(inst, orgA);
    expect(depois).toHaveLength(1);
    expect(depois[0]!.id).toBe(primeira.id);
  });

  it("as vagas são por organização: ativar na A não cria token na B", async () => {
    const inst = await instalarConectado();
    await ativar(orgA, inst);

    expect(await tokensDoModulo(inst, orgB)).toHaveLength(0);

    await ativar(orgB, inst);
    const a = await vivos(inst, orgA);
    const b = await vivos(inst, orgB);
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);
    expect(a[0]!.id).not.toBe(b[0]!.id);
    expect(a[0]!.prefix).not.toBe(b[0]!.prefix);
  });

  it("ativar um módulo declarative NÃO cria token", async () => {
    const inst = await instalar(declarativo());

    await ativar(orgA, inst);

    expect((await vinculo(orgA, inst))?.enabled).toBe(true);
    expect(await tokensDoModulo(inst)).toHaveLength(0);
    const total = await query("select count(*)::int n from public.api_tokens where organization_id = $1", [orgA]);
    expect(total.rows[0].n).toBe(0);
  });

  it("a vaga conta no teto de 50: com 49 pessoas, a ativação passa e o 51º token é recusado", async () => {
    const inst = await instalarConectado();
    await encher(orgA, 49);

    await ativar(orgA, inst);

    expect(await vivos(inst, orgA)).toHaveLength(1);
    const erro = await codigoDoErro(encher(orgA, 1));
    expect(erro.code).toBe("PT409");
  });

  it("teto cheio (50 tokens ativos): ativar falha e organization_extensions não muda", async () => {
    const inst = await instalarConectado();
    await encher(orgA, 50);

    const erro = await codigoDoErro(ativar(orgA, inst));

    expect(erro.code).toBe("PT409");
    expect(await vinculo(orgA, inst)).toBeUndefined();
    expect(await tokensDoModulo(inst)).toHaveLength(0);
    const recibos = await query(
      "select count(*)::int n from public.extension_operations where kind = 'configure' and installation_id = $1",
      [inst],
    );
    expect(recibos.rows[0].n).toBe(0);
  });

  it("teto cheio com a ativação já existente e desativada: reativar falha e o vínculo continua desativado", async () => {
    const inst = await instalarConectado();
    await ativar(orgA, inst);
    await desativar(orgA, inst);
    const antes = await vinculo(orgA, inst);
    await encher(orgA, 50);

    const erro = await codigoDoErro(ativar(orgA, inst));

    expect(erro.code).toBe("PT409");
    expect(await vinculo(orgA, inst)).toEqual(antes);
    expect(await vivos(inst, orgA)).toHaveLength(0);
  });
});

describe("desativar, remover e desligar revogam", () => {
  it("desativar na organização revoga só o token daquela organização", async () => {
    const inst = await instalarConectado();
    await ativar(orgA, inst);
    await ativar(orgB, inst);

    await desativar(orgA, inst);

    expect(await vivos(inst, orgA)).toHaveLength(0);
    expect(await vivos(inst, orgB)).toHaveLength(1);
    const revogado = (await tokensDoModulo(inst, orgA))[0]!;
    expect(revogado.revoked_at).not.toBeNull();
    expect(revogado.revoked_by).toBe(dono);
  });

  it("ativar depois de desativar cria uma vaga nova (a antiga continua revogada)", async () => {
    const inst = await instalarConectado();
    await ativar(orgA, inst);
    await desativar(orgA, inst);

    await ativar(orgA, inst);

    const todos = await tokensDoModulo(inst, orgA);
    expect(todos).toHaveLength(2);
    expect(todos.filter((t) => !t.revoked_at)).toHaveLength(1);
  });

  it("remover a instalação revoga os tokens de TODAS as organizações", async () => {
    const inst = await instalarConectado();
    await ativar(orgA, inst);
    await ativar(orgB, inst);
    expect(await vivos(inst)).toHaveLength(2);

    const recibo = await rpc("remove_installation", [dono, randomUUID(), inst, 1]);

    expect(recibo).toMatchObject({ kind: "removal", applied_now: true });
    expect(await vivos(inst)).toHaveLength(0);
    expect((await tokensDoModulo(inst)).every((t) => t.revoked_by === dono)).toBe(true);
    // A instalação não é apagada: só marcada.
    const i = await query("select removed_at from public.extension_installations where id = $1", [inst]);
    expect(i.rows[0].removed_at).not.toBeNull();
  });

  it("desligar o módulo revoga os tokens de TODAS as organizações; ligar de novo não cria token", async () => {
    const inst = await instalarConectado();
    await ativar(orgA, inst);
    await ativar(orgB, inst);

    const recibo = await rpc("set_switch", [dono, randomUUID(), inst, true, 1]);

    expect(recibo).toMatchObject({ kind: "switch", applied_now: true });
    expect(await vivos(inst)).toHaveLength(0);

    await rpc("set_switch", [dono, randomUUID(), inst, false, 2]);
    expect(await vivos(inst)).toHaveLength(0);
  });

  it("revogar não mexe em token de pessoa nem em token de outro módulo", async () => {
    const a = await instalarConectado("servico-a");
    const b = await instalarConectado("servico-b");
    await ativar(orgA, a);
    await ativar(orgA, b);
    await encher(orgA, 1);

    await rpc("set_switch", [dono, randomUUID(), a, true, 1]);

    expect(await vivos(a)).toHaveLength(0);
    expect(await vivos(b)).toHaveLength(1);
    const pessoas = await query(
      "select count(*)::int n from public.api_tokens where organization_id = $1 and created_by = $2 and revoked_at is null",
      [orgA, dono],
    );
    expect(pessoas.rows[0].n).toBe(1);
  });

  it("revoke direto é idempotente: sem erro se já revogado ou se nunca existiu", async () => {
    const inst = await instalarConectado();
    await ativar(orgA, inst);

    await rpc("module_token_revoke", [orgA, inst, dono]);
    await expect(rpc("module_token_revoke", [orgA, inst, dono])).resolves.toBeDefined();
    await expect(rpc("module_token_revoke", [orgB, inst, dono])).resolves.toBeDefined();
    expect(await vivos(inst)).toHaveLength(0);
  });
});

describe("rotate: a busca troca o hash da vaga", () => {
  it("troca prefixo, hash e validade da MESMA linha e deixa um token vivo", async () => {
    const inst = await instalarConectado();
    await ativar(orgA, inst);
    const vaga = (await vivos(inst, orgA))[0]!;
    const prefixo = prefixoNovo();
    const digest = randomBytes(32);

    const id = await rotacionar(orgA, inst, prefixo, digest, daqui(3600));

    expect(id).toBe(vaga.id);
    const vivo = await vivos(inst, orgA);
    expect(vivo).toHaveLength(1);
    expect(vivo[0]!.prefix).toBe(prefixo);
    expect(Buffer.compare(vivo[0]!.token_hash, digest)).toBe(0);
    expect(vivo[0]!.expires_at.getTime()).toBeLessThan(Date.now() + 2 * 3600 * 1000);
    expect(vivo[0]!.scopes).toEqual(["mcp:read", "role:viewer", `actor:module:${SLUG}`]);
  });

  it("ativação desativada: PT409 e o hash não muda", async () => {
    const inst = await instalarConectado();
    await ativar(orgA, inst);
    await desativar(orgA, inst);
    const antes = (await tokensDoModulo(inst, orgA))[0]!;

    const erro = await codigoDoErro(rotacionar(orgA, inst));

    expect(erro.code).toBe("PT409");
    const depois = (await tokensDoModulo(inst, orgA))[0]!;
    expect(Buffer.compare(depois.token_hash, antes.token_hash)).toBe(0);
    expect(depois.prefix).toBe(antes.prefix);
    expect(depois.revoked_at).not.toBeNull();
  });

  it("instalação com disabled_at (token ainda vivo): PT409 e o hash não muda", async () => {
    const inst = await instalarConectado();
    await ativar(orgA, inst);
    const antes = (await vivos(inst, orgA))[0]!;
    await query("update public.extension_installations set disabled_at = now() where id = $1", [inst]);

    const erro = await codigoDoErro(rotacionar(orgA, inst));

    expect(erro.code).toBe("PT409");
    const depois = (await vivos(inst, orgA))[0]!;
    expect(Buffer.compare(depois.token_hash, antes.token_hash)).toBe(0);
  });

  it("instalação removida: PT409", async () => {
    const inst = await instalarConectado();
    await ativar(orgA, inst);
    await query("update public.extension_installations set removed_at = now() where id = $1", [inst]);

    expect((await codigoDoErro(rotacionar(orgA, inst))).code).toBe("PT409");
  });

  it("sem ativação nenhuma, ou instalação que não existe: PT409 e nada é criado", async () => {
    const inst = await instalarConectado();

    expect((await codigoDoErro(rotacionar(orgA, inst))).code).toBe("PT409");
    expect((await codigoDoErro(rotacionar(orgA, randomUUID()))).code).toBe("PT409");
    expect(await tokensDoModulo(inst)).toHaveLength(0);
  });

  it("a organização B nunca obtém token de uma instalação ativada só na A", async () => {
    const inst = await instalarConectado();
    await ativar(orgA, inst);

    const erro = await codigoDoErro(rotacionar(orgB, inst));

    expect(erro.code).toBe("PT409");
    expect(await tokensDoModulo(inst, orgB)).toHaveLength(0);
    const a = await vivos(inst, orgA);
    expect(a).toHaveLength(1);
    expect(a[0]!.organization_id).toBe(orgA);
  });

  it("rotacionar na A não toca o token da B (mesma instalação)", async () => {
    const inst = await instalarConectado();
    await ativar(orgA, inst);
    await ativar(orgB, inst);
    const antesB = (await vivos(inst, orgB))[0]!;

    await rotacionar(orgA, inst);

    const depoisB = (await vivos(inst, orgB))[0]!;
    expect(depoisB.id).toBe(antesB.id);
    expect(Buffer.compare(depoisB.token_hash, antesB.token_hash)).toBe(0);
  });

  it("entrada inválida (prefixo fora do formato, hash curto, validade no passado) dá extension_invalid_input", async () => {
    const inst = await instalarConectado();
    await ativar(orgA, inst);

    await expect(rotacionar(orgA, inst, "abc")).rejects.toThrow("extension_invalid_input");
    await expect(rotacionar(orgA, inst, prefixoNovo(), randomBytes(8))).rejects.toThrow("extension_invalid_input");
    await expect(rotacionar(orgA, inst, prefixoNovo(), randomBytes(32), daqui(-60))).rejects.toThrow(
      "extension_invalid_input",
    );
  });

  it("duas rotações em paralelo (duas conexões) deixam UM token vivo", async () => {
    const inst = await instalarConectado();
    await ativar(orgA, inst);
    const h1 = randomBytes(32);
    const h2 = randomBytes(32);

    const resultados = await Promise.allSettled([
      rotacionar(orgA, inst, prefixoNovo(), h1),
      rotacionar(orgA, inst, prefixoNovo(), h2),
    ]);

    // Nenhuma das duas pode criar um segundo token: ou as duas passam na mesma linha, ou uma é recusada.
    for (const r of resultados) {
      if (r.status === "rejected") expect((r.reason as { code?: string }).code).toBe("PT409");
    }
    expect(resultados.some((r) => r.status === "fulfilled")).toBe(true);
    const vivo = await vivos(inst, orgA);
    expect(vivo).toHaveLength(1);
    expect([h1, h2].some((h) => Buffer.compare(h, vivo[0]!.token_hash) === 0)).toBe(true);
    expect(await tokensDoModulo(inst, orgA)).toHaveLength(1);
  });

  it("rotação concorrente com desativar: o resultado é sempre consistente (revogado, ou vivo com ativação ligada)", async () => {
    const inst = await instalarConectado();
    await ativar(orgA, inst);

    await Promise.allSettled([rotacionar(orgA, inst), desativar(orgA, inst)]);

    const v = await vinculo(orgA, inst);
    const vivo = await vivos(inst, orgA);
    expect(v?.enabled).toBe(false);
    expect(vivo).toHaveLength(0);
  });
});

describe("rotate: o teto quando a linha estava expirada", () => {
  it("token expirado e organização com 50 outros ativos: PT409 e o hash não muda", async () => {
    const inst = await instalarConectado();
    await ativar(orgA, inst);
    await query(
      "update public.api_tokens set expires_at = now() - interval '1 hour' where organization_id = $1 and extension_installation_id = $2",
      [orgA, inst],
    );
    await encher(orgA, 50);
    const antes = (await vivos(inst, orgA))[0]!;

    const erro = await codigoDoErro(rotacionar(orgA, inst));

    expect(erro.code).toBe("PT409");
    const depois = (await vivos(inst, orgA))[0]!;
    expect(Buffer.compare(depois.token_hash, antes.token_hash)).toBe(0);
  });

  it("token expirado com 49 outros ativos: a rotação passa (volta a contar e fecha em 50)", async () => {
    const inst = await instalarConectado();
    await ativar(orgA, inst);
    await query(
      "update public.api_tokens set expires_at = now() - interval '1 hour' where organization_id = $1 and extension_installation_id = $2",
      [orgA, inst],
    );
    await encher(orgA, 49);

    await expect(rotacionar(orgA, inst)).resolves.toBeDefined();

    const ativos = await query(
      "select count(*)::int n from public.api_tokens where organization_id = $1 and revoked_at is null and (expires_at is null or expires_at > now())",
      [orgA],
    );
    expect(ativos.rows[0].n).toBe(50);
  });

  it("token NÃO expirado com 49 outros ativos: a rotação não reconfere nada e passa", async () => {
    const inst = await instalarConectado();
    await ativar(orgA, inst);
    await encher(orgA, 49);

    await expect(rotacionar(orgA, inst)).resolves.toBeDefined();
  });
});

describe("as funções não são expostas", () => {
  const ASSINATURAS = [
    "public.fn_extensions_module_token_reserve(uuid,uuid)",
    "public.fn_extensions_module_token_rotate(uuid,uuid,text,bytea,timestamptz)",
    "public.fn_extensions_module_token_revoke(uuid,uuid,uuid)",
    "public.fn_extensions_configure(uuid,uuid,uuid,uuid,integer,boolean,jsonb)",
    "public.fn_extensions_remove_installation(uuid,uuid,uuid,integer)",
    "public.fn_extensions_set_switch(uuid,uuid,uuid,boolean,integer)",
  ];

  it.each(ASSINATURAS)("%s: anon, authenticated e public não executam; service_role executa", async (assinatura) => {
    const r = await query(
      `select has_function_privilege('anon', '${assinatura}'::regprocedure, 'EXECUTE') anon,
              has_function_privilege('authenticated', '${assinatura}'::regprocedure, 'EXECUTE') autenticado,
              has_function_privilege('service_role', '${assinatura}'::regprocedure, 'EXECUTE') servico,
              exists (
                select 1 from pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                 where p.oid = '${assinatura}'::regprocedure and a.grantee = 0 and a.privilege_type = 'EXECUTE'
              ) publico`,
    );
    expect(r.rows[0]).toEqual({ anon: false, autenticado: false, servico: true, publico: false });
  });

  it("chamar as três funções novas como authenticated ou anon dá 42501", async () => {
    const inst = await instalarConectado();
    const chamadas: [string, unknown[]][] = [
      ["select public.fn_extensions_module_token_reserve($1, $2)", [orgA, inst]],
      [
        "select public.fn_extensions_module_token_rotate($1, $2, 'dsk_00000000', decode(repeat('00', 32), 'hex'), now() + interval '1 hour')",
        [orgA, inst],
      ],
      ["select public.fn_extensions_module_token_revoke($1, $2, $3)", [orgA, inst, dono]],
    ];
    for (const papel of ["authenticated", "anon"] as const) {
      for (const [sql, valores] of chamadas) {
        const erro = await codigoDoErro(como(papel, sql, valores));
        expect(erro.code, `${papel} executou: ${sql}`).toBe("42501");
      }
    }
    expect(await tokensDoModulo(inst)).toHaveLength(0);
  });
});
