import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Pool } from "pg";

// O interruptor, por instalação, do módulo `connected` (spec 33, D8). Desligar não desinstala: a
// instalação continua, com `disabled_at` marcado e a revisão da instalação incrementada. O recibo é
// idempotente como o de remover (mesma chave + mesmo corpo = `applied_now: false`), e a precondição é
// a revisão que a tela viu. Só vale para pacote `connected`: ligar ou desligar um guia declarativo não
// tem o que ligar, e o banco recusa em vez de gravar uma marca sem efeito.
if (!process.env.TEST_DB_PORT) throw new Error("TEST_DB_PORT ausente — execute pnpm test:db");
const pool = new Pool({
  connectionString: `postgresql://postgres:postgres@127.0.0.1:${process.env.TEST_DB_PORT}/postgres`,
  max: 4,
});
const query = (text: string, values: unknown[] = []) => pool.query(text, values);
const hash = (v: unknown) => createHash("sha256").update(JSON.stringify(v)).digest("hex");

const dono = "c0ae0000-0000-4000-8000-000000000002";
const SERVICO = "https://servico.interruptor.test";
let seq = 0;
const origem = () => `https://interruptor-${++seq}.invariant.test`;

const display = {
  title: { "pt-BR": "Serviço externo" },
  summary: { "pt-BR": "Lê contatos do CRM" },
  category: "productivity",
  icon: "ListChecks",
};

/** Um manifesto `connected` mínimo e válido: só permissão de área, `data` none, sem card nem tema. */
function conectado() {
  return {
    format_version: 1,
    profile: "connected",
    publisher: "interruptor",
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

/** Um manifesto `declarative` válido: o interruptor não se aplica a ele. */
function declarativo() {
  return {
    format_version: 1,
    profile: "declarative",
    publisher: "interruptor",
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

/** O caminho inteiro da instalação; devolve o id da instalação. */
async function instalar(m: Record<string, unknown>, extra: Record<string, unknown> = {}): Promise<string> {
  const e = entrada(m, extra);
  const catalogo = (await admitir([e])).catalog_id as string;
  const preparo = await rpc("prepare_install", [
    dono, randomUUID(), catalogo, e.publisher, e.name, e.version, null,
  ]);
  const recibo = await rpc("finish_install", [
    dono, preparo.id, JSON.stringify(m), e.sha256, e.byte_length, JSON.stringify(m),
  ]);
  return recibo.installation_id as string;
}

const instalarConectado = () => instalar(conectado(), { service_origin: SERVICO });

/** `p_operation, p_installation, p_disabled, p_expected_installation_revision` com o ator do teste. */
const interruptor = (operacao: string, instalacao: string, desligado: boolean, revisao: number) =>
  rpc("set_switch", [dono, operacao, instalacao, desligado, revisao]);

const linhaDa = async (id: string) =>
  (await query("select revision, disabled_at, disabled_by, removed_at from public.extension_installations where id = $1", [id]))
    .rows[0] as { revision: number; disabled_at: Date | null; disabled_by: string | null; removed_at: Date | null };

async function limpar() {
  await query("delete from public.extension_operations where actor_id = $1", [dono]);
  await query("delete from public.extension_installations where publisher = 'interruptor'");
  await query("delete from public.extension_catalogs where origin like 'https://interruptor-%.invariant.test'");
  await query("delete from public.extension_artifacts where manifest->>'publisher' = 'interruptor'");
}

beforeAll(async () => {
  await query("insert into auth.users(id, email) values ($1, $2) on conflict(id) do nothing", [
    dono,
    `${dono}@invariant.test`,
  ]);
  await query(
    `insert into platform_admins(user_id, granted_by, scope, mfa_required, reason)
     values ($1, $1, 'full', false, 'Teste do interruptor do módulo conectado')
     on conflict(user_id) do update set revoked_at = null, scope = 'full'`,
    [dono],
  );
});
beforeEach(limpar);
afterAll(async () => {
  await limpar();
  await pool.end();
});

describe("interruptor: desligar e ligar um módulo connected", () => {
  it("desligar grava disabled_at e disabled_by, incrementa a revisão e diz applied_now", async () => {
    const id = await instalarConectado();
    expect(await linhaDa(id)).toMatchObject({ revision: 1, disabled_at: null, disabled_by: null });

    const recibo = await interruptor(randomUUID(), id, true, 1);

    expect(recibo).toMatchObject({
      kind: "switch",
      status: "completed",
      applied_now: true,
      organization_id: null,
      installation_id: id,
      result: { disabled: true, from_revision: 1 },
    });
    const linha = await linhaDa(id);
    expect(linha).toMatchObject({ revision: 2, disabled_by: dono });
    expect(linha.disabled_at).not.toBeNull();
    // Desligar não desinstala.
    expect(linha.removed_at).toBeNull();
  });

  it("repetir o mesmo recibo devolve applied_now false e não mexe na revisão", async () => {
    const id = await instalarConectado();
    const chave = randomUUID();
    await interruptor(chave, id, true, 1);

    const repetido = await interruptor(chave, id, true, 1);

    expect(repetido).toMatchObject({ kind: "switch", applied_now: false });
    expect((await linhaDa(id)).revision).toBe(2);
    const recibos = await query("select count(*)::int n from public.extension_operations where id = $1", [chave]);
    expect(recibos.rows[0].n).toBe(1);
  });

  it("o mesmo recibo com corpo diferente dá extension_idempotency_conflict", async () => {
    const id = await instalarConectado();
    const chave = randomUUID();
    await interruptor(chave, id, true, 1);

    await expect(interruptor(chave, id, false, 1)).rejects.toThrow("extension_idempotency_conflict");
    expect((await linhaDa(id)).revision).toBe(2);
  });

  it("revisão velha dá extension_version_changed e nada é gravado", async () => {
    const id = await instalarConectado();
    await interruptor(randomUUID(), id, true, 1);

    // A tela viu a revisão 1; a instalação já está na 2.
    await expect(interruptor(randomUUID(), id, false, 1)).rejects.toThrow("extension_version_changed");
    const linha = await linhaDa(id);
    expect(linha.revision).toBe(2);
    expect(linha.disabled_at).not.toBeNull();
  });

  it("ligar de novo zera disabled_at e disabled_by e incrementa a revisão outra vez", async () => {
    const id = await instalarConectado();
    await interruptor(randomUUID(), id, true, 1);

    const religado = await interruptor(randomUUID(), id, false, 2);

    expect(religado).toMatchObject({ kind: "switch", applied_now: true, result: { disabled: false, from_revision: 2 } });
    expect(await linhaDa(id)).toMatchObject({ revision: 3, disabled_at: null, disabled_by: null });
  });

  it("desligar o que já está desligado mantém a hora original de disabled_at", async () => {
    const id = await instalarConectado();
    await interruptor(randomUUID(), id, true, 1);
    const primeira = (await linhaDa(id)).disabled_at;

    await interruptor(randomUUID(), id, true, 2);

    expect((await linhaDa(id)).disabled_at).toEqual(primeira);
  });
});

describe("interruptor: o que o banco recusa", () => {
  it("instalação declarative dá extension_switch_not_applicable e nada é gravado", async () => {
    const id = await instalar(declarativo());

    await expect(interruptor(randomUUID(), id, true, 1)).rejects.toThrow("extension_switch_not_applicable");
    expect(await linhaDa(id)).toMatchObject({ revision: 1, disabled_at: null, disabled_by: null });
  });

  it("instalação removida dá extension_removed", async () => {
    const id = await instalarConectado();
    await rpc("remove_installation", [dono, randomUUID(), id, 1]);

    await expect(interruptor(randomUUID(), id, true, 2)).rejects.toThrow("extension_removed");
  });

  it("instalação que não existe dá extension_installation_not_found", async () => {
    await expect(interruptor(randomUUID(), randomUUID(), true, 1)).rejects.toThrow(
      "extension_installation_not_found",
    );
  });

  it("entrada inválida (revisão zero, sem recibo) dá extension_invalid_input", async () => {
    const id = await instalarConectado();
    await expect(interruptor(randomUUID(), id, true, 0)).rejects.toThrow("extension_invalid_input");
    await expect(rpc("set_switch", [dono, null, id, true, 1])).rejects.toThrow("extension_invalid_input");
  });

  it("quem não é administrador da instalação dá extension_forbidden", async () => {
    const id = await instalarConectado();
    await expect(
      rpc("set_switch", [randomUUID(), randomUUID(), id, true, 1]),
    ).rejects.toThrow("extension_forbidden");
  });
});

describe("interruptor: a função não é exposta", () => {
  const ASSINATURA = "public.fn_extensions_set_switch(uuid,uuid,uuid,boolean,integer)";

  it("anon, authenticated e public não executam; service_role executa", async () => {
    const r = await query(
      `select has_function_privilege('anon', '${ASSINATURA}'::regprocedure, 'EXECUTE') anon,
              has_function_privilege('authenticated', '${ASSINATURA}'::regprocedure, 'EXECUTE') autenticado,
              has_function_privilege('service_role', '${ASSINATURA}'::regprocedure, 'EXECUTE') servico,
              exists (
                select 1 from pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                 where p.oid = '${ASSINATURA}'::regprocedure and a.grantee = 0 and a.privilege_type = 'EXECUTE'
              ) publico`,
    );
    expect(r.rows[0]).toEqual({ anon: false, autenticado: false, servico: true, publico: false });
  });
});
