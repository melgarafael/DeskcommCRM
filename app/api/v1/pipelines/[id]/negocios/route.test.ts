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
  negocio as negocioDoDuble,
} from "@/tests/helpers/stages-db-double";

/**
 * O negócio do dublê nasce SEM `status`; no banco o padrão é `'open'`, e a
 * transferência lê só `status = 'open'` (doc 400, opção B). Quem quer encerrado
 * declara.
 */
const negocio: typeof negocioDoDuble = (id, stageId, over = {}) =>
  negocioDoDuble(id, stageId, { status: "open", ...over });

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
    const body = (await res.json()) as { data: { negocios: number; abertos: number } };
    expect(body.data.negocios).toBe(3);
    expect(body.data.abertos).toBe(3);
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

describe("POST /api/v1/pipelines/[id]/negocios — o pedido do #4852 (doc 400, opção B)", () => {
  /**
   * Só o negócio EM ANDAMENTO muda de funil. Ganho e perdido ficam no funil de
   * origem — ele abre em leitura depois de arquivado —, e o gatilho de
   * fechamento (P-02) segue sem exceção: por isso a rota nem os põe no lote.
   */
  it("(a) só os EM ANDAMENTO mudam de funil — o ganho fica no funil de origem, com a data", async () => {
    authOk();
    const FECHADO_EM = "2026-11-18T10:55:11.000Z";
    const db = makeDb({
      pipelines: doisFunis(),
      stages: [etapa({ id: "e-origem", name: "Novo" }), ...etapasDoDestino()],
      leads: [
        negocio("l-won", "e-origem", { status: "won", closed_at: FECHADO_EM }),
        negocio("l-open", "e-origem", { status: "open", closed_at: null }),
      ],
    });

    const { POST } = await import("./route");
    const res = await POST(reqPost({ escolha: "transferir", funil_id: DESTINO }), ctx());
    expect(res.status).toBe(200);

    const ganho = db.tabelas.crm_leads.find((l) => l.id === "l-won");
    expect(ganho?.status).toBe("won");
    expect(ganho?.closed_at).toBe(FECHADO_EM);
    // Não saiu do lugar: nem funil, nem etapa.
    expect(ganho?.pipeline_id).toBe(PIPE);
    expect(ganho?.stage_id).toBe("e-origem");
    // O aberto mudou de funil de verdade.
    const aberto = db.tabelas.crm_leads.find((l) => l.id === "l-open");
    expect(aberto?.pipeline_id).toBe(DESTINO);
    expect(aberto?.stage_id).toBe(ETAPA_NOVO);
    // O lote do banco recebeu só o aberto.
    const lote = db.rpcs.find((r) => r.nome === "fn_mover_leads_em_lote")?.args as { p_lead_ids: string[] };
    expect(lote.p_lead_ids).toEqual(["l-open"]);

    const corpo = (await res.json()) as { data: { movidos: number; restantes: number; encerrados_ficaram: number } };
    expect(corpo.data.movidos).toBe(1);
    expect(corpo.data.restantes).toBe(1);
    expect(corpo.data.encerrados_ficaram).toBe(1);
  });

  it("(a2) funil só com encerrados: nada se move, e a resposta diz que eles ficam", async () => {
    authOk();
    const db = makeDb({
      pipelines: doisFunis(),
      stages: [etapa({ id: "e-origem", name: "Novo" }), ...etapasDoDestino()],
      leads: [
        negocio("l-lost", "e-origem", {
          status: "lost",
          closed_at: "2026-11-10T12:00:00.000Z",
          custom_fields: { motivo: "sem-verba" },
        }),
      ],
    });

    const { POST } = await import("./route");
    const res = await POST(reqPost({ escolha: "transferir", funil_id: DESTINO }), ctx());
    expect(res.status).toBe(200);

    const perdido = db.tabelas.crm_leads.find((l) => l.id === "l-lost");
    expect(perdido?.status).toBe("lost");
    expect(perdido?.pipeline_id).toBe(PIPE);
    expect(db.rpcs.filter((r) => r.nome === "fn_mover_leads_em_lote")).toHaveLength(0);
    const corpo = (await res.json()) as { data: { movidos: number; restantes: number; mensagem: string | null } };
    expect(corpo.data.movidos).toBe(0);
    expect(corpo.data.restantes).toBe(1);
    expect(corpo.data.mensagem).toContain("Os ganhos e perdidos ficam neste funil");
  });

  it("(b) destino que RETOMA COMO NOVO NEGÓCIO aceita: o encerrado nem entra no lote", async () => {
    authOk();
    const db = makeDb({
      pipelines: [
        funilRow({ id: PIPE, name: "Pedidos", slug: "pedidos", position: 1000, is_default: true }),
        funilRow({
          id: DESTINO,
          name: "Clínica",
          slug: "clinica",
          position: 2000,
          settings: { reabertura: "novo_negocio" },
        }),
      ],
      stages: [etapa({ id: "e-origem", name: "Novo" }), ...etapasDoDestino()],
      leads: [
        negocio("l-won", "e-origem", { status: "won", closed_at: "2026-11-18T10:55:11.000Z" }),
        negocio("l-open", "e-origem", { status: "open" }),
      ],
    });

    const { POST } = await import("./route");
    const res = await POST(reqPost({ escolha: "transferir", funil_id: DESTINO }), ctx());

    expect(res.status).toBe(200);
    expect(db.tabelas.crm_leads.find((l) => l.id === "l-won")?.pipeline_id).toBe(PIPE);
    expect(db.tabelas.crm_leads.find((l) => l.id === "l-open")?.pipeline_id).toBe(DESTINO);
  });

  it("(b2) o MESMO destino novo_negocio aceita o lote sem encerrado", async () => {
    authOk();
    const db = makeDb({
      pipelines: [
        funilRow({ id: PIPE, name: "Pedidos", slug: "pedidos", position: 1000, is_default: true }),
        funilRow({
          id: DESTINO,
          name: "Clínica",
          slug: "clinica",
          position: 2000,
          settings: { reabertura: "novo_negocio" },
        }),
      ],
      stages: [etapa({ id: "e-origem", name: "Novo" }), ...etapasDoDestino()],
      leads: [negocio("l-open", "e-origem", { status: "open" })],
    });

    const { POST } = await import("./route");
    expect((await POST(reqPost({ escolha: "transferir", funil_id: DESTINO }), ctx())).status).toBe(200);
    expect(db.tabelas.crm_leads.find((l) => l.id === "l-open")?.pipeline_id).toBe(DESTINO);
  });

  it("(c) os campos obrigatórios do DESTINO valem como no lote do quadro", async () => {
    authOk();
    const db = makeDb({
      pipelines: [
        funilRow({ id: PIPE, name: "Pedidos", slug: "pedidos", position: 1000, is_default: true }),
        funilRow({
          id: DESTINO,
          name: "Clínica",
          slug: "clinica",
          position: 2000,
          // A etapa que RECEBE o lote exige o campo — declarado no funil de destino,
          // não no de origem.
          settings: {
            fields: [
              {
                key: "convenio",
                label: "Convênio",
                type: "text",
                obrigatorio_em: { etapas: [ETAPA_NOVO] },
              },
            ],
          },
        }),
      ],
      stages: [etapa({ id: "e-origem", name: "Novo" }), ...etapasDoDestino()],
      leads: [
        negocio("l-sem-campo", "e-origem", { status: "open" }),
        negocio("l-com-campo", "e-origem", {
          status: "open",
          custom_fields: { convenio: "Unimed" },
        }),
      ],
    });

    const { POST } = await import("./route");
    const res = await POST(reqPost({ escolha: "transferir", funil_id: DESTINO }), ctx());

    expect(res.status).toBe(422);
    const corpo = (await res.json()) as {
      error: {
        code: string;
        details: { lead_ids: string[]; faltando: Record<string, { chave: string }[]> };
      };
    };
    // O MESMO código, o MESMO formato de `details` do `POST /leads/bulk`.
    expect(corpo.error.code).toBe("required_fields_missing");
    expect(corpo.error.details.lead_ids).toEqual(["l-sem-campo"]);
    expect(corpo.error.details.faltando["l-sem-campo"]?.[0]?.chave).toBe("convenio");
    // O card que TEM o campo não entra na recusa...
    expect(corpo.error.details.faltando["l-com-campo"]).toBeUndefined();
    // ...e nada se moveu: a função do banco move o lote inteiro, então a recusa
    // tem de vir ANTES dela.
    expect(db.rpcs.filter((r) => r.nome === "fn_mover_leads_em_lote")).toHaveLength(0);
    expect(db.tabelas.crm_leads.every((l) => l.pipeline_id === PIPE)).toBe(true);
  });

  it("(c2) com os campos do destino preenchidos, o lote passa", async () => {
    authOk();
    const db = makeDb({
      pipelines: [
        funilRow({ id: PIPE, name: "Pedidos", slug: "pedidos", position: 1000, is_default: true }),
        funilRow({
          id: DESTINO,
          name: "Clínica",
          slug: "clinica",
          position: 2000,
          settings: {
            fields: [
              {
                key: "convenio",
                label: "Convênio",
                type: "text",
                obrigatorio_em: { etapas: [ETAPA_NOVO] },
              },
            ],
          },
        }),
      ],
      stages: [etapa({ id: "e-origem", name: "Novo" }), ...etapasDoDestino()],
      leads: [negocio("l1", "e-origem", { status: "open", custom_fields: { convenio: "Unimed" } })],
    });

    const { POST } = await import("./route");
    expect((await POST(reqPost({ escolha: "transferir", funil_id: DESTINO }), ctx())).status).toBe(200);
    expect(db.tabelas.crm_leads.find((l) => l.id === "l1")?.stage_id).toBe(ETAPA_NOVO);
  });

  it("(d) uma linha de `stage_changed` POR NEGÓCIO, com a etapa de origem", async () => {
    authOk();
    const db = makeDb({
      pipelines: doisFunis(),
      stages: [etapa({ id: "e-origem", name: "Novo" }), ...etapasDoDestino()],
      leads: [
        negocio("l1", "e-origem", { status: "open", contact_id: CONTATO }),
        negocio("l2", "e-origem", { status: "open" }),
        // encerrado: fica no funil de origem e não ganha linha (doc 400, B)
        negocio("l3", "e-origem", { status: "won", closed_at: "2026-11-18T10:55:11.000Z" }),
      ],
      contacts: [{ id: CONTATO, organization_id: ORG_ID, name: "Ana" }],
    });

    const { POST } = await import("./route");
    expect(
      (await POST(reqPost({ escolha: "transferir", funil_id: DESTINO, etapa_id: ETAPA_ANDAMENTO }), ctx()))
        .status,
    ).toBe(200);

    const atividades = db.tabelas.crm_lead_activities;
    // N negócios, N timelines: uma linha em CADA uma — nunca uma agregada.
    expect(atividades).toHaveLength(2);
    expect(new Set(atividades.map((a) => a.lead_id))).toEqual(new Set(["l1", "l2"]));
    for (const a of atividades) {
      expect(a.type).toBe("stage_changed");
      expect(a.contact_id).toBe(
        a.lead_id === "l1" ? CONTATO : null,
      );
      const payload = a.payload as Record<string, unknown>;
      expect(payload.from_stage_id).toBe("e-origem");
      expect(payload.to_stage_id).toBe(ETAPA_ANDAMENTO);
      expect(payload.from_pipeline_id).toBe(PIPE);
      // `pipeline_id` é o funil onde o negócio passou a morar.
      expect(payload.pipeline_id).toBe(DESTINO);
      expect(payload.bulk).toBe(true);
      expect(payload.transferencia_de_funil).toBe(true);
    }
    // A frase da timeline nomeia a passagem de etapa.
    expect(atividades.find((a) => a.lead_id === "l1")?.reason).toBe("Movido de Novo para Em andamento");
  });

  it("(d2) a transferência NÃO emite `lead.stage_changed` — disparar em massa mandaria mensagem a centenas de contatos", async () => {
    authOk();
    const db = makeDb({
      pipelines: doisFunis(),
      stages: [etapa({ id: "e-origem", name: "Novo" }), ...etapasDoDestino()],
      leads: [negocio("l1", "e-origem", { status: "open" }), negocio("l2", "e-origem")],
    });

    const { POST } = await import("./route");
    await POST(reqPost({ escolha: "transferir", funil_id: DESTINO }), ctx());

    const eventos = db.rpcs.filter(
      (r) => r.nome === "emit_event" && (r.args as { p_event_type?: string }).p_event_type === "lead.stage_changed",
    );
    expect(eventos).toHaveLength(0);
  });
});
