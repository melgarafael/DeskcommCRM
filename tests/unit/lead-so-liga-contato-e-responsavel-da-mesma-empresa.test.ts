// @vitest-environment node
//
// O LEAD SÓ SE LIGA A CONTATO E RESPONSÁVEL DA PRÓPRIA EMPRESA.
//
// `crm_leads_contact_id_fkey` referencia só `contacts(id)` e a FK de
// `owner_user_id` só garante que a pessoa existe: nenhuma das duas pergunta de
// QUAL organização. Antes deste conserto, `createLeadHandler` e
// `updateLeadHandler` gravavam o `contact_id` e o `owner_user_id` do corpo sem
// perguntar — só `owner_agent_id` era conferido. Um uuid inexistente virava 500
// com a mensagem da FK.
//
// O banco falso daqui FILTRA de verdade pelos `.eq`/`.is` que o handler monta:
// um handler que esquecer o filtro de `organization_id` encontra o contato da
// outra empresa, e o caso reprova.

import { beforeEach, describe, expect, it, vi } from "vitest";

type Linha = Record<string, unknown>;

const ORG_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ORG_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const PIPELINE = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const ETAPA = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const LEAD = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";

const CONTATO_A = "10000000-0000-4000-8000-00000000000a";
const CONTATO_B = "10000000-0000-4000-8000-00000000000b";
const CONTATO_INEXISTENTE = "10000000-0000-4000-8000-000000000000";

const ATENDENTE_A = "20000000-0000-4000-8000-00000000000a";
const MEMBRO_B = "20000000-0000-4000-8000-00000000000b";
const DESLIGADO_A = "20000000-0000-4000-8000-0000000000de";
const VIEWER_A = "20000000-0000-4000-8000-0000000000ee";

const tabelas: Record<string, Linha[]> = {};
const escritas: { tabela: string; tipo: "insert" | "update"; valores: Linha }[] = [];
/** Recusa que o "banco" devolve na próxima escrita — o gatilho da migration 0403. */
let recusaDoGatilho: { code: string; message: string } | null = null;

function reiniciaBanco() {
  tabelas.crm_stages = [{ id: ETAPA, pipeline_id: PIPELINE, organization_id: ORG_A }];
  tabelas.organizations = [{ id: ORG_A, currency: "BRL" }];
  tabelas.contacts = [
    { id: CONTATO_A, organization_id: ORG_A },
    { id: CONTATO_B, organization_id: ORG_B },
  ];
  tabelas.user_organizations = [
    { user_id: ATENDENTE_A, organization_id: ORG_A, role: "agent", revoked_at: null },
    { user_id: MEMBRO_B, organization_id: ORG_B, role: "admin", revoked_at: null },
    { user_id: DESLIGADO_A, organization_id: ORG_A, role: "agent", revoked_at: "2026-09-01T00:00:00Z" },
    { user_id: VIEWER_A, organization_id: ORG_A, role: "viewer", revoked_at: null },
  ];
  tabelas.crm_leads = [
    {
      id: LEAD,
      organization_id: ORG_A,
      contact_id: null,
      owner_user_id: DESLIGADO_A,
      owner_agent_id: null,
      owner_kind: "user",
      title: "Negócio",
      tags: [],
      custom_fields: {},
    },
  ];
  escritas.length = 0;
  recusaDoGatilho = null;
}

/** Consulta encadeável que aplica de fato os filtros `.eq`/`.is`. */
function consulta(tabela: string) {
  const filtros: [string, unknown][] = [];
  let escrita: { tipo: "insert" | "update"; valores: Linha } | null = null;
  const linhas = () =>
    (tabelas[tabela] ?? []).filter((l) => filtros.every(([c, v]) => (l[c] ?? null) === v));
  const resolve = async () => {
    if (escrita && recusaDoGatilho) return { data: null, error: recusaDoGatilho };
    if (escrita?.tipo === "insert") {
      escritas.push({ tabela, ...escrita });
      return { data: { id: "lead-novo", ...escrita.valores }, error: null };
    }
    if (escrita?.tipo === "update") {
      const alvo = linhas()[0];
      if (!alvo) return { data: null, error: null };
      escritas.push({ tabela, ...escrita });
      return { data: { ...alvo, ...escrita.valores }, error: null };
    }
    return { data: linhas()[0] ?? null, error: null };
  };
  const q: Record<string, unknown> = {
    select: () => q,
    eq: (c: string, v: unknown) => (filtros.push([c, v]), q),
    is: (c: string, v: unknown) => (filtros.push([c, v]), q),
    order: () => q,
    limit: () => q,
    insert: (valores: Linha) => ((escrita = { tipo: "insert", valores }), q),
    update: (valores: Linha) => ((escrita = { tipo: "update", valores }), q),
    maybeSingle: resolve,
    single: resolve,
  };
  return q;
}

const banco = {
  from: (t: string) => consulta(t),
  rpc: () => Promise.resolve({ error: null }),
};

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => banco }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));
vi.mock("@/lib/atendimento/origem", () => ({ observeServiceOrigin: async () => "humano" }));
vi.mock("@/lib/leads/activity-emitter", () => ({
  emitLeadActivity: vi.fn(async () => ({ ok: true })),
  stageChangeReason: () => "movido",
}));

import { createLeadHandler, updateLeadHandler } from "@/app/api/v1/leads/_handler";
import { emitLeadActivity } from "@/lib/leads/activity-emitter";
import { montaPayloadDoClone, type OrigemParaClonar } from "@/lib/leads/clonar-para-funil";
import { crmCreateLead, crmUpdateLead } from "@/lib/mcp/tools/leads";

const ctx = {
  organization_id: ORG_A,
  actor: { type: "user" as const, id: ATENDENTE_A },
  requestId: "req-1",
};
const ctxMcp = {
  supabase: banco,
  organizationId: ORG_A,
  actor: { type: "user", id: ATENDENTE_A },
  requestId: "req-1",
} as never;

const novo = (extra: Linha = {}) =>
  ({ pipeline_id: PIPELINE, stage_id: ETAPA, title: "Lead", tags: [], source: "manual", ...extra }) as never;

const leadsGravados = () => escritas.filter((e) => e.tabela === "crm_leads");
const primeiroLead = () => {
  const [lead] = leadsGravados();
  if (!lead) throw new Error("nenhuma escrita em crm_leads");
  return lead;
};

beforeEach(() => {
  reiniciaBanco();
  vi.mocked(emitLeadActivity).mockClear();
});

describe("createLeadHandler — contato", () => {
  it("contato de OUTRA empresa: 404, e nada é gravado", async () => {
    await expect(
      createLeadHandler(banco as never, ctx, novo({ contact_id: CONTATO_B })),
    ).rejects.toMatchObject({ status: 404, code: "not_found" });
    expect(leadsGravados()).toHaveLength(0);
  });

  it("uuid que não existe: o MESMO 404 (não confirma existência alheia, e não é 500 da FK)", async () => {
    const recusaB = await createLeadHandler(banco as never, ctx, novo({ contact_id: CONTATO_B })).catch((e) => e);
    const recusaInexistente = await createLeadHandler(
      banco as never,
      ctx,
      novo({ contact_id: CONTATO_INEXISTENTE }),
    ).catch((e) => e);
    expect([recusaInexistente.status, recusaInexistente.code, recusaInexistente.message]).toEqual([
      recusaB.status,
      recusaB.code,
      recusaB.message,
    ]);
    expect(leadsGravados()).toHaveLength(0);
  });

  it("contato da própria empresa: grava com o contato", async () => {
    await createLeadHandler(banco as never, ctx, novo({ contact_id: CONTATO_A }));
    expect(leadsGravados()).toHaveLength(1);
    expect(primeiroLead().valores).toMatchObject({ contact_id: CONTATO_A, organization_id: ORG_A });
  });
});

describe("createLeadHandler — responsável", () => {
  it.each([
    ["membro de outra empresa", MEMBRO_B],
    ["desligado da empresa", DESLIGADO_A],
    ["viewer (não atende)", VIEWER_A],
  ])("%s: 422, e nada é gravado", async (_nome, dono) => {
    await expect(
      createLeadHandler(banco as never, ctx, novo({ owner_user_id: dono })),
    ).rejects.toMatchObject({ status: 422, code: "validation_failed" });
    expect(leadsGravados()).toHaveLength(0);
  });

  it("atendente ativo da própria empresa: grava com o responsável", async () => {
    await createLeadHandler(banco as never, ctx, novo({ owner_user_id: ATENDENTE_A }));
    expect(primeiroLead().valores).toMatchObject({ owner_user_id: ATENDENTE_A, owner_kind: "user" });
  });
});

describe("updateLeadHandler", () => {
  it("contato de outra empresa: 404, e o lead não é tocado", async () => {
    await expect(
      updateLeadHandler(banco as never, ctx, LEAD, { contact_id: CONTATO_B } as never),
    ).rejects.toMatchObject({ status: 404, code: "not_found" });
    expect(leadsGravados()).toHaveLength(0);
  });

  it("responsável de outra empresa: 422, e o lead não é tocado", async () => {
    await expect(
      updateLeadHandler(banco as never, ctx, LEAD, { owner_user_id: MEMBRO_B } as never),
    ).rejects.toMatchObject({ status: 422, code: "validation_failed" });
    expect(leadsGravados()).toHaveLength(0);
  });

  it("contato e responsável da própria empresa: grava", async () => {
    await updateLeadHandler(banco as never, ctx, LEAD, {
      contact_id: CONTATO_A,
      owner_user_id: ATENDENTE_A,
    } as never);
    expect(primeiroLead().valores).toMatchObject({ contact_id: CONTATO_A, owner_user_id: ATENDENTE_A });
  });

  it("reenviar o responsável que o lead JÁ tem (mesmo desligado) não trava a edição", async () => {
    await updateLeadHandler(banco as never, ctx, LEAD, {
      title: "Negócio renomeado",
      owner_user_id: DESLIGADO_A,
    } as never);
    expect(primeiroLead().valores).toMatchObject({ title: "Negócio renomeado" });
  });
});

describe("pelo MCP (crm_create_lead / crm_update_lead passam pelo handler)", () => {
  it("crm_create_lead com contato de outra empresa: 404, nada gravado", async () => {
    await expect(
      crmCreateLead.handler(
        { pipeline_id: PIPELINE, stage_id: ETAPA, title: "Pelo agente", contact_id: CONTATO_B } as never,
        ctxMcp,
      ),
    ).rejects.toMatchObject({ status: 404 });
    expect(leadsGravados()).toHaveLength(0);
  });

  it("crm_update_lead com contato ou responsável de outra empresa: recusado, nada gravado", async () => {
    await expect(
      crmUpdateLead.handler({ lead_id: LEAD, contact_id: CONTATO_B } as never, ctxMcp),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      crmUpdateLead.handler({ lead_id: LEAD, owner_user_id: MEMBRO_B } as never, ctxMcp),
    ).rejects.toMatchObject({ status: 422 });
    expect(leadsGravados()).toHaveLength(0);
  });
});

describe("a recusa do gatilho do banco (migration 0403) vira a mesma resposta, não 500", () => {
  it("PT404 no INSERT → 404 Contato não encontrado", async () => {
    recusaDoGatilho = { code: "PT404", message: "Contato não encontrado." };
    await expect(createLeadHandler(banco as never, ctx, novo())).rejects.toMatchObject({
      status: 404,
      code: "not_found",
    });
  });

  it("PT422 no UPDATE → 422 validation_failed", async () => {
    recusaDoGatilho = { code: "PT422", message: "Responsável não é um atendente ativo desta organização." };
    await expect(
      updateLeadHandler(banco as never, ctx, LEAD, { title: "Outro título" } as never),
    ).rejects.toMatchObject({ status: 422, code: "validation_failed" });
  });
});

describe("clone para outro funil: o dono vem da ORIGEM", () => {
  const origem = (dono: string): OrigemParaClonar =>
    ({
      id: LEAD,
      pipeline_id: "ffffffff-ffff-4fff-8fff-ffffffffffff",
      status: "open",
      title: "Negócio",
      contact_id: CONTATO_A,
      owner_user_id: dono,
      owner_agent_id: null,
    }) as OrigemParaClonar;
  const etapa = { id: ETAPA, pipeline_id: PIPELINE } as never;

  it("dono desligado: o clone nasce SEM dono, e a linha do tempo diz por quê — nunca 422", async () => {
    await createLeadHandler(banco as never, ctx, montaPayloadDoClone(origem(DESLIGADO_A), etapa));
    expect(leadsGravados()).toHaveLength(1);
    expect(primeiroLead().valores).toMatchObject({
      owner_user_id: null,
      owner_agent_id: null,
      owner_kind: null,
      contact_id: CONTATO_A,
    });
    expect(vi.mocked(emitLeadActivity)).toHaveBeenCalledWith(
      banco,
      expect.objectContaining({ type: "lead_edited", reason: expect.stringContaining("sem responsável") }),
    );
  });

  it("dono ainda ativo: o clone mantém o dono, sem atividade extra", async () => {
    await createLeadHandler(banco as never, ctx, montaPayloadDoClone(origem(ATENDENTE_A), etapa));
    expect(primeiroLead().valores).toMatchObject({ owner_user_id: ATENDENTE_A, owner_kind: "user" });
    expect(vi.mocked(emitLeadActivity)).not.toHaveBeenCalled();
  });

  it("fora do clone, o mesmo dono desligado continua recusado (422)", async () => {
    await expect(
      createLeadHandler(banco as never, ctx, novo({ owner_user_id: DESLIGADO_A })),
    ).rejects.toMatchObject({ status: 422 });
  });
});
