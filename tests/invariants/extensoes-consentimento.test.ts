import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { EXTENSION_AREAS, permissaoDaArea } from "@/lib/extensions/areas";

// O consentimento por área do módulo `connected` (spec 33, F3, migration 9119). A organização aceita, entre as
// áreas que o pacote DECLAROU, as que o módulo pode alcançar. A função só grava; quem aplica é a Tarefa 3.
if (!process.env.TEST_DB_PORT) throw new Error("TEST_DB_PORT ausente — execute pnpm test:db");
const pool = new Pool({
  connectionString: `postgresql://postgres:postgres@127.0.0.1:${process.env.TEST_DB_PORT}/postgres`,
  max: 6,
});
const query = (text: string, values: unknown[] = []) => pool.query(text, values);
const hash = (v: unknown) => createHash("sha256").update(JSON.stringify(v)).digest("hex");

const dono = "c0ae0000-0000-4000-8000-000000000006";
const viewer = "c0ae0000-0000-4000-8000-000000000016";
const agente = "c0ae0000-0000-4000-8000-000000000026";
const gerente = "c0ae0000-0000-4000-8000-000000000036";
const outroAdmin = "c0ae0000-0000-4000-8000-000000000046";
const orgA = "c0ae0000-0000-4000-8000-0000000000a6";
const orgB = "c0ae0000-0000-4000-8000-0000000000b6";
const SERVICO = "https://servico.consentimento.test";
const CONFIG = { density: "comfortable", show_description: true };
const DECLARADAS = ["area.contatos.leitura", "area.contatos.escrita", "area.configuracao.leitura", "area.agentes_ia.escrita"];
// As três áreas da migration 9316 (tarefas, etiquetas, financeiro).
const DECLARADAS_NOVAS = ["area.tarefas.escrita", "area.etiquetas.leitura", "area.financeiro.leitura", "area.financeiro.escrita"];
let seq = 0;
const origem = () => `https://consentimento-${++seq}.invariant.test`;

const display = {
  title: { "pt-BR": "Serviço externo" },
  summary: { "pt-BR": "Lê contatos do CRM" },
  category: "productivity",
  icon: "ListChecks",
};

function conectado(name = "servico-externo", permissions: string[] = DECLARADAS) {
  return {
    format_version: 1,
    profile: "connected",
    publisher: "consentimento",
    name,
    version: "1.0.0",
    license: "MIT",
    host_api: { min: 2, max: 2 },
    permissions,
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
    publisher: "consentimento",
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

const instalarConectado = (name = "servico-externo", permissions: string[] = DECLARADAS) =>
  instalar(conectado(name, permissions), { service_origin: SERVICO });

const revisaoDoVinculo = async (org: string, inst: string) =>
  ((await query("select revision from public.organization_extensions where organization_id = $1 and installation_id = $2", [org, inst]))
    .rows[0]?.revision ?? 0) as number;

async function ativar(org: string, inst: string) {
  return rpc("configure", [dono, org, inst, randomUUID(), await revisaoDoVinculo(org, inst), true, JSON.stringify(CONFIG)]);
}

/** Instala um connected, ativa na A e devolve a instalação. */
async function instalarEAtivar(permissions: string[] = DECLARADAS): Promise<string> {
  const inst = await instalarConectado("servico-externo", permissions);
  await ativar(orgA, inst);
  return inst;
}

const consentir = async (ator: string, org: string, inst: string, areas: string[], revisao?: number) =>
  rpc("set_consent", [ator, org, inst, revisao ?? (await revisaoDoVinculo(org, inst)), areas]);

const vinculo = async (org: string, inst: string) =>
  (
    await query(
      "select consented_areas, revision, configuration from public.organization_extensions where organization_id = $1 and installation_id = $2",
      [org, inst],
    )
  ).rows[0] as { consented_areas: string[]; revision: number; configuration: unknown } | undefined;

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

async function erroDe(p: Promise<unknown>): Promise<{ code?: string; message?: string }> {
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
  await query("delete from public.extension_installations where publisher = 'consentimento'");
  await query("delete from public.extension_catalogs where origin like 'https://consentimento-%.invariant.test'");
  await query("delete from public.extension_artifacts where manifest->>'publisher' = 'consentimento'");
}

async function membro(user: string, org: string, role: string) {
  await query("insert into auth.users(id, email) values ($1, $2) on conflict(id) do nothing", [user, `${user}@invariant.test`]);
  await query(
    `insert into user_organizations(user_id, organization_id, role, accepted_at) values ($1, $2, $3, now())
     on conflict(user_id, organization_id) do update set role = excluded.role, accepted_at = now(), revoked_at = null`,
    [user, org, role],
  );
}

beforeAll(async () => {
  await query("insert into auth.users(id, email) values ($1, $2) on conflict(id) do nothing", [dono, `${dono}@invariant.test`]);
  await query(
    `insert into platform_admins(user_id, granted_by, scope, mfa_required, reason)
     values ($1, $1, 'full', false, 'Teste do consentimento do módulo conectado')
     on conflict(user_id) do update set revoked_at = null, scope = 'full'`,
    [dono],
  );
  for (const [id, slug] of [[orgA, "consentimento-a"], [orgB, "consentimento-b"]]) {
    await query(
      "insert into organizations(id,slug,legal_name,display_name) values($1,$2,'Consentimento','Consentimento') on conflict(id) do nothing",
      [id, slug],
    );
  }
  await membro(dono, orgA, "admin");
  await membro(dono, orgB, "admin");
  await membro(viewer, orgA, "viewer");
  await membro(agente, orgA, "agent");
  await membro(gerente, orgA, "manager");
  await membro(outroAdmin, orgA, "admin");
});
beforeEach(limpar);
afterAll(async () => {
  await limpar();
  await query("delete from public.organizations where id in ($1, $2)", [orgA, orgB]);
  await pool.end();
});

describe("gravar o consentimento", () => {
  it("grava as áreas declaradas, ordenadas, e sobe a revisão sem mexer na configuração", async () => {
    const inst = await instalarEAtivar();
    const antes = await vinculo(orgA, inst);
    expect(antes?.consented_areas).toEqual([]);

    const r = await consentir(dono, orgA, inst, ["area.contatos.leitura", "area.agentes_ia.escrita"]);

    expect(r.organization_extension.consented_areas).toEqual(["area.agentes_ia.escrita", "area.contatos.leitura"]);
    const depois = await vinculo(orgA, inst);
    expect(depois?.consented_areas).toEqual(["area.agentes_ia.escrita", "area.contatos.leitura"]);
    expect(depois?.revision).toBe((antes?.revision ?? 0) + 1);
    expect(depois?.configuration).toEqual(antes?.configuration);
  });

  it("retirar uma área vale na hora, e lista vazia retira tudo", async () => {
    const inst = await instalarEAtivar();
    await consentir(dono, orgA, inst, ["area.contatos.leitura", "area.contatos.escrita"]);

    await consentir(dono, orgA, inst, ["area.contatos.leitura"]);
    expect((await vinculo(orgA, inst))?.consented_areas).toEqual(["area.contatos.leitura"]);

    await consentir(dono, orgA, inst, []);
    expect((await vinculo(orgA, inst))?.consented_areas).toEqual([]);
  });

  it("um admin comum da organização (sem ser administrador da plataforma) consente configuracao e agentes_ia", async () => {
    const inst = await instalarEAtivar();

    await consentir(outroAdmin, orgA, inst, ["area.configuracao.leitura", "area.agentes_ia.escrita"]);

    expect((await vinculo(orgA, inst))?.consented_areas).toEqual(["area.agentes_ia.escrita", "area.configuracao.leitura"]);
  });

  it("reconfigurar (ativar de novo) não apaga o consentimento", async () => {
    const inst = await instalarEAtivar();
    await consentir(dono, orgA, inst, ["area.contatos.leitura"]);

    await ativar(orgA, inst);

    expect((await vinculo(orgA, inst))?.consented_areas).toEqual(["area.contatos.leitura"]);
  });
});

describe("quem pode consentir", () => {
  it.each([
    ["viewer", viewer],
    ["agent", agente],
    ["manager", gerente],
  ])("%s não consente configuracao nem agentes_ia (nem nada: não administra a organização)", async (_papel, ator) => {
    const inst = await instalarEAtivar();

    for (const area of ["area.configuracao.leitura", "area.agentes_ia.escrita", "area.contatos.leitura"]) {
      const e = await erroDe(consentir(ator, orgA, inst, [area]));
      expect(e.message).toBe("extension_forbidden");
    }
    expect((await vinculo(orgA, inst))?.consented_areas).toEqual([]);
  });

  it("quem é admin só da B não consente na A", async () => {
    const inst = await instalarEAtivar();
    const so_b = "c0ae0000-0000-4000-8000-000000000056";
    await membro(so_b, orgB, "admin");

    const e = await erroDe(consentir(so_b, orgA, inst, ["area.contatos.leitura"]));

    expect(e.message).toBe("extension_forbidden");
  });

  it("ator removido da organização (revoked_at) não consente", async () => {
    const inst = await instalarEAtivar();
    await query("update user_organizations set revoked_at = now() where user_id = $1 and organization_id = $2", [outroAdmin, orgA]);
    try {
      const e = await erroDe(consentir(outroAdmin, orgA, inst, ["area.contatos.leitura"]));
      expect(e.message).toBe("extension_forbidden");
    } finally {
      await membro(outroAdmin, orgA, "admin");
    }
  });
});

describe("recusas", () => {
  it("área que o pacote NÃO declarou: PT409 extension_area_not_declared", async () => {
    const inst = await instalarEAtivar();

    const e = await erroDe(consentir(dono, orgA, inst, ["area.contatos.leitura", "area.financeiro.escrita"]));
    expect(e).toMatchObject({ code: "PT409", message: "extension_area_not_declared" });

    // Existe no vocabulário, mas este pacote não a declarou.
    const e2 = await erroDe(consentir(dono, orgA, inst, ["area.negocios.leitura"]));
    expect(e2).toMatchObject({ code: "PT409", message: "extension_area_not_declared" });
    expect((await vinculo(orgA, inst))?.consented_areas).toEqual([]);
  });

  it("revisão velha: extension_revision_conflict, e nada é gravado", async () => {
    const inst = await instalarEAtivar();
    const velha = await revisaoDoVinculo(orgA, inst);
    await consentir(dono, orgA, inst, ["area.contatos.leitura"]);

    const e = await erroDe(consentir(dono, orgA, inst, ["area.contatos.escrita"], velha));

    expect(e.message).toBe("extension_revision_conflict");
    expect((await vinculo(orgA, inst))?.consented_areas).toEqual(["area.contatos.leitura"]);
  });

  it("área duplicada na lista: extension_invalid_input", async () => {
    const inst = await instalarEAtivar();

    const e = await erroDe(consentir(dono, orgA, inst, ["area.contatos.leitura", "area.contatos.leitura"]));

    expect(e.message).toBe("extension_invalid_input");
  });

  it("lista nula ou com elemento nulo: extension_invalid_input", async () => {
    const inst = await instalarEAtivar();
    const rev = await revisaoDoVinculo(orgA, inst);

    expect((await erroDe(rpc("set_consent", [dono, orgA, inst, rev, null]))).message).toBe("extension_invalid_input");
    expect((await erroDe(rpc("set_consent", [dono, orgA, inst, rev, ["area.contatos.leitura", null]]))).message).toBe(
      "extension_invalid_input",
    );
  });

  it("instalação ativada só na B: a A não consente (a ativação da A não existe)", async () => {
    const inst = await instalarConectado();
    await ativar(orgB, inst);

    const e = await erroDe(consentir(dono, orgA, inst, ["area.contatos.leitura"], 0));

    expect(e.message).toBe("extension_not_activated");
    expect(await vinculo(orgA, inst)).toBeUndefined();
    expect((await vinculo(orgB, inst))?.consented_areas).toEqual([]);
  });

  it("área fora do vocabulário (area.inexistente.leitura): PT409 extension_area_not_declared, nada é gravado", async () => {
    const inst = await instalarEAtivar();

    const e = await erroDe(consentir(dono, orgA, inst, ["area.inexistente.leitura"]));

    expect(e).toMatchObject({ code: "PT409", message: "extension_area_not_declared" });
    expect((await vinculo(orgA, inst))?.consented_areas).toEqual([]);
  });

  it("consentir na A não muda a B", async () => {
    const inst = await instalarConectado();
    await ativar(orgA, inst);
    await ativar(orgB, inst);

    await consentir(dono, orgA, inst, ["area.contatos.leitura"]);

    expect((await vinculo(orgB, inst))?.consented_areas).toEqual([]);
  });

  it("instalação declarative: extension_consent_not_applicable", async () => {
    const inst = await instalar(declarativo());
    await ativar(orgA, inst);

    const e = await erroDe(consentir(dono, orgA, inst, []));

    expect(e.message).toBe("extension_consent_not_applicable");
  });

  it("instalação removida: extension_removed", async () => {
    const inst = await instalarEAtivar();
    const revisao = (await query("select revision from public.extension_installations where id = $1", [inst])).rows[0].revision;
    await rpc("remove_installation", [dono, randomUUID(), inst, revisao]);

    const e = await erroDe(consentir(dono, orgA, inst, ["area.contatos.leitura"]));

    expect(e.message).toBe("extension_removed");
  });

  it("instalação inexistente: extension_installation_not_found", async () => {
    const e = await erroDe(consentir(dono, orgA, randomUUID(), [], 0));

    expect(e.message).toBe("extension_installation_not_found");
  });
});

describe("as áreas tarefas, etiquetas e financeiro (migration 9316)", () => {
  it("o pacote pode declará-las, e um admin da organização consente tarefas.escrita, etiquetas e financeiro", async () => {
    const inst = await instalarEAtivar(DECLARADAS_NOVAS);

    await consentir(outroAdmin, orgA, inst, ["area.financeiro.leitura", "area.tarefas.escrita", "area.etiquetas.leitura"]);

    expect((await vinculo(orgA, inst))?.consented_areas).toEqual([
      "area.etiquetas.leitura",
      "area.financeiro.leitura",
      "area.tarefas.escrita",
    ]);
  });

  it.each([
    ["viewer", viewer],
    ["agent", agente],
    ["manager", gerente],
  ])("%s não consente financeiro (quem não administra a organização é recusado na porta)", async (_papel, ator) => {
    const inst = await instalarEAtivar(DECLARADAS_NOVAS);

    for (const area of ["area.financeiro.leitura", "area.financeiro.escrita"]) {
      const e = await erroDe(consentir(ator, orgA, inst, [area]));
      expect(e.message).toBe("extension_forbidden");
    }
    expect((await vinculo(orgA, inst))?.consented_areas).toEqual([]);
  });

  it("financeiro não declarada pelo pacote: PT409 extension_area_not_declared, mesmo para admin", async () => {
    const inst = await instalarEAtivar(); // DECLARADAS não tem financeiro

    const e = await erroDe(consentir(dono, orgA, inst, ["area.financeiro.leitura"]));

    expect(e).toMatchObject({ code: "PT409", message: "extension_area_not_declared" });
  });

  it("o CHECK aceita as seis permissões novas direto na tabela", async () => {
    const inst = await instalarEAtivar();
    const novas = [
      "area.tarefas.leitura", "area.tarefas.escrita",
      "area.etiquetas.leitura", "area.etiquetas.escrita",
      "area.financeiro.leitura", "area.financeiro.escrita",
    ];

    await query(
      "update public.organization_extensions set consented_areas = $3::text[] where organization_id = $1 and installation_id = $2",
      [orgA, inst, novas],
    );

    expect((await vinculo(orgA, inst))?.consented_areas).toEqual(novas);
  });
});

describe("a função não é exposta", () => {
  it.each(["authenticated", "anon"] as const)("%s não executa fn_extensions_set_consent (42501)", async (papel) => {
    const inst = await instalarEAtivar();

    const e = await erroDe(
      como(papel, "select public.fn_extensions_set_consent($1,$2,$3,$4,$5)", [dono, orgA, inst, 1, ["area.contatos.leitura"]]),
    );

    expect(e.code).toBe("42501");
  });

  it("só service_role tem EXECUTE", async () => {
    const r = await query(
      `select has_function_privilege('service_role', p.oid, 'execute') as sr,
              has_function_privilege('authenticated', p.oid, 'execute') as au,
              has_function_privilege('anon', p.oid, 'execute') as an
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname = 'fn_extensions_set_consent'`,
    );
    expect(r.rows).toEqual([{ sr: true, au: false, an: false }]);
  });
});

describe("o vocabulário do banco é o do TypeScript", () => {
  it("a lista de áreas do CHECK de consented_areas é igual à de lib/extensions/areas.ts", async () => {
    const r = await query(
      `select pg_get_constraintdef(c.oid) as def
         from pg_constraint c
        where c.conrelid = 'public.organization_extensions'::regclass
          and c.conname = 'organization_extensions_consented_areas_check'`,
    );
    expect(r.rows).toHaveLength(1);
    const noBanco = [...String(r.rows[0].def).matchAll(/'(area\.[a-z_]+\.(?:leitura|escrita))'/g)].map((m) => m[1]!);
    const noCodigo = EXTENSION_AREAS.flatMap((a) => [permissaoDaArea(a, "leitura"), permissaoDaArea(a, "escrita")]);

    expect(new Set(noBanco).size).toBe(noBanco.length);
    expect([...noBanco].sort()).toEqual([...noCodigo].sort());
  });

  it("o CHECK recusa fora do vocabulário mesmo sem passar pela função", async () => {
    const inst = await instalarEAtivar();

    const e = await erroDe(
      query("update public.organization_extensions set consented_areas = array['area.inexistente.escrita'] where organization_id = $1 and installation_id = $2", [
        orgA,
        inst,
      ]),
    );

    expect(e.code).toBe("23514");
  });
});
