import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { audit } from "@/lib/audit";
import { fail } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";

vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));

import {
  ORG_ID,
  OUTRA_ORG,
  PIPE,
  authOk,
  etapa,
  funilRow,
  makeDb,
  negocio,
} from "@/tests/helpers/stages-db-double";

// Dois funis: o de origem (`PIPE`, o padrão) e o de destino.
const DESTINO = "77777777-7777-4777-8777-777777777777";
const CONTATO = "88888888-8888-4888-8888-888888888888";
// ⚠️ UUIDs DE VERDADE: o corpo da rota é Zod com `.uuid()`, e um id de mentira
// (`"e-andamento"`) reprovaria ANTES da regra que o teste quer exercitar — o 422
// viria do schema, não da etapa de fechamento.
const ETAPA_NOVO = "99999999-9999-4999-8999-999999999991";
const ETAPA_ANDAMENTO = "99999999-9999-4999-8999-999999999992";
const ETAPA_GANHO = "99999999-9999-4999-8999-999999999993";

const ctx = (id = PIPE) => ({ params: Promise.resolve({ id }) });

const doisFunis = () => [
  funilRow({ id: PIPE, name: "Pedidos", slug: "pedidos", position: 1000, is_default: true }),
  funilRow({ id: DESTINO, name: "Clínica", slug: "clinica", position: 2000 }),
];

/**
 * As etapas do destino: GANHO vem PRIMEIRO por posição, de propósito.
 *
 * É o caso que separa "primeira etapa da lista" de "primeira etapa de ANDAMENTO":
 * sem o filtro de fechamento, a transferência encerraria todos os negócios ao
 * aterrissar em Ganho — e o teste do destino feliz passaria mesmo assim, porque a
 * etapa existiria. Ordenar o Ganho primeiro é o que faz a régua ser medida.
 */
const etapasDoDestino = () => [
  etapa({ id: ETAPA_GANHO, name: "Ganho", pipeline_id: DESTINO, position: 1000, is_won: true }),
  etapa({ id: ETAPA_NOVO, name: "Novo", pipeline_id: DESTINO, position: 2000 }),
  etapa({ id: ETAPA_ANDAMENTO, name: "Em andamento", pipeline_id: DESTINO, position: 3000 }),
];

const reqGet = (id = PIPE) =>
  new NextRequest(`http://localhost/api/v1/pipelines/${id}/negocios`, { method: "GET" });

function reqPost(body: unknown, id = PIPE) {
  return new NextRequest(`http://localhost/api/v1/pipelines/${id}/negocios`, {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("GET /api/v1/pipelines/[id]/negocios", () => {
  it("exige manager — é a mesma régua de arquivar", async () => {
    authOk();
    makeDb({ pipelines: doisFunis() });
    const { GET } = await import("./route");
    await GET(reqGet(), ctx());
    expect(vi.mocked(requireRole).mock.calls[0]?.[0]).toBe("manager");
  });

  it("sem auth → repassa a resposta", async () => {
    vi.mocked(requireRole).mockResolvedValue({
      ok: false,
      response: fail("unauthenticated", "Auth required.", 401, {}),
    });
    makeDb({ pipelines: doisFunis() });
    const { GET } = await import("./route");
    expect((await GET(reqGet(), ctx())).status).toBe(401);
  });

  it("conta os negócios do funil pela MESMA leitura que o DELETE usa", async () => {
    authOk();
    makeDb({
      pipelines: doisFunis(),
      stages: [etapa({ id: "e-origem", name: "Novo" })],
      leads: [
        negocio("l1", "e-origem"),
        negocio("l2", "e-origem"),
        negocio("l3", "e-origem"),
        // de outro funil: não pode entrar na conta
        negocio("l4", "e-novo", { pipeline_id: DESTINO }),
        // de outra organização: também não
        negocio("l5", "e-origem", { organization_id: OUTRA_ORG }),
      ],
    });
    const { GET } = await import("./route");
    const res = await GET(reqGet(), ctx());
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { negocios: number } };
    expect(body.data.negocios).toBe(3);
  });

  it("funil de outra organização → 404, sem contar nada", async () => {
    authOk();
    makeDb({ pipelines: [funilRow({ id: PIPE, name: "Pedidos", organization_id: OUTRA_ORG })] });
    const { GET } = await import("./route");
    expect((await GET(reqGet(), ctx())).status).toBe(404);
  });
});

describe("POST /api/v1/pipelines/[id]/negocios — transferir", () => {
  it("sem etapa escolhida, leva para a PRIMEIRA ETAPA DE ANDAMENTO do destino (nunca Ganho)", async () => {
    authOk();
    const db = makeDb({
      pipelines: doisFunis(),
      stages: [
        etapa({ id: "e-origem", name: "Novo" }),
        ...etapasDoDestino(),
      ],
      leads: [negocio("l1", "e-origem"), negocio("l2", "e-origem")],
    });

    const { POST } = await import("./route");
    const res = await POST(reqPost({ escolha: "transferir", funil_id: DESTINO }), ctx());

    expect(res.status).toBe(200);
    const rpc = db.rpcs.find((r) => r.nome === "fn_mover_leads_em_lote");
    expect(rpc).toBeTruthy();
    expect((rpc?.args as { p_stage_id: string }).p_stage_id).toBe(ETAPA_NOVO);
  });

  it("transferir para etapa ESPECÍFICA leva para ELA, não para a primeira do destino", async () => {
    authOk();
    const db = makeDb({
      pipelines: doisFunis(),
      stages: [etapa({ id: "e-origem", name: "Novo" }), ...etapasDoDestino()],
      leads: [negocio("l1", "e-origem")],
    });

    const { POST } = await import("./route");
    const res = await POST(
      reqPost({ escolha: "transferir", funil_id: DESTINO, etapa_id: ETAPA_ANDAMENTO }),
      ctx(),
    );

    expect(res.status).toBe(200);
    const rpc = db.rpcs.find((r) => r.nome === "fn_mover_leads_em_lote");
    expect((rpc?.args as { p_stage_id: string }).p_stage_id).toBe(ETAPA_ANDAMENTO);
    expect(db.tabelas.crm_leads.find((l) => l.id === "l1")?.stage_id).toBe(ETAPA_ANDAMENTO);
  });

  it("a contagem mostrada na confirmação é a do banco DEPOIS da operação", async () => {
    authOk();
    const db = makeDb({
      pipelines: doisFunis(),
      stages: [etapa({ id: "e-origem", name: "Novo" }), ...etapasDoDestino()],
      leads: [negocio("l1", "e-origem"), negocio("l2", "e-origem")],
    });

    const { GET, POST } = await import("./route");
    const antes = (await (await GET(reqGet(), ctx())).json()) as { data: { negocios: number } };
    expect(antes.data.negocios).toBe(2);

    const res = await POST(reqPost({ escolha: "transferir", funil_id: DESTINO }), ctx());
    const corpo = (await res.json()) as {
      data: { movidos: number; restantes: number; destino: { funil_id: string; etapa_id: string } };
    };

    expect(corpo.data.movidos).toBe(antes.data.negocios);
    expect(corpo.data.restantes).toBe(0);
    // E o banco concorda com a frase: nenhum negócio aponta mais para a origem.
    expect(db.tabelas.crm_leads.filter((l) => l.pipeline_id === PIPE)).toHaveLength(0);
    expect(db.tabelas.crm_leads.every((l) => l.pipeline_id === DESTINO)).toBe(true);
    expect(corpo.data.destino).toEqual({ funil_id: DESTINO, etapa_id: ETAPA_NOVO });
  });

  it("registra na auditoria quantos se moveram e para onde", async () => {
    authOk();
    makeDb({
      pipelines: doisFunis(),
      stages: [etapa({ id: "e-origem", name: "Novo" }), ...etapasDoDestino()],
      leads: [negocio("l1", "e-origem"), negocio("l2", "e-origem")],
    });

    const { POST } = await import("./route");
    await POST(reqPost({ escolha: "transferir", funil_id: DESTINO }), ctx());

    const chamada = vi.mocked(audit).mock.calls.at(-1)?.[0];
    expect(chamada?.action).toBe("pipeline.negocios_transferidos");
    expect(chamada?.metadata).toMatchObject({
      movidos: 2,
      restantes: 0,
      origem_pipeline_id: PIPE,
      destino_pipeline_id: DESTINO,
      destino_stage_id: ETAPA_NOVO,
    });
  });

  it("recusa transferir o funil para ele mesmo, sem escrever", async () => {
    authOk();
    const db = makeDb({
      pipelines: doisFunis(),
      stages: [etapa({ id: "e-origem", name: "Novo" })],
      leads: [negocio("l1", "e-origem")],
    });

    const { POST } = await import("./route");
    const res = await POST(reqPost({ escolha: "transferir", funil_id: PIPE }), ctx());

    expect(res.status).toBe(422);
    expect(db.rpcs.filter((r) => r.nome === "fn_mover_leads_em_lote")).toHaveLength(0);
    expect(db.escritas).toHaveLength(0);
  });

  it("recusa etapa de FECHAMENTO — transferir para lá encerraria todos os negócios", async () => {
    authOk();
    const db = makeDb({
      pipelines: doisFunis(),
      stages: [etapa({ id: "e-origem", name: "Novo" }), ...etapasDoDestino()],
      leads: [negocio("l1", "e-origem")],
    });

    const { POST } = await import("./route");
    const res = await POST(
      reqPost({ escolha: "transferir", funil_id: DESTINO, etapa_id: ETAPA_GANHO }),
      ctx(),
    );

    expect(res.status).toBe(422);
    expect(db.rpcs.filter((r) => r.nome === "fn_mover_leads_em_lote")).toHaveLength(0);
  });

  it("recusa funil de destino arquivado", async () => {
    authOk();
    const db = makeDb({
      pipelines: [
        ...doisFunis().map((f) => (f.id === DESTINO ? { ...f, is_archived: true } : f)),
      ],
      stages: [etapa({ id: "e-origem", name: "Novo" }), ...etapasDoDestino()],
      leads: [negocio("l1", "e-origem")],
    });

    const { POST } = await import("./route");
    const res = await POST(reqPost({ escolha: "transferir", funil_id: DESTINO }), ctx());
    expect(res.status).toBe(422);
    expect(db.rpcs.filter((r) => r.nome === "fn_mover_leads_em_lote")).toHaveLength(0);
  });
});

describe("POST /api/v1/pipelines/[id]/negocios — remover da estrutura", () => {
  it("apaga os negócios e NÃO apaga contato, conversa nem histórico", async () => {
    authOk();
    const db = makeDb({
      pipelines: doisFunis(),
      stages: [etapa({ id: "e-origem", name: "Novo" })],
      leads: [
        negocio("l1", "e-origem", { contact_id: CONTATO }),
        negocio("l2", "e-origem", { contact_id: CONTATO }),
      ],
      contacts: [{ id: CONTATO, organization_id: ORG_ID, name: "Ana" }],
      conversations: [{ id: "c1", organization_id: ORG_ID, contact_id: CONTATO }],
    });
    // O histórico comercial do negócio — é ele que o CASCADE levava junto antes
    // da migration desta fatia.
    db.tabelas.crm_lead_activities.push(
      { id: "a1", organization_id: ORG_ID, lead_id: "l1", contact_id: CONTATO, type: "stage_changed" },
      { id: "a2", organization_id: ORG_ID, lead_id: "l2", contact_id: CONTATO, type: "stage_changed" },
    );

    const { POST } = await import("./route");
    const res = await POST(reqPost({ escolha: "remover" }), ctx());
    const corpo = (await res.json()) as { data: { movidos: number; restantes: number } };

    expect(res.status).toBe(200);
    expect(corpo.data.movidos).toBe(2);
    expect(corpo.data.restantes).toBe(0);
    // Os negócios saíram da estrutura...
    expect(db.tabelas.crm_leads.filter((l) => l.pipeline_id === PIPE)).toHaveLength(0);
    // ...e o que a issue manda preservar continua lá.
    expect(db.tabelas.contacts).toHaveLength(1);
    expect(db.tabelas.conversations).toHaveLength(1);
    expect(db.tabelas.crm_lead_activities).toHaveLength(2);
  });

  it("registra a remoção na auditoria com o número medido", async () => {
    authOk();
    makeDb({
      pipelines: doisFunis(),
      stages: [etapa({ id: "e-origem", name: "Novo" })],
      leads: [negocio("l1", "e-origem")],
    });

    const { POST } = await import("./route");
    await POST(reqPost({ escolha: "remover" }), ctx());

    const chamada = vi.mocked(audit).mock.calls.at(-1)?.[0];
    expect(chamada?.action).toBe("pipeline.negocios_removidos");
    expect(chamada?.metadata).toMatchObject({ movidos: 1, restantes: 0, escolha: "remover" });
  });

  it("funil sem negócio responde 0 e não escreve — nada a fazer não é erro", async () => {
    authOk();
    const db = makeDb({ pipelines: doisFunis(), stages: [etapa({ id: "e-origem", name: "Novo" })] });

    const { POST } = await import("./route");
    const res = await POST(reqPost({ escolha: "remover" }), ctx());
    const corpo = (await res.json()) as { data: { movidos: number } };

    expect(res.status).toBe(200);
    expect(corpo.data.movidos).toBe(0);
    expect(db.escritas).toHaveLength(0);
  });

  it("corpo sem escolha válida → 422", async () => {
    authOk();
    makeDb({ pipelines: doisFunis() });
    const { POST } = await import("./route");
    expect((await POST(reqPost({ escolha: "cancelar" }), ctx())).status).toBe(422);
  });
});
