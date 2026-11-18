import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn(async () => null) }));
vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({}) }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));
vi.mock("@/lib/webhooks/secrets", () => ({
  encryptRuleActionSecrets: async (_admin: unknown, actions: unknown) => actions,
}));

import { ORG_ID, PIPE, authOk, etapa, funilRow, makeDb } from "@/tests/helpers/stages-db-double";

/**
 * #4297 — A REGRA QUE APONTA PARA A ETAPA DE PERDA SEM MOTIVO É RECUSADA NO CADASTRO.
 *
 * ─── Por que a recusa mora na ROTA, e não no schema zod ─────────────────────
 *
 * "Esta etapa fecha o negócio como perdido?" é uma pergunta ao BANCO
 * (`crm_stages.is_lost`), e o schema é puro. A rota tem o cliente e a
 * organização, então é ela que monta a pergunta com `acoesDePerdaSemMotivo`
 * (`lib/automation/motivo-da-perda-na-acao.ts`) — a MESMA função das duas
 * portas (POST e PATCH), para as duas não divergirem no primeiro ajuste.
 *
 * Deixar passar aqui é o que produziu o defeito de campo: a regra era salva e
 * falhava em TODA execução, 165 vezes na mesma passada, sem ninguém saber por
 * quê até abrir a aba Atividade.
 */

const ETAPA_PERDA = "55555555-5555-4555-8555-555555555555";
const ETAPA_COMUM = "66666666-6666-4666-8666-666666666666";

function reqPost(body: unknown) {
  return new NextRequest("http://localhost/api/v1/automation-rules", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}

function regra(stageId: string, extra: Record<string, unknown> = {}) {
  return {
    name: "Etapa parada vai para perdido",
    trigger_event: "lead.stage_stale",
    trigger_config: { dias: 7 },
    actions: [{ type: "create_or_move_lead", config: { pipeline_id: PIPE, stage_id: stageId, ...extra } }],
  };
}

function dbComEtapas() {
  return makeDb({
    pipelines: [funilRow({ id: PIPE, name: "Funil comercial" })],
    stages: [
      etapa({ id: ETAPA_COMUM, name: "Triagem", position: 1000 }),
      etapa({ id: ETAPA_PERDA, name: "Perdido", position: 2000, is_lost: true }),
    ],
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("POST /api/v1/automation-rules — etapa de perda exige motivo (#4297)", () => {
  it("sem motivo → 422 nomeando o campo, e NENHUMA regra gravada", async () => {
    authOk();
    const db = dbComEtapas();
    const { POST } = await import("./route");

    const res = await POST(reqPost(regra(ETAPA_PERDA)));
    const corpo = (await res.json()) as { error: { code: string; message: string; details?: unknown } };

    expect(res.status).toBe(422);
    // A mensagem NOMEIA o campo — é ela que a tela mostra ao salvar.
    expect(corpo.error.message).toContain("Motivo da perda");
    expect(corpo.error.message).toContain("Perdido");
    expect(corpo.error.details).toEqual({ campo: "Motivo da perda" });
    expect(db.escritas).toEqual([]);
  });

  it("com motivo → cria a regra (controle positivo)", async () => {
    authOk();
    const db = dbComEtapas();
    const { POST } = await import("./route");

    const res = await POST(reqPost(regra(ETAPA_PERDA, { lost_reason: "price" })));

    expect(res.status).toBe(201);
    const gravada = db.escritas.find((e) => e.table === "automation_rules" && e.tipo === "insert");
    expect(gravada).toBeDefined();
    const patch = gravada!.patch as Record<string, unknown>;
    expect(JSON.stringify(patch.actions)).toContain("price");
  });

  it("etapa que NÃO é de perda → cria sem motivo, como sempre (#4297 não pede o que não deve)", async () => {
    authOk();
    const db = dbComEtapas();
    const { POST } = await import("./route");

    const res = await POST(reqPost(regra(ETAPA_COMUM)));

    expect(res.status).toBe(201);
    expect(db.escritas.some((e) => e.table === "automation_rules" && e.tipo === "insert")).toBe(true);
  });
});

/**
 * O PATCH é o caminho do dia a dia: o desenho da automação salva por ele, e é
 * ele que a regra ANTIGA percorre quando alguém abre e grava de novo. A régua é
 * a mesma; o que muda é que ela só roda quando o corpo TRAZ ações (regravar o
 * nome ou ligar/desligar não pode ser barrado — a regra antiga continua
 * existindo, e falha em execução com o código real).
 */
describe("PATCH /api/v1/automation-rules/[id] — etapa de perda exige motivo (#4297)", () => {
  const RULE_ID = "77777777-7777-4777-8777-777777777777";

  function dbComRegra() {
    return makeDb({
      pipelines: [funilRow({ id: PIPE, name: "Funil comercial" })],
      stages: [
        etapa({ id: ETAPA_COMUM, name: "Triagem", position: 1000 }),
        etapa({ id: ETAPA_PERDA, name: "Perdido", position: 2000, is_lost: true }),
      ],
      automationRules: [
        {
          id: RULE_ID,
          organization_id: ORG_ID,
          trigger_event: "lead.stage_stale",
          trigger_config: { dias: 7 },
          // A REGRA ANTIGA: aponta para a perda e não tem motivo.
          actions: [{ type: "create_or_move_lead", config: { pipeline_id: PIPE, stage_id: ETAPA_PERDA } }],
        },
      ],
    });
  }

  function reqPatch(body: unknown) {
    return new NextRequest(`http://localhost/api/v1/automation-rules/${RULE_ID}`, {
      method: "PATCH",
      body: JSON.stringify(body),
      headers: { "content-type": "application/json" },
    });
  }

  const ctx = { params: Promise.resolve({ id: RULE_ID }) };

  it("regravar as ações apontando para a perda sem motivo → 422 e NENHUMA escrita", async () => {
    authOk();
    const db = dbComRegra();
    const { PATCH } = await import("./[id]/route");

    const res = await PATCH(reqPatch({ actions: regra(ETAPA_PERDA).actions }), ctx);
    const corpo = (await res.json()) as { error: { message: string; details?: unknown } };

    expect(res.status).toBe(422);
    expect(corpo.error.message).toContain("Motivo da perda");
    expect(corpo.error.details).toEqual({ campo: "Motivo da perda" });
    expect(db.escritas).toEqual([]);
  });

  it("ligar/desligar a regra antiga continua passando — ela falha em execução, não no interruptor", async () => {
    authOk();
    const db = dbComRegra();
    const { PATCH } = await import("./[id]/route");

    const res = await PATCH(reqPatch({ is_active: true }), ctx);

    expect(res.status).toBe(200);
    expect(db.escritas.some((e) => e.table === "automation_rules" && e.tipo === "update")).toBe(true);
  });

  it("regravar as ações COM o motivo → 200", async () => {
    authOk();
    const db = dbComRegra();
    const { PATCH } = await import("./[id]/route");

    const res = await PATCH(reqPatch({ actions: regra(ETAPA_PERDA, { lost_reason: "price" }).actions }), ctx);

    expect(res.status).toBe(200);
    const escrita = db.escritas.find((e) => e.table === "automation_rules" && e.tipo === "update");
    expect(JSON.stringify(escrita?.patch)).toContain("price");
  });
});
