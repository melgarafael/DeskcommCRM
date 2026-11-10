import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Pool } from "pg";

import { EXTENSION_PERMISSIONS } from "@/lib/extensions/capacidades";

// O perfil `connected` no BANCO (spec 33, F1): um serviço externo que lê/altera áreas do CRM. O
// banco diz o mesmo que `lib/extensions/manifest.ts`: só permissão de área, sem dados, sem card nem
// tema; e o endereço do serviço (`service_origin`) mora só na ENTRADA do catálogo revisado, nunca no
// pacote, e só para pacote `connected`. Sem isto o TypeScript aceitaria o que o banco recusa (ou o
// contrário), e a divergência apareceria na instalação, na frente de quem paga.
if (!process.env.TEST_DB_PORT) throw new Error("TEST_DB_PORT ausente — execute pnpm test:db");
const pool = new Pool({
  connectionString: `postgresql://postgres:postgres@127.0.0.1:${process.env.TEST_DB_PORT}/postgres`,
  max: 4,
});
const query = (text: string, values: unknown[] = []) => pool.query(text, values);
const hash = (v: unknown) => createHash("sha256").update(JSON.stringify(v)).digest("hex");

const dono = "c0ae0000-0000-4000-8000-000000000001";
const SERVICO = "https://servico.invariant.test";
let seq = 0;
const origem = () => `https://conectado-${++seq}.invariant.test`;

const display = {
  title: { "pt-BR": "Serviço externo" },
  summary: { "pt-BR": "Lê contatos do CRM" },
  category: "productivity",
  icon: "ListChecks",
};

/** Um manifesto `connected` mínimo e válido: só permissão de área, `data` none, sem card nem tema. */
function conectado(overrides: Record<string, unknown> = {}) {
  return {
    format_version: 1,
    profile: "connected",
    publisher: "conectado",
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
    ...overrides,
  };
}

/** Um manifesto `declarative` válido, para provar que ele não aceita `service_origin` de carona. */
function declarativo() {
  return {
    format_version: 1,
    profile: "declarative",
    publisher: "conectado",
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

/** A entrada do catálogo que corresponde ao manifesto: o catálogo anuncia, o pacote confirma. */
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

/** O caminho inteiro da instalação: admite o catálogo, prepara e conclui. O erro, se houver, vem de `finish_install`. */
async function instalar(m: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  const e = entrada(m, extra);
  const catalogo = (await admitir([e])).catalog_id as string;
  const preparo = await rpc("prepare_install", [
    dono, randomUUID(), catalogo, e.publisher, e.name, e.version, null,
  ]);
  return rpc("finish_install", [
    dono, preparo.id, JSON.stringify(m), e.sha256, e.byte_length, JSON.stringify(m),
  ]);
}

const instalacoes = async () =>
  (await query("select count(*)::int n from public.extension_installations where publisher = 'conectado'"))
    .rows[0].n as number;

async function limpar() {
  await query("delete from public.extension_operations where actor_id = $1", [dono]);
  await query("delete from public.extension_installations where publisher = 'conectado'");
  await query("delete from public.extension_catalogs where origin like 'https://conectado-%.invariant.test'");
  await query("delete from public.extension_artifacts where manifest->>'publisher' = 'conectado'");
}

beforeAll(async () => {
  await query("insert into auth.users(id, email) values ($1, $2) on conflict(id) do nothing", [
    dono,
    `${dono}@invariant.test`,
  ]);
  await query(
    `insert into platform_admins(user_id, granted_by, scope, mfa_required, reason)
     values ($1, $1, 'full', false, 'Teste do perfil connected')
     on conflict(user_id) do update set revoked_at = null, scope = 'full'`,
    [dono],
  );
});
beforeEach(limpar);
afterAll(async () => {
  await limpar();
  await pool.end();
});

describe("perfil connected: o catálogo admite a origem do serviço e o pacote instala", () => {
  it("entrada connected + service_origin é admitida e o manifesto connected válido instala", async () => {
    const recibo = await instalar(conectado(), { service_origin: SERVICO });

    expect(recibo.status).toBe("completed");
    expect(await instalacoes()).toBe(1);

    // A origem ficou na ENTRADA do catálogo revisado; o pacote (artefato) continua sem endereço.
    const gravado = (await query(
      `select c.snapshot->'entries'->0->>'service_origin' origem, a.document like '%service_origin%' no_pacote
         from public.extension_installations i
         join public.extension_catalogs c on c.id = i.catalog_id
         join public.extension_artifacts a on a.id = i.artifact_id
        where i.publisher = 'conectado'`,
    )).rows[0];
    expect(gravado).toMatchObject({ origem: SERVICO, no_pacote: false });
  });
});

describe("perfil connected: o banco recusa o que o manifesto connected não pode ser", () => {
  it("connected com navigation.tasks é recusado com extension_artifact_mismatch", async () => {
    // A entrada anuncia as mesmas permissões do pacote, então a admissão passa: quem recusa é a
    // conclusão da instalação, que sabe o perfil.
    await expect(
      instalar(conectado({ permissions: ["navigation.tasks"] }), { service_origin: SERVICO }),
    ).rejects.toThrow("extension_artifact_mismatch");
    expect(await instalacoes()).toBe(0);
  });

  it("connected que mistura permissão de área com outra é recusado", async () => {
    await expect(
      instalar(conectado({ permissions: ["area.contatos.leitura", "theme.apply"] }), {
        service_origin: SERVICO,
      }),
    ).rejects.toThrow("extension_artifact_mismatch");
    expect(await instalacoes()).toBe(0);
  });

  it("connected sem service_origin na entrada do catálogo é recusado", async () => {
    await expect(instalar(conectado())).rejects.toThrow("extension_artifact_mismatch");
    expect(await instalacoes()).toBe(0);
  });

  it("declarative com service_origin na entrada é recusado", async () => {
    // Ninguém põe endereço de serviço em pacote que não é conectado.
    await expect(instalar(declarativo(), { service_origin: SERVICO })).rejects.toThrow(
      "extension_artifact_mismatch",
    );
    expect(await instalacoes()).toBe(0);
  });

  it("controle: o mesmo declarative, sem service_origin, instala", async () => {
    // Sem este caso, o anterior poderia estar recusando o manifesto declarativo em si.
    const recibo = await instalar(declarativo());
    expect(recibo.status).toBe("completed");
  });
});

describe("perfil connected: service_origin só vale como origem exata", () => {
  it.each([
    ["com caminho", "https://servico.invariant.test/caminho"],
    ["com barra final", "https://servico.invariant.test/"],
    ["com credencial (@)", "https://usuario@servico.invariant.test"],
    ["com espaço", "https://servico .invariant.test"],
    ["com query", "https://servico.invariant.test?x=1"],
    ["com fragmento", "https://servico.invariant.test#f"],
    ["sem esquema http(s)", "ftp://servico.invariant.test"],
  ])("%s é recusado na admissão com extension_invalid_input", async (_nome, valor) => {
    await expect(admitir([entrada(conectado(), { service_origin: valor })])).rejects.toThrow(
      "extension_invalid_input",
    );
  });

  it("service_origin que não é texto é recusado na admissão", async () => {
    await expect(admitir([entrada(conectado(), { service_origin: 5 })])).rejects.toThrow(
      "extension_invalid_input",
    );
  });
});

describe("perfil connected: o vocabulário de permissões do banco tem as 32", () => {
  const validas = async (lista: unknown[]) =>
    (await rpc("permissoes_validas", [JSON.stringify(lista)])) as boolean;

  it("o TypeScript tem 32 e o banco aceita as 32 de uma vez", async () => {
    expect(EXTENSION_PERMISSIONS).toHaveLength(32);
    expect(await validas([...EXTENSION_PERMISSIONS])).toBe(true);
  });

  it("uma 33ª permissão é recusada, tanto desconhecida quanto repetida", async () => {
    expect(await validas([...EXTENSION_PERMISSIONS, "area.contatos.apagar"])).toBe(false);
    expect(await validas([...EXTENSION_PERMISSIONS, "navigation.tasks"])).toBe(false);
  });

  it("permissão repetida é recusada", async () => {
    expect(await validas(["area.contatos.leitura", "area.contatos.leitura"])).toBe(false);
  });

  it("lista vazia e permissão de área desconhecida são recusadas", async () => {
    expect(await validas([])).toBe(false);
    expect(await validas(["area.contatos.apagar"])).toBe(false);
  });
});
