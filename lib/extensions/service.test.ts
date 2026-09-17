import { createHash, randomUUID } from "node:crypto";

import { beforeEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, unknown>;
type Result = { data: unknown; error: { code?: string; message?: string } | null };

/**
 * PostgREST em memória: aplica os filtros que o serviço usa, na ordem em que ele os encadeia, e
 * registra cada `in` para a prova dos lotes. `limit` corta na ordem da tabela, como um `limit`
 * sem ordem faria no banco.
 */
function fakeClient(tables: Record<string, Row[]>, rpcs: Record<string, (args: Row) => Result> = {}) {
  const inCalls: Array<{ table: string; size: number }> = [];
  return {
    inCalls,
    from(table: string) {
      let rows = [...(tables[table] ?? [])];
      const builder = {
        select: () => builder,
        // Só as formas que o serviço usa: `coluna.eq.valor,coluna.is.null` e
        // `and(a.eq.x,b.eq.y),and(...)`.
        or: (filter: string) => {
          const casa = (row: Row, clause: string) => {
            const [column, op, ...rest] = clause.split(".");
            const value = rest.join(".");
            return op === "is" ? (row[column!] ?? null) === null : row[column!] === value;
          };
          const grupos = filter.startsWith("and(")
            ? filter.slice(4, -1).split("),and(").map((grupo) => grupo.split(","))
            : filter.split(",").map((clause) => [clause]);
          rows = rows.filter((row) => grupos.some((grupo) => grupo.every((clause) => casa(row, clause))));
          return builder;
        },
        order: () => builder,
        eq: (column: string, value: unknown) => ((rows = rows.filter((row) => row[column] === value)), builder),
        neq: (column: string, value: unknown) => ((rows = rows.filter((row) => row[column] !== value)), builder),
        is: (column: string, value: unknown) =>
          ((rows = rows.filter((row) => (row[column] ?? null) === value)), builder),
        not: (column: string, operator: string, value: unknown) => {
          if (operator === "in") {
            const excluded = String(value).replace(/^\(|\)$/g, "").split(",");
            rows = rows.filter((row) => !excluded.includes(String(row[column])));
          } else {
            rows = rows.filter((row) => (row[column] ?? null) !== value);
          }
          return builder;
        },
        in: (column: string, values: unknown[]) => {
          inCalls.push({ table, size: values.length });
          rows = rows.filter((row) => values.includes(row[column]));
          return builder;
        },
        limit: (count: number) => ((rows = rows.slice(0, count)), builder),
        maybeSingle: () => Promise.resolve({ data: rows[0] ?? null, error: null }),
        single: () => Promise.resolve({ data: rows[0] ?? null, error: null }),
        then: (resolve: (value: Result) => unknown, reject?: (reason: unknown) => unknown) =>
          Promise.resolve({ data: rows, error: null }).then(resolve, reject),
      };
      return builder;
    },
    rpcCalls: [] as Array<{ name: string; args: Row }>,
    rpc(name: string, args: Row) {
      this.rpcCalls.push({ name, args });
      return Promise.resolve(rpcs[name]?.(args) ?? { data: [], error: null });
    },
  };
}

const mocks = vi.hoisted(() => ({
  admin: null as unknown,
  session: null as unknown,
  audit: vi.fn(),
  auditForOrganizations: vi.fn(),
  warn: vi.fn(),
  platform: vi.fn(),
}));
vi.mock("@/lib/env", () => ({
  env: { EXTENSIONS_LOCAL_CATALOG_ORIGIN: "", NEXT_PUBLIC_APP_URL: "http://localhost:3000" },
}));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => mocks.admin }));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => mocks.session }));
vi.mock("@/lib/audit", () => ({
  audit: mocks.audit,
  auditForOrganizations: mocks.auditForOrganizations,
}));
vi.mock("@/lib/logger", () => ({ logger: { warn: mocks.warn, error: vi.fn(), info: vi.fn() } }));
vi.mock("@/lib/auth/server", () => ({
  loadAuthUser: vi.fn(),
  mfaEmDivida: vi.fn(),
  sessionAal: vi.fn(),
}));
vi.mock("./http", async (importOriginal) => ({
  ...(await importOriginal<typeof HttpModule>()),
  requireExtensionPlatformFor: () => mocks.platform(),
}));

import type { ActiveOrg, AuthUser } from "@/lib/auth/types";

import type * as HttpModule from "./http";

import { MOTIVO_PACOTE_ILEGIVEL } from "./instalada";
import {
  configureExtension,
  listExtensions,
  readExtensionOperation,
  removeExtension,
  revertExtension,
} from "./service";

const ORG_A = randomUUID();
const ORG_B = randomUUID();
const ACTOR = randomUUID();
const CATALOG = randomUUID();
const USER = { id: ACTOR, is_platform_admin: true, support: null } as unknown as AuthUser;
const ORG = { orgId: ORG_A, role: "admin" } as unknown as ActiveOrg;

function artifact(name: string, version = "1.0.0"): Row {
  const manifest = {
    format_version: 1,
    profile: "declarative",
    publisher: "acme",
    name,
    version,
    license: "MIT",
    host_api: { min: 1, max: 1 },
    permissions: ["navigation.tasks"],
    dependencies: [],
    data: { mode: "none" },
    display: {
      title: { "pt-BR": `Guia ${name}` },
      summary: { "pt-BR": "Orientações para o trabalho." },
      category: "productivity",
      icon: "ListChecks",
    },
    configuration: { density: "comfortable", show_description: true },
    contributions: {
      crm_cards: [
        {
          id: "primeiros-passos",
          title: { "pt-BR": "Primeiros passos" },
          description: { "pt-BR": "Abra a lista de tarefas." },
          icon: "BookOpen",
          blocks: [{ heading: { "pt-BR": "Comece" }, body: { "pt-BR": "Revise as tarefas." } }],
          action: { label: { "pt-BR": "Abrir tarefas" }, capability: "tasks.open" },
        },
      ],
    },
  };
  const document = JSON.stringify(manifest);
  return {
    id: randomUUID(),
    sha256: createHash("sha256").update(document).digest("hex"),
    byte_length: Buffer.byteLength(document),
    manifest,
    document,
  };
}

function installationRow(artifactRow: Row, overrides: Row = {}): Row {
  return {
    id: randomUUID(),
    catalog_id: CATALOG,
    artifact_id: artifactRow.id,
    previous_artifact_id: null,
    publisher: "acme",
    name: (artifactRow.manifest as { name: string }).name,
    version: (artifactRow.manifest as { version: string }).version,
    revision: 1,
    removed_at: null,
    ...overrides,
  };
}

function operationRow(overrides: Row = {}): Row {
  return {
    id: randomUUID(),
    kind: "install",
    status: "completed",
    actor_id: ACTOR,
    organization_id: null,
    catalog_id: CATALOG,
    installation_id: null,
    publisher: "acme",
    name: "guia",
    version: "1.0.0",
    entry: null,
    result: null,
    error_code: null,
    created_at: "2026-09-16T10:00:00.000Z",
    updated_at: "2026-09-16T10:00:00.000Z",
    ...overrides,
  };
}

const catalogRow = {
  id: CATALOG,
  origin: "https://catalogo.example",
  revision: 1,
  digest: "a".repeat(64),
  snapshot: { format_version: 1, origin: "https://catalogo.example", revision: 1, entries: [] },
  admitted_at: "2026-09-16T09:00:00.000Z",
};

beforeEach(() => {
  mocks.audit.mockReset();
  mocks.auditForOrganizations.mockReset();
  mocks.warn.mockReset();
  mocks.platform.mockReset();
  mocks.platform.mockResolvedValue({ ok: true });
  mocks.session = fakeClient({});
});

describe("listExtensions", () => {
  it("com mais de 128 artefatos gravados, nenhuma instalação vigente vira pacote ilegível", async () => {
    // Versões antigas primeiro, na ordem da tabela: um `limit(128)` sem filtro as leria no lugar
    // das vigentes, que apareciam "Incompatível" sem motivo real.
    const antigos = Array.from({ length: 60 }, (_, index) => artifact(`antigo-${index}`));
    const vigentes = Array.from({ length: 70 }, (_, index) => artifact(`guia-${index}`, "1.1.0"));
    const anterior = artifact("guia-0", "1.0.0");
    const installations = vigentes.map((row, index) =>
      installationRow(row, index === 0 ? { previous_artifact_id: anterior.id, revision: 2 } : {}),
    );
    const admin = fakeClient({
      extension_catalogs: [catalogRow],
      extension_artifacts: [...antigos, anterior, ...vigentes],
      extension_installations: installations,
      extension_operations: [],
    });
    mocks.admin = admin;

    const view = await listExtensions(USER, ORG);

    expect(view.installations).toHaveLength(70);
    expect(view.installations.filter((item) => !item.compatible)).toEqual([]);
    expect(view.installations.some((item) => item.compatibility_reason === MOTIVO_PACOTE_ILEGIVEL)).toBe(false);
    // A contagem entre organizações leva o ator, que o banco confere.
    expect(admin.rpcCalls).toContainEqual({
      name: "fn_extensions_installation_counts",
      args: { p_actor: ACTOR },
    });
    expect(view.installations[0]).toMatchObject({
      installation_revision: 2,
      previous: { version: "1.0.0", compatible: true, in_catalog: false },
      active_organizations: 0,
    });
    const artifactReads = admin.inCalls.filter((call) => call.table === "extension_artifacts");
    expect(artifactReads.length).toBeGreaterThan(1);
    expect(Math.max(...artifactReads.map((call) => call.size))).toBeLessThanOrEqual(64);
  });

  it("um recibo de tipo que esta versão não conhece sai da lista, e a gestão continua de pé", async () => {
    const conhecido = operationRow();
    const futuro = operationRow({ kind: "migration" });
    mocks.admin = fakeClient({
      extension_catalogs: [catalogRow],
      extension_artifacts: [],
      extension_installations: [],
      extension_operations: [futuro, conhecido],
    });

    const view = await listExtensions(USER, ORG);

    expect(view.operations.map((item) => item.id)).toEqual([conhecido.id]);
    expect(mocks.warn).toHaveBeenCalledWith("[extensions] recibo de versão mais nova", {
      operation_id: futuro.id,
    });
  });

  it("quem administra a instalação lê recibos da plataforma e da organização ativa, nunca os de outra", async () => {
    const daPlataforma = operationRow({ kind: "removal" });
    const daAtiva = operationRow({ kind: "configure", organization_id: ORG_A });
    const deOutra = operationRow({ kind: "configure", organization_id: ORG_B });
    mocks.admin = fakeClient({ extension_operations: [daPlataforma, daAtiva, deOutra] });

    expect((await readExtensionOperation(daPlataforma.id as string, ORG_A, true)).id).toBe(daPlataforma.id);
    expect((await readExtensionOperation(daAtiva.id as string, ORG_A, true)).id).toBe(daAtiva.id);
    await expect(readExtensionOperation(deOutra.id as string, ORG_A, true)).rejects.toMatchObject({
      code: "extension_operation_not_found",
      status: 404,
    });
  });

  it("a leitura direta desse recibo responde 409 legível, não 422 de validação", async () => {
    const futuro = operationRow({ status: "rolled_back" });
    mocks.admin = fakeClient({ extension_operations: [futuro] });

    await expect(readExtensionOperation(futuro.id as string, null, true)).rejects.toMatchObject({
      code: "extension_operation_unreadable",
      status: 409,
    });
  });
});

describe("listExtensions: removidas e conferência da plataforma", () => {
  it("uma removida antiga continua reinstalável: a busca é pelas identidades do catálogo, não pelas mais recentes", async () => {
    // 150 removidas; a listada no catálogo é a MAIS ANTIGA e a ÚLTIMA na ordem da tabela, fora de
    // um corte das 128 mais recentes (o PostgREST em memória corta `limit` na ordem da tabela).
    // Sem ela na view, a tela pedia a instalação com revisão nula e o banco respondia "mudou em
    // outra sessão" para sempre.
    const removidas = Array.from({ length: 150 }, (_, index) =>
      installationRow(artifact(`removida-${index}`), {
        revision: 3,
        removed_at: new Date(Date.UTC(2026, 8, 16, 12, 0, 0) - index * 60_000).toISOString(),
      }),
    );
    const listada = artifact("removida-149");
    const manifesto = listada.manifest as Record<string, unknown>;
    const entrada = {
      publisher: manifesto.publisher,
      name: manifesto.name,
      version: manifesto.version,
      license: manifesto.license,
      host_api: manifesto.host_api,
      display: manifesto.display,
      permissions: manifesto.permissions,
      sha256: listada.sha256,
      byte_length: listada.byte_length,
    };
    mocks.admin = fakeClient({
      extension_catalogs: [{ ...catalogRow, snapshot: { ...catalogRow.snapshot, entries: [entrada] } }],
      extension_artifacts: [],
      extension_installations: removidas,
      extension_operations: [],
    });

    const view = await listExtensions(USER, ORG);

    expect(view.catalogs[0]?.entries).toHaveLength(1);
    expect(view.removed_installations).toEqual([
      expect.objectContaining({ id: removidas[149]!.id, name: "removida-149", revision: 3 }),
    ]);
  });

  it("as reinstaladas não ocupam o corte dos cards Removida da organização", async () => {
    // 130 vínculos marcados pela remoção: 10 de instalações já reinstaladas (ativas) primeiro, e
    // 120 de removidas. Filtradas DEPOIS do corte, as reinstaladas escondiam duas removidas.
    const ativas = Array.from({ length: 10 }, (_, index) => installationRow(artifact(`ativa-${index}`)));
    const removidas = Array.from({ length: 120 }, (_, index) =>
      installationRow(artifact(`fora-${index}`), { revision: 2, removed_at: "2026-09-10T10:00:00.000Z" }),
    );
    const marca = (installation: Row) => ({
      organization_id: ORG_A,
      installation_id: installation.id,
      enabled: false,
      configuration: { density: "comfortable", show_description: true },
      revision: 2,
      deactivated_by_removal_at: "2026-09-10T10:00:00.000Z",
    });
    mocks.admin = fakeClient({
      extension_catalogs: [catalogRow],
      extension_artifacts: [],
      extension_installations: [...ativas, ...removidas],
      extension_operations: [],
    });
    mocks.session = fakeClient({ organization_extensions: [...ativas, ...removidas].map(marca) });

    const view = await listExtensions(USER, ORG);

    expect(view.installations.filter((item) => item.removed_at !== null)).toHaveLength(120);
    expect(view.installations.filter((item) => item.removed_at === null)).toHaveLength(10);
  });

  it("duas versões da mesma identidade em lotes diferentes não duplicam a removida", async () => {
    // 20 identidades com duas versões cada: 40 entradas, todas as 1.0.0 antes das 1.1.0. A
    // identidade removida tem a 1.0.0 na posição 7 e a 1.1.0 na 27: se o lote fosse por entrada
    // (16), as duas versões cairiam em lotes diferentes e a removida sairia duas vezes.
    const entradas = ["1.0.0", "1.1.0"].flatMap((version) =>
      Array.from({ length: 20 }, (_, index) => index).map((index) => {
        const item = artifact(`dupla-${index}`, version);
        const manifesto = item.manifest as Record<string, unknown>;
        return {
          publisher: manifesto.publisher,
          name: manifesto.name,
          version,
          license: manifesto.license,
          host_api: manifesto.host_api,
          display: manifesto.display,
          permissions: manifesto.permissions,
          sha256: item.sha256,
          byte_length: item.byte_length,
        };
      }),
    );
    const removida = installationRow(artifact("dupla-7"), { revision: 3, removed_at: "2026-09-10T10:00:00.000Z" });
    const admin = fakeClient({
      extension_catalogs: [{ ...catalogRow, snapshot: { ...catalogRow.snapshot, entries: entradas } }],
      extension_artifacts: [],
      extension_installations: [removida],
      extension_operations: [],
    });
    mocks.admin = admin;

    const view = await listExtensions(USER, ORG);

    expect(view.removed_installations.map((item) => item.id)).toEqual([removida.id]);
  });

  it("falha ao conferir a plataforma é erro, e não a gestão de um membro comum", async () => {
    mocks.admin = fakeClient({ extension_catalogs: [catalogRow] });
    mocks.platform.mockResolvedValue({ ok: false, response: new Response(null, { status: 503 }) });
    await expect(listExtensions(USER, ORG)).rejects.toMatchObject({
      code: "upstream_unavailable",
      status: 503,
    });

    mocks.platform.mockResolvedValue({ ok: false, response: new Response(null, { status: 403 }) });
    expect((await listExtensions(USER, ORG)).can_install).toBe(false);
  });
});

describe("falha do banco sem código conhecido", () => {
  it("fica registrada com a causa do banco, e o erro de domínio esperado não vira ruído no log", async () => {
    let resposta: Result = {
      data: null,
      error: { code: "42P01", message: 'relation "public.extension_installations" does not exist' },
    };
    mocks.admin = fakeClient({}, { fn_extensions_remove_installation: () => resposta });

    await expect(
      removeExtension(ACTOR, randomUUID(), randomUUID(), { expected_installation_revision: 1 }),
    ).rejects.toMatchObject({ code: "upstream_unavailable", status: 503 });
    expect(mocks.warn).toHaveBeenCalledWith("[extensions] falha do banco sem código conhecido", {
      db_code: "42P01",
      detail: 'relation "public.extension_installations" does not exist',
    });

    // Controle: um código que a migration levanta de propósito é resposta, não falha a investigar.
    mocks.warn.mockReset();
    resposta = { data: null, error: { code: "P0001", message: "extension_removed" } };
    await expect(
      removeExtension(ACTOR, randomUUID(), randomUUID(), { expected_installation_revision: 1 }),
    ).rejects.toMatchObject({ code: "extension_removed", status: 410 });
    expect(mocks.warn).not.toHaveBeenCalled();
  });
});

describe("auditoria só quando a chamada fez a transição", () => {
  it("remover grava a linha da instância e uma por organização desligada; a repetição não grava", async () => {
    const installation = randomUUID();
    let aplicado = true;
    mocks.admin = fakeClient({}, {
      fn_extensions_remove_installation: () => ({
        data: {
          ...operationRow({
            kind: "removal",
            installation_id: installation,
            result: {
              from_revision: 3,
              from_version: "1.0.0",
              organizations_disabled: [ORG_A, ORG_B],
              organizations_disabled_count: 2,
            },
          }),
          applied_now: aplicado,
        },
        error: null,
      }),
    });

    const recibo = await removeExtension(ACTOR, randomUUID(), installation, {
      expected_installation_revision: 3,
    });
    expect(recibo).toMatchObject({ kind: "removal", organizations_affected: 2, from_revision: 3 });
    expect(mocks.audit).toHaveBeenCalledTimes(1);
    expect(mocks.audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "extension.removed",
        metadata: expect.objectContaining({ organizations_disabled_count: 2 }),
      }),
    );
    expect(mocks.auditForOrganizations).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "extension.deactivated_by_removal",
        metadata: expect.objectContaining({ reason: "installation_removed" }),
      }),
      [ORG_A, ORG_B],
    );

    aplicado = false;
    mocks.audit.mockReset();
    mocks.auditForOrganizations.mockReset();
    await removeExtension(ACTOR, randomUUID(), installation, { expected_installation_revision: 3 });
    expect(mocks.audit).not.toHaveBeenCalled();
    expect(mocks.auditForOrganizations).not.toHaveBeenCalled();
  });

  it("desfazer projeta a contagem de organizações ativas no recibo e na auditoria, inclusive zero", async () => {
    const installation = randomUUID();
    for (const ativas of [3, 0]) {
      mocks.audit.mockReset();
      mocks.admin = fakeClient({}, {
        fn_extensions_revert_install: () => ({
          data: {
            ...operationRow({
              kind: "revert",
              installation_id: installation,
              result: { from_revision: 2, from_version: "1.1.0", to_version: "1.0.0", organizations_active: ativas },
            }),
            applied_now: true,
          },
          error: null,
        }),
      });
      const recibo = await revertExtension(ACTOR, randomUUID(), installation, { expected_installation_revision: 2 });
      expect(recibo).toMatchObject({ kind: "revert", organizations_affected: ativas, to_version: "1.0.0" });
      expect(mocks.audit).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "extension.reverted",
          metadata: expect.objectContaining({ organizations_active: ativas }),
        }),
      );
    }
  });

  it("configurar repetido com a mesma chave não grava uma segunda linha", async () => {
    const installation = randomUUID();
    mocks.admin = fakeClient({}, {
      fn_extensions_configure: () => ({
        data: {
          ...operationRow({ kind: "configure", organization_id: ORG_A, installation_id: installation }),
          applied_now: false,
        },
        error: null,
      }),
    });

    await configureExtension(ACTOR, ORG_A, installation, randomUUID(), {
      expected_revision: 1,
      enabled: false,
      configuration: { density: "compact", show_description: true },
    });
    expect(mocks.audit).not.toHaveBeenCalled();
  });
});
