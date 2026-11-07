import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Pool } from "pg";

// Os eventos que o módulo `connected` busca (spec 33, F5, migration 9120): contato anonimizado, módulo
// desativado na organização e organização suspensa. Gatilho nunca faz HTTP: escreve uma linha, e a leitura é
// por cursor, SEMPRE filtrada pela organização. O que está em jogo é o vazamento entre organizações (cada
// organização é um cliente) e a LGPD não ficar presa (um módulo desativado ainda lê por 30 dias).
if (!process.env.TEST_DB_PORT) throw new Error("TEST_DB_PORT ausente — execute pnpm test:db");
const pool = new Pool({
  connectionString: `postgresql://postgres:postgres@127.0.0.1:${process.env.TEST_DB_PORT}/postgres`,
  max: 6,
});
const query = (text: string, values: unknown[] = []) => pool.query(text, values);
const hash = (v: unknown) => createHash("sha256").update(JSON.stringify(v)).digest("hex");

const dono = "c0ae0000-0000-4000-8000-000000000007";
const orgA = "c0ae0000-0000-4000-8000-0000000000a7";
const orgB = "c0ae0000-0000-4000-8000-0000000000b7";
const SERVICO = "https://servico.eventos.test";
const CONFIG = { density: "comfortable", show_description: true };
let seq = 0;
const origem = () => `https://eventos-${++seq}.invariant.test`;

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
    publisher: "eventos",
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
    publisher: "eventos",
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

async function configurar(org: string, inst: string, ativo: boolean) {
  return rpc("configure", [dono, org, inst, randomUUID(), await revisaoDoVinculo(org, inst), ativo, JSON.stringify(CONFIG)]);
}
const ativar = (org: string, inst: string) => configurar(org, inst, true);
const desativar = (org: string, inst: string) => configurar(org, inst, false);

const revisaoDaInstalacao = async (inst: string) =>
  (await query("select revision from public.extension_installations where id = $1", [inst])).rows[0].revision as number;
const desligarModulo = async (inst: string, desligado = true) =>
  rpc("set_switch", [dono, randomUUID(), inst, desligado, await revisaoDaInstalacao(inst)]);
const removerModulo = async (inst: string) =>
  rpc("remove_installation", [dono, randomUUID(), inst, await revisaoDaInstalacao(inst)]);

type Evento = {
  id: string;
  organization_id: string;
  kind: string;
  subject_id: string | null;
  installation_id: string | null;
  occurred_at: Date;
};
const eventos = async (org: string, kind?: string) =>
  (
    await query(
      `select id, organization_id, kind, subject_id, installation_id, occurred_at from public.extension_module_events
        where organization_id = $1 and ($2::text is null or kind = $2) order by id`,
      [org, kind ?? null],
    )
  ).rows as Evento[];

const novoContato = async (org: string): Promise<string> => {
  const id = randomUUID();
  await query("insert into contacts(id, organization_id, display_name) values ($1, $2, 'Contato do teste')", [id, org]);
  return id;
};
const anonimizar = (id: string) =>
  query("update contacts set is_anonymized = true, anonymized_at = now() where id = $1", [id]);

const suspender = (org: string, status = "suspended") =>
  query(
    `update public.organizations set status = $2, suspended_kind = case when $2 = 'suspended' then 'administrativa' else suspended_kind end,
       suspended_at = now() where id = $1`,
    [org, status],
  );
const reativarOrg = (org: string) =>
  query(
    "update public.organizations set status = 'active', suspended_kind = null, suspended_at = null, redacted_at = null where id = $1",
    [org],
  );

/** Lê como o service_role (quem tem o grant). */
const ler = (org: string, inst: string, depois = 0, limite = 100) => rpc("events_read", [org, inst, depois, limite]);
const permitido = async (org: string, inst: string) => (await rpc("events_allowed", [org, inst])) as boolean;
const reconhecer = (org: string, inst: string, evento: string | number) => rpc("events_ack", [org, inst, evento]);
const cursor = async (org: string, inst: string) =>
  (await query("select last_event_id, last_read_at from public.extension_module_cursors where organization_id = $1 and installation_id = $2", [org, inst]))
    .rows[0] as { last_event_id: string; last_read_at: Date } | undefined;

/** Põe o fato `module_disabled` do par `dias` dias no passado. */
const envelhecer = (org: string, inst: string, dias: number) =>
  query(
    `update public.extension_module_events set occurred_at = now() - ($3 || ' days')::interval
      where organization_id = $1 and installation_id = $2 and kind = 'module_disabled'`,
    [org, inst, String(dias)],
  );

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

/**
 * SABOTAGEM: dentro de uma transação que é DESFEITA, remove o gatilho, faz a mudança e conta os eventos da
 * organização. Sem o gatilho, nenhum evento nasce: é o que prova que o teste que olha o evento vigia o gatilho.
 */
async function eventosSemOGatilho(gatilho: string, tabela: string, org: string, acao: string, valores: unknown[]) {
  const c = await pool.connect();
  try {
    await c.query("begin");
    await c.query(`drop trigger ${gatilho} on ${tabela}`);
    await c.query(acao, valores);
    const r = await c.query("select count(*)::int n from public.extension_module_events where organization_id = $1", [org]);
    return r.rows[0].n as number;
  } finally {
    await c.query("rollback").catch(() => undefined);
    c.release();
  }
}

async function limpar() {
  for (const org of [orgA, orgB]) await reativarOrg(org);
  await query("delete from public.extension_module_events where organization_id in ($1, $2)", [orgA, orgB]);
  await query("delete from public.extension_module_cursors where organization_id in ($1, $2)", [orgA, orgB]);
  await query("delete from public.api_tokens where organization_id in ($1, $2)", [orgA, orgB]);
  await query("delete from public.organization_extensions where organization_id in ($1, $2)", [orgA, orgB]);
  await query("delete from public.extension_operations where actor_id = $1", [dono]);
  await query("delete from public.extension_installations where publisher = 'eventos'");
  await query("delete from public.extension_catalogs where origin like 'https://eventos-%.invariant.test'");
  await query("delete from public.extension_artifacts where manifest->>'publisher' = 'eventos'");
  // Os eventos que as linhas acima geraram na limpeza também saem.
  await query("delete from public.extension_module_events where organization_id in ($1, $2)", [orgA, orgB]);
}

beforeAll(async () => {
  await query("insert into auth.users(id, email) values ($1, $2) on conflict(id) do nothing", [dono, `${dono}@invariant.test`]);
  await query(
    `insert into platform_admins(user_id, granted_by, scope, mfa_required, reason)
     values ($1, $1, 'full', false, 'Teste dos eventos do módulo conectado')
     on conflict(user_id) do update set revoked_at = null, scope = 'full'`,
    [dono],
  );
  for (const [id, slug] of [[orgA, "eventos-a"], [orgB, "eventos-b"]]) {
    await query(
      "insert into organizations(id,slug,legal_name,display_name) values($1,$2,'Eventos','Eventos') on conflict(id) do nothing",
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

describe("gatilho (a): contato anonimizado", () => {
  it("anonimizar gera exatamente UM evento da organização do contato, com o id do contato", async () => {
    const contato = await novoContato(orgA);

    await anonimizar(contato);

    const evs = await eventos(orgA);
    expect(evs).toHaveLength(1);
    expect(evs[0]).toMatchObject({ kind: "contact_anonymized", subject_id: contato, installation_id: null, organization_id: orgA });
    expect(await eventos(orgB)).toHaveLength(0);
  });

  it("anonimizar o mesmo contato de novo não gera outro evento; o índice único recusa o duplicado", async () => {
    const contato = await novoContato(orgA);
    await anonimizar(contato);

    await anonimizar(contato);
    expect(await eventos(orgA, "contact_anonymized")).toHaveLength(1);

    const e = await erroDe(
      query("insert into public.extension_module_events(organization_id, kind, subject_id) values ($1, 'contact_anonymized', $2)", [orgA, contato]),
    );
    expect(e.code).toBe("23505");
  });

  it("contato que não virou anonimizado, ou outra coluna alterada, não gera evento", async () => {
    const contato = await novoContato(orgA);
    await query("update contacts set display_name = 'Outro nome' where id = $1", [contato]);
    expect(await eventos(orgA)).toHaveLength(0);
  });

  it("SABOTAGEM: sem o gatilho do contato nenhum evento nasce", async () => {
    const contato = await novoContato(orgA);
    const n = await eventosSemOGatilho(
      "trg_extensions_evento_contato_anonimizado",
      "public.contacts",
      orgA,
      "update contacts set is_anonymized = true, anonymized_at = now() where id = $1",
      [contato],
    );
    expect(n).toBe(0);
  });
});

describe("gatilho (b): vínculo organização × módulo deixa de estar ligado", () => {
  it("desativar gera UM evento do par; desativar o que já está desativado não gera outro; religar e desligar gera o segundo", async () => {
    const inst = await instalarConectado();
    await ativar(orgA, inst);
    expect(await eventos(orgA)).toHaveLength(0);

    await desativar(orgA, inst);
    const um = await eventos(orgA);
    expect(um).toHaveLength(1);
    expect(um[0]).toMatchObject({ kind: "module_disabled", installation_id: inst, subject_id: null, organization_id: orgA });

    await desativar(orgA, inst);
    expect(await eventos(orgA)).toHaveLength(1);

    await ativar(orgA, inst);
    expect(await eventos(orgA)).toHaveLength(1);
    await desativar(orgA, inst);
    expect(await eventos(orgA)).toHaveLength(2);
  });

  it("apagar a linha do vínculo ligado gera UM evento; apagar a linha já desligada não gera", async () => {
    const inst = await instalarConectado();
    await ativar(orgA, inst);
    await ativar(orgB, inst);
    await desativar(orgB, inst);
    await query("delete from public.extension_module_events where organization_id = $1", [orgB]);

    await query("delete from public.organization_extensions where organization_id = $1 and installation_id = $2", [orgA, inst]);
    await query("delete from public.organization_extensions where organization_id = $1 and installation_id = $2", [orgB, inst]);

    expect(await eventos(orgA, "module_disabled")).toHaveLength(1);
    expect(await eventos(orgB)).toHaveLength(0);
  });

  it("módulo declarativo não gera evento (só o connected tem quem busque)", async () => {
    const inst = await instalar(declarativo());
    await ativar(orgA, inst);

    await desativar(orgA, inst);

    expect(await eventos(orgA)).toHaveLength(0);
  });

  it("apagar a organização inteira, com o vínculo ligado, não quebra (a FK não pode travar a exclusão)", async () => {
    const inst = await instalarConectado();
    const orgC = randomUUID();
    await query("insert into organizations(id,slug,legal_name,display_name) values($1,$2,'Eventos C','Eventos C')", [orgC, `eventos-c-${orgC.slice(0, 8)}`]);
    await query(
      `insert into user_organizations(user_id, organization_id, role, accepted_at) values ($1, $2, 'admin', now())`,
      [dono, orgC],
    );
    await ativar(orgC, inst);

    await query("delete from public.organizations where id = $1", [orgC]);

    expect((await query("select count(*)::int n from public.extension_module_events where organization_id = $1", [orgC])).rows[0].n).toBe(0);
  });

  it("SABOTAGEM: sem o gatilho de UPDATE do vínculo, desativar não gera evento", async () => {
    const inst = await instalarConectado();
    await ativar(orgA, inst);
    const n = await eventosSemOGatilho(
      "trg_extensions_evento_vinculo_desligado_upd",
      "public.organization_extensions",
      orgA,
      "update public.organization_extensions set enabled = false where organization_id = $1 and installation_id = $2",
      [orgA, inst],
    );
    expect(n).toBe(0);
  });

  it("SABOTAGEM: sem o gatilho de DELETE do vínculo, apagar a linha não gera evento", async () => {
    const inst = await instalarConectado();
    await ativar(orgA, inst);
    const n = await eventosSemOGatilho(
      "trg_extensions_evento_vinculo_desligado_del",
      "public.organization_extensions",
      orgA,
      "delete from public.organization_extensions where organization_id = $1 and installation_id = $2",
      [orgA, inst],
    );
    expect(n).toBe(0);
  });
});

describe("gatilho (c): a instalação connected é desligada ou removida", () => {
  it("desligar gera UM evento por vínculo ainda ligado, e nenhum para a organização onde já estava desativado", async () => {
    const inst = await instalarConectado();
    await ativar(orgA, inst);
    await ativar(orgB, inst);
    await desativar(orgB, inst);
    await query("delete from public.extension_module_events where organization_id = $1", [orgB]);

    await desligarModulo(inst);

    expect(await eventos(orgA, "module_disabled")).toHaveLength(1);
    expect((await eventos(orgA))[0]).toMatchObject({ installation_id: inst });
    expect(await eventos(orgB)).toHaveLength(0);
  });

  it("desligar e DEPOIS remover é um fato só", async () => {
    const inst = await instalarConectado();
    await ativar(orgA, inst);

    await desligarModulo(inst);
    await removerModulo(inst);
    expect(await eventos(orgA, "module_disabled")).toHaveLength(1);
  });

  it("remover direto: UM evento por vínculo ligado, sem duplicata com o gatilho do vínculo (a remoção também desativa os vínculos)", async () => {
    const inst = await instalarConectado();
    await ativar(orgA, inst);
    await ativar(orgB, inst);

    await removerModulo(inst);

    expect(await eventos(orgA, "module_disabled")).toHaveLength(1);
    expect(await eventos(orgB, "module_disabled")).toHaveLength(1);
  });

  it("ligar de novo e desligar outra vez gera um evento novo", async () => {
    const inst = await instalarConectado();
    await ativar(orgA, inst);
    await desligarModulo(inst);
    await desligarModulo(inst, false);
    expect(await eventos(orgA, "module_disabled")).toHaveLength(1);

    await desligarModulo(inst);

    expect(await eventos(orgA, "module_disabled")).toHaveLength(2);
  });

  it("SABOTAGEM: sem o gatilho da instalação, desligar o módulo não gera evento", async () => {
    const inst = await instalarConectado();
    await ativar(orgA, inst);
    const n = await eventosSemOGatilho(
      "trg_extensions_evento_instalacao_desligada",
      "public.extension_installations",
      orgA,
      "update public.extension_installations set disabled_at = now() where id = $1",
      [inst],
    );
    expect(n).toBe(0);
  });
});

describe("gatilho (d): organização suspensa ou anonimizada", () => {
  it("suspender gera UM evento da organização; reativar não gera; suspender de novo gera o segundo", async () => {
    await suspender(orgA);
    const um = await eventos(orgA);
    expect(um).toHaveLength(1);
    expect(um[0]).toMatchObject({ kind: "organization_suspended", subject_id: null, installation_id: null });
    expect(await eventos(orgB)).toHaveLength(0);

    await reativarOrg(orgA);
    expect(await eventos(orgA)).toHaveLength(1);

    await suspender(orgA);
    expect(await eventos(orgA)).toHaveLength(2);
  });

  it("suspensa que vira redacted (D4) gera o evento; atualizar outra coluna da organização não gera", async () => {
    await suspender(orgA);
    await query("update public.organizations set display_name = 'Outro nome' where id = $1", [orgA]);
    expect(await eventos(orgA)).toHaveLength(1);

    await query("update public.organizations set status = 'redacted', redacted_at = now() where id = $1", [orgA]);

    expect(await eventos(orgA, "organization_suspended")).toHaveLength(2);
    await query("update public.organizations set redacted_at = null where id = $1", [orgA]);
  });

  it("SABOTAGEM: sem o gatilho da organização, suspender não gera evento", async () => {
    const n = await eventosSemOGatilho(
      "trg_extensions_evento_organizacao_suspensa",
      "public.organizations",
      orgA,
      "update public.organizations set status = 'suspended', suspended_kind = 'administrativa', suspended_at = now() where id = $1",
      [orgA],
    );
    expect(n).toBe(0);
  });
});

describe("quem pode ler (regra D2)", () => {
  it("vínculo ligado com instalação ativa lê; sem vínculo não lê; vínculo de outra organização não vale", async () => {
    const inst = await instalarConectado();
    expect(await permitido(orgA, inst)).toBe(false);

    await ativar(orgA, inst);

    expect(await permitido(orgA, inst)).toBe(true);
    expect(await permitido(orgB, inst)).toBe(false);
    expect(await permitido(orgA, randomUUID())).toBe(false);
  });

  it("desativado há 29 dias lê; há 31 dias não; reativar volta a permitir", async () => {
    const inst = await instalarConectado();
    await ativar(orgA, inst);
    await desativar(orgA, inst);
    expect(await permitido(orgA, inst)).toBe(true);

    await envelhecer(orgA, inst, 29);
    expect(await permitido(orgA, inst)).toBe(true);

    await envelhecer(orgA, inst, 31);
    expect(await permitido(orgA, inst)).toBe(false);

    await ativar(orgA, inst);
    expect(await permitido(orgA, inst)).toBe(true);
  });

  it("módulo desligado na instalação: lê por 30 dias e depois não, mesmo com o vínculo ainda marcado como ligado", async () => {
    const inst = await instalarConectado();
    await ativar(orgA, inst);
    await desligarModulo(inst);
    expect(await permitido(orgA, inst)).toBe(true);

    await envelhecer(orgA, inst, 31);
    expect(await permitido(orgA, inst)).toBe(false);

    await desligarModulo(inst, false);
    expect(await permitido(orgA, inst)).toBe(true);
  });

  it("módulo removido lê por 30 dias (a LGPD não fica presa) e depois não", async () => {
    const inst = await instalarConectado();
    await ativar(orgA, inst);
    await removerModulo(inst);
    expect(await permitido(orgA, inst)).toBe(true);

    await envelhecer(orgA, inst, 31);
    expect(await permitido(orgA, inst)).toBe(false);
  });

  it("organização suspensa continua lendo (o evento de suspensão precisa chegar)", async () => {
    const inst = await instalarConectado();
    await ativar(orgA, inst);
    await suspender(orgA);

    expect(await permitido(orgA, inst)).toBe(true);
    const r = await ler(orgA, inst);
    expect(r.events.map((e: Evento) => e.kind)).toEqual(["organization_suspended"]);
  });

  it("evento de desativação de OUTRO módulo da mesma organização não autoriza este", async () => {
    const a = await instalarConectado("servico-a");
    const b = await instalarConectado("servico-b");
    await ativar(orgA, a);
    await ativar(orgA, b);
    await desativar(orgA, b);
    await desativar(orgA, a);
    await ativar(orgA, a);
    await desativar(orgA, a);
    await envelhecer(orgA, a, 31);

    expect(await permitido(orgA, b)).toBe(true);
    expect(await permitido(orgA, a)).toBe(false);
  });
});

describe("a leitura: só a organização, só o par", () => {
  it("o evento da organização B nunca aparece para o módulo da organização A (mesmo módulo nas duas)", async () => {
    const inst = await instalarConectado();
    await ativar(orgA, inst);
    await ativar(orgB, inst);
    const deA = await novoContato(orgA);
    const deB = await novoContato(orgB);
    await anonimizar(deA);
    await anonimizar(deB);
    await desativar(orgB, inst);
    await suspender(orgB);

    const lidoPelaA = await ler(orgA, inst);

    expect(lidoPelaA.events).toHaveLength(1);
    expect(lidoPelaA.events[0]).toMatchObject({ kind: "contact_anonymized", subject_id: deA });
    expect(JSON.stringify(lidoPelaA)).not.toContain(deB);
    const lidoPelaB = await ler(orgB, inst);
    expect(lidoPelaB.events.map((e: Evento) => e.kind)).toEqual(["contact_anonymized", "module_disabled", "organization_suspended"]);
    expect(JSON.stringify(lidoPelaB)).not.toContain(deA);
  });

  it("um módulo sem vínculo na organização A não lê os eventos dela, mesmo estando ativo na B", async () => {
    const inst = await instalarConectado();
    await ativar(orgB, inst);
    await anonimizar(await novoContato(orgA));

    const e = await erroDe(ler(orgA, inst));

    expect(e.message).toBe("extension_events_forbidden");
  });

  it("module_disabled de outro módulo da mesma organização não aparece para este", async () => {
    const a = await instalarConectado("servico-a");
    const b = await instalarConectado("servico-b");
    await ativar(orgA, a);
    await ativar(orgA, b);
    await desativar(orgA, b);

    const lido = await ler(orgA, a);

    expect(lido.events).toHaveLength(0);
    expect((await ler(orgA, b)).events.map((e: Evento) => e.installation_id)).toEqual([b]);
  });

  it("o corpo do evento tem só identificadores e data", async () => {
    const inst = await instalarConectado();
    await ativar(orgA, inst);
    await anonimizar(await novoContato(orgA));

    const lido = await ler(orgA, inst);

    expect(Object.keys(lido).sort()).toEqual(["events", "has_more", "last_id"]);
    expect(Object.keys(lido.events[0]).sort()).toEqual(["id", "installation_id", "kind", "occurred_at", "subject_id"]);
  });

  it("módulo atrasado volta e lê tudo desde o cursor, em ordem, sem perda nem repetição", async () => {
    const inst = await instalarConectado();
    await ativar(orgA, inst);
    const primeiro = await novoContato(orgA);
    await anonimizar(primeiro);
    const lidoAntes = await ler(orgA, inst);
    await reconhecer(orgA, inst, lidoAntes.last_id);
    await query("update public.extension_module_cursors set last_read_at = now() - interval '40 days' where organization_id = $1", [orgA]);

    const novos: string[] = [];
    for (let i = 0; i < 7; i++) {
      const c = await novoContato(orgA);
      novos.push(c);
      await anonimizar(c);
    }
    const c = await cursor(orgA, inst);

    const lido = await ler(orgA, inst, Number(c!.last_event_id));

    expect(lido.events.map((e: Evento) => e.subject_id)).toEqual(novos);
    expect(lido.has_more).toBe(false);
  });

  it("limite acima de 100 é cortado em 100 e a paginação segue sem repetir nem pular", async () => {
    const inst = await instalarConectado();
    await ativar(orgA, inst);
    await query(
      `insert into public.extension_module_events(organization_id, kind, subject_id)
       select $1, 'contact_anonymized', gen_random_uuid() from generate_series(1, 105)`,
      [orgA],
    );

    const p1 = await ler(orgA, inst, 0, 5000);
    expect(p1.events).toHaveLength(100);
    expect(p1.has_more).toBe(true);
    const p2 = await ler(orgA, inst, Number(p1.last_id), 5000);
    expect(p2.events).toHaveLength(5);
    expect(p2.has_more).toBe(false);

    const ids = [...p1.events, ...p2.events].map((e: Evento) => Number(e.id));
    expect(new Set(ids).size).toBe(105);
    expect(ids).toEqual([...ids].sort((x, y) => x - y));
    // Sem evento novo, o cursor não anda.
    const vazio = await ler(orgA, inst, Number(p2.last_id));
    expect(vazio).toEqual({ events: [], last_id: p2.last_id, has_more: false });
  });

  it("entrada inválida é recusada: limite menor que 1, cursor negativo, nulos", async () => {
    const inst = await instalarConectado();
    await ativar(orgA, inst);
    for (const args of [
      [orgA, inst, 0, 0],
      [orgA, inst, -1, 10],
      [orgA, inst, null, 10],
      [orgA, inst, 0, null],
      [null, inst, 0, 10],
      [orgA, null, 0, 10],
    ]) {
      expect((await erroDe(rpc("events_read", args))).message).toBe("extension_invalid_input");
    }
  });
});

describe("o atraso mostrado em /admin/extensoes (9121)", () => {
  const atraso = (inst: string) => rpc("events_lag", [inst]) as Promise<
    { last_event_id: number | null; last_read_at: string | null; lag: number; contacts_pending: number; oldest_unread_at: string | null }[]
  >;

  it("a contagem é por organização e nunca mistura organizações (mesmo módulo nas duas)", async () => {
    const inst = await instalarConectado();
    await ativar(orgA, inst);
    await ativar(orgB, inst);
    for (let i = 0; i < 2; i++) await anonimizar(await novoContato(orgA));
    for (let i = 0; i < 5; i++) await anonimizar(await novoContato(orgB));
    const idsA = (await eventos(orgA)).map((e) => Number(e.id));
    await reconhecer(orgA, inst, idsA[0]!);

    const linhas = await atraso(inst);

    expect(linhas).toHaveLength(2);
    expect(linhas.map((l) => l.lag).sort()).toEqual([1, 5]);
    const deA = linhas.find((l) => l.lag === 1)!;
    expect(deA.last_event_id).toBe(idsA[0]);
    expect(deA.contacts_pending).toBe(1);
    const deB = linhas.find((l) => l.lag === 5)!;
    expect(deB.last_event_id).toBeNull();
    expect(deB.last_read_at).toBeNull();
    expect(deB.oldest_unread_at).not.toBeNull();
    // Nada que identifique a organização sai da função.
    expect(JSON.stringify(linhas)).not.toContain(orgA);
    expect(JSON.stringify(linhas)).not.toContain(orgB);
  });

  it("module_disabled de outro módulo não entra no atraso deste; módulo sem vínculo nem cursor não aparece", async () => {
    const a = await instalarConectado("servico-a");
    const b = await instalarConectado("servico-b");
    await ativar(orgA, a);
    await ativar(orgA, b);
    await desativar(orgA, b);
    expect((await atraso(a)).map((l) => l.lag)).toEqual([0]);
    expect(await atraso(await instalarConectado("servico-c"))).toEqual([]);
  });

  it("lê só como service_role: anon e authenticated não executam", async () => {
    const inst = await instalarConectado();
    const r = await query(
      `select has_function_privilege('anon', 'public.fn_extensions_events_lag(uuid)', 'execute') anon,
              has_function_privilege('authenticated', 'public.fn_extensions_events_lag(uuid)', 'execute') auth,
              has_function_privilege('service_role', 'public.fn_extensions_events_lag(uuid)', 'execute') servico`,
    );
    expect(r.rows[0]).toEqual({ anon: false, auth: false, servico: true });
    expect(inst).toBeTruthy();
  });
});

describe("o cursor", () => {
  it("nunca regride e nunca passa do último evento visível ao par", async () => {
    const inst = await instalarConectado();
    await ativar(orgA, inst);
    for (let i = 0; i < 3; i++) await anonimizar(await novoContato(orgA));
    const ids = (await eventos(orgA)).map((e) => Number(e.id));

    // A função devolve jsonb (número); a tabela devolve bigint (texto).
    expect((await reconhecer(orgA, inst, ids[1]!)).last_event_id).toBe(ids[1]);
    expect((await reconhecer(orgA, inst, ids[0]!)).last_event_id).toBe(ids[1]);
    expect((await reconhecer(orgA, inst, ids[2]!)).last_event_id).toBe(ids[2]);
    // Cursor inflado é cortado no último evento da própria organização.
    expect((await reconhecer(orgA, inst, ids[2]! + 100000)).last_event_id).toBe(ids[2]);
    expect((await cursor(orgA, inst))?.last_event_id).toBe(String(ids[2]));
  });

  it("o cursor do par não se mistura com o de outra organização nem com o de outro módulo", async () => {
    const a = await instalarConectado("servico-a");
    const b = await instalarConectado("servico-b");
    await ativar(orgA, a);
    await ativar(orgA, b);
    await ativar(orgB, a);
    await anonimizar(await novoContato(orgA));
    const id = Number((await eventos(orgA))[0]!.id);

    await reconhecer(orgA, a, id);

    expect((await cursor(orgA, a))?.last_event_id).toBe(String(id));
    expect(await cursor(orgA, b)).toBeUndefined();
    expect(await cursor(orgB, a)).toBeUndefined();
  });

  it("reconhecer sem estar autorizado é recusado e não cria cursor", async () => {
    const inst = await instalarConectado();
    const e = await erroDe(reconhecer(orgA, inst, 0));
    expect(e.message).toBe("extension_events_forbidden");
    expect(await cursor(orgA, inst)).toBeUndefined();
  });

  it("apagar a instalação apaga o cursor", async () => {
    const inst = await instalarConectado();
    await ativar(orgA, inst);
    await reconhecer(orgA, inst, 0);
    expect(await cursor(orgA, inst)).toBeDefined();

    await query("delete from public.api_tokens where extension_installation_id = $1", [inst]);
    await query("delete from public.organization_extensions where installation_id = $1", [inst]);
    await query("delete from public.extension_module_events where installation_id = $1", [inst]);
    await query("delete from public.extension_operations where installation_id = $1", [inst]);
    await query("delete from public.extension_installations where id = $1", [inst]);

    expect(await cursor(orgA, inst)).toBeUndefined();
  });
});

describe("fechado para quem não é o servidor", () => {
  const FUNCOES = [
    "public.fn_extensions_events_allowed(uuid,uuid)",
    "public.fn_extensions_events_read(uuid,uuid,bigint,integer)",
    "public.fn_extensions_events_ack(uuid,uuid,bigint)",
  ];
  const DE_GATILHO = [
    "public.fn_extensions_evento_contato_anonimizado()",
    "public.fn_extensions_evento_vinculo_desligado()",
    "public.fn_extensions_evento_instalacao_desligada()",
    "public.fn_extensions_evento_organizacao_suspensa()",
  ];

  it.each([...FUNCOES, ...DE_GATILHO])("%s: anon, authenticated e public não executam", async (assinatura) => {
    const r = await query(
      `select has_function_privilege('anon', '${assinatura}'::regprocedure, 'EXECUTE') anon,
              has_function_privilege('authenticated', '${assinatura}'::regprocedure, 'EXECUTE') autenticado,
              exists (
                select 1 from pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                 where p.oid = '${assinatura}'::regprocedure and a.grantee = 0 and a.privilege_type = 'EXECUTE'
              ) publico`,
    );
    expect(r.rows[0]).toEqual({ anon: false, autenticado: false, publico: false });
  });

  it.each(FUNCOES)("%s: service_role executa", async (assinatura) => {
    const r = await query(`select has_function_privilege('service_role', '${assinatura}'::regprocedure, 'EXECUTE') servico`);
    expect(r.rows[0].servico).toBe(true);
  });

  it.each(["anon", "authenticated"] as const)("%s chamando as três funções recebe 42501", async (papel) => {
    const inst = randomUUID();
    for (const sql of [
      `select public.fn_extensions_events_allowed('${orgA}', '${inst}')`,
      `select public.fn_extensions_events_read('${orgA}', '${inst}', 0, 10)`,
      `select public.fn_extensions_events_ack('${orgA}', '${inst}', 0)`,
    ]) {
      expect((await erroDe(como(papel, sql))).code).toBe("42501");
    }
  });

  it.each(["anon", "authenticated"] as const)("%s não lê nem escreve as duas tabelas", async (papel) => {
    for (const tabela of ["extension_module_events", "extension_module_cursors"]) {
      expect((await erroDe(como(papel, `select * from public.${tabela}`))).code).toBe("42501");
      expect((await erroDe(como(papel, `delete from public.${tabela}`))).code).toBe("42501");
    }
  });

  it("RLS ligada nas duas tabelas e NENHUMA policy; service_role só lê os eventos e não apaga cursor", async () => {
    const rls = await query(
      "select relname, relrowsecurity from pg_class where oid in ('public.extension_module_events'::regclass, 'public.extension_module_cursors'::regclass) order by relname",
    );
    expect(rls.rows).toEqual([
      { relname: "extension_module_cursors", relrowsecurity: true },
      { relname: "extension_module_events", relrowsecurity: true },
    ]);
    const policies = await query("select count(*)::int n from pg_policies where tablename in ('extension_module_events','extension_module_cursors')");
    expect(policies.rows[0].n).toBe(0);
    const p = await query(
      `select has_table_privilege('service_role', 'public.extension_module_events', 'SELECT') le_eventos,
              has_table_privilege('service_role', 'public.extension_module_events', 'INSERT') escreve_eventos,
              has_table_privilege('service_role', 'public.extension_module_events', 'DELETE') apaga_eventos,
              has_table_privilege('service_role', 'public.extension_module_cursors', 'DELETE') apaga_cursor`,
    );
    expect(p.rows[0]).toEqual({ le_eventos: true, escreve_eventos: false, apaga_eventos: false, apaga_cursor: false });
  });

  it("as funções de gatilho são definer: quem muda o fato é qualquer papel, o evento nasce do mesmo jeito", async () => {
    const r = await query(
      "select proname, prosecdef from pg_proc where proname like 'fn_extensions_evento_%' and pronamespace = 'public'::regnamespace order by proname",
    );
    expect(r.rows).toHaveLength(4);
    expect(r.rows.every((x) => x.prosecdef === true)).toBe(true);
  });

  it("nenhuma função da migration fala HTTP", async () => {
    const r = await query(
      `select count(*)::int n from pg_proc where proname like 'fn_extensions_event%'
         and pronamespace = 'public'::regnamespace and prosrc ~* '(net\\.http|pg_net|http_post|http_get)'`,
    );
    expect(r.rows[0].n).toBe(0);
  });
});
