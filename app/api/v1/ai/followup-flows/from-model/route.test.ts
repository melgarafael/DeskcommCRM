/**
 * O que estes casos protegem:
 *
 * 1. **O grafo gravado é o do CATÁLOGO, nunca o do body.** Um modelo é um
 *    atalho para não desenhar; se o cliente pudesse mandar o `draft_graph`
 *    junto, esta rota seria o PATCH com outro nome — e sem o gate de `manager`
 *    que o PATCH tem por outro caminho.
 * 2. **O fluxo nasce RASCUNHO.** Instalar não pode mandar mensagem a paciente
 *    nenhum. `status` fica no default do banco (`draft`) e `active_version_id`
 *    não é tocado.
 * 3. **`organization_id` sai da sessão, nunca do body** (anti-pattern nº 10) —
 *    e a etapa do gatilho é conferida contra ESSA organização.
 * 4. **Instalar duas vezes é 409 com o nome do fluxo**, não um segundo fluxo
 *    igual disputando o mesmo paciente.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const deps = vi.hoisted(() => ({
  role: vi.fn(),
  support: vi.fn(),
  audit: vi.fn(),
  client: vi.fn(),
}));

vi.mock("@/lib/auth/require-role", () => ({ requireRole: deps.role }));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: deps.support }));
vi.mock("@/lib/audit", () => ({ audit: deps.audit }));
vi.mock("@/lib/supabase/server", () => ({ createClient: deps.client }));

import { POST } from "./route";
import { MODELOS_DE_FOLLOWUP, modeloPorId } from "@/lib/followup/modelos";

const ORG = "11111111-1111-4111-8111-111111111111";
const EU = "22222222-2222-4222-8222-222222222222";
const ETAPA = "33333333-3333-4333-8333-333333333333";

/** Client de sessão fake: guarda o payload do insert e responde as duas tabelas. */
function clientFake(opts: {
  etapa?: { id: string; name: string; is_archived: boolean } | null;
  erroDoInsert?: { code: string; message: string };
} = {}) {
  const capturado: { tabela?: string; payload?: Record<string, unknown> } = {};
  const client = {
    from: (tabela: string) => {
      if (tabela === "crm_stages") {
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                maybeSingle: async () => ({ data: opts.etapa ?? null, error: null }),
              }),
            }),
          }),
        };
      }
      return {
        insert: (payload: Record<string, unknown>) => {
          capturado.tabela = tabela;
          capturado.payload = payload;
          return {
            select: () => ({
              single: async () =>
                opts.erroDoInsert
                  ? { data: null, error: opts.erroDoInsert }
                  : { data: { id: "novo", status: "draft", ...payload }, error: null },
            }),
          };
        },
      };
    },
  };
  return { capturado, client };
}

function req(body: unknown) {
  return new NextRequest("http://localhost/api/v1/ai/followup-flows/from-model", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  deps.support.mockResolvedValue(null);
  deps.role.mockResolvedValue({
    ok: true,
    user: { id: EU, idioma: "pt-BR" },
    org: { orgId: ORG, role: "manager" },
  });
});

describe("POST /api/v1/ai/followup-flows/from-model", () => {
  it("instala o modelo de silêncio como RASCUNHO, com o grafo do catálogo", async () => {
    const { capturado, client } = clientFake();
    deps.client.mockResolvedValue(client);

    const res = await POST(req({ model_id: "clinica-consulta-retomada" }));
    expect(res.status).toBe(201);

    const modelo = modeloPorId("clinica-consulta-retomada")!;
    expect(capturado.tabela).toBe("followup_flow_pointers");
    expect(capturado.payload).toMatchObject({
      organization_id: ORG,
      name: modelo.nome,
      draft_graph: modelo.grafo,
      trigger_config: { kind: "silence", cancel_on_reply: true },
      handoff_policy: modelo.handoffPolicy,
    });
    // Nem `status` nem `active_version_id`: publicar é ato de gente.
    expect(capturado.payload).not.toHaveProperty("status");
    expect(capturado.payload).not.toHaveProperty("active_version_id");
  });

  it("audita a instalação dizendo QUAL modelo — sem isso ninguém sabe de onde o fluxo veio", async () => {
    const { client } = clientFake();
    deps.client.mockResolvedValue(client);

    await POST(req({ model_id: "clinica-falta-remarcar" }));

    expect(deps.audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "followup_flow.created",
        organizationId: ORG,
        actorUserId: EU,
        metadata: expect.objectContaining({
          model_id: "clinica-falta-remarcar",
          trigger_kind: "appointment_no_show",
        }),
      }),
    );
  });

  it("modelo de etapa sem etapa escolhida é recusado ANTES de gravar", async () => {
    const { capturado, client } = clientFake();
    deps.client.mockResolvedValue(client);

    const res = await POST(req({ model_id: "clinica-exame-marcar" }));
    expect(res.status).toBe(422);
    expect((await res.json()).error.code).toBe("trigger_stage_missing");
    expect(capturado.payload).toBeUndefined();
  });

  it("etapa que não é desta organização é 422, não um fluxo que nunca dispara", async () => {
    const { capturado, client } = clientFake({ etapa: null });
    deps.client.mockResolvedValue(client);

    const res = await POST(req({ model_id: "clinica-exame-marcar", stage_id: ETAPA }));
    expect(res.status).toBe(422);
    expect((await res.json()).error.code).toBe("trigger_stage_not_found");
    expect(capturado.payload).toBeUndefined();
  });

  it("etapa arquivada é 422 — card nenhum entra nela", async () => {
    const { client } = clientFake({
      etapa: { id: ETAPA, name: "Quer agendar", is_archived: true },
    });
    deps.client.mockResolvedValue(client);

    const res = await POST(req({ model_id: "clinica-exame-marcar", stage_id: ETAPA }));
    expect(res.status).toBe(422);
    expect((await res.json()).error.code).toBe("trigger_stage_archived");
  });

  it("com etapa ativa, arma o gatilho com o stage_id escolhido", async () => {
    const { capturado, client } = clientFake({
      etapa: { id: ETAPA, name: "Quer agendar", is_archived: false },
    });
    deps.client.mockResolvedValue(client);

    const res = await POST(req({ model_id: "clinica-cirurgia-decisao", stage_id: ETAPA }));
    expect(res.status).toBe(201);
    expect(capturado.payload?.trigger_config).toEqual({
      kind: "stage_change",
      params: { stage_id: ETAPA },
      cancel_on_reply: true,
    });
  });

  it("instalar o mesmo modelo duas vezes é 409 com o nome, não um clone", async () => {
    const { client } = clientFake({
      erroDoInsert: { code: "23505", message: "duplicate key" },
    });
    deps.client.mockResolvedValue(client);

    const res = await POST(req({ model_id: "clinica-consulta-retomada" }));
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error.code).toBe("conflict");
    expect(body.error.message).toContain(modeloPorId("clinica-consulta-retomada")!.nome);
  });

  it("modelo inexistente é 404, com a mensagem do catálogo", async () => {
    deps.client.mockResolvedValue(clientFake().client);
    const res = await POST(req({ model_id: "clinica-nao-existe" }));
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error.code).toBe("not_found");
    // A mensagem é contrato de API. Desde a #4688 ela nasce em
    // `lib/followup/instalar-modelo.ts`; sem esta linha, trocar o texto lá
    // passaria verde e o cliente veria outra frase sem ninguém notar.
    expect(body.error.message).toBe("Este modelo não existe mais.");
  });

  it("não aceita grafo pelo body — o desenho é do catálogo", async () => {
    const { capturado, client } = clientFake();
    deps.client.mockResolvedValue(client);

    const res = await POST(
      req({
        model_id: "clinica-consulta-retomada",
        draft_graph: { nodes: [], edges: [] },
        organization_id: "99999999-9999-4999-8999-999999999999",
      }),
    );
    expect(res.status).toBe(422);
    expect(capturado.payload).toBeUndefined();
  });

  it("viewer e agent não instalam — o gate é do requireRole('manager')", async () => {
    deps.role.mockResolvedValue({ ok: false, response: new Response(null, { status: 403 }) });
    const res = await POST(req({ model_id: "clinica-consulta-retomada" }));
    expect(res.status).toBe(403);
  });

  it("todo modelo do catálogo instala — nenhum reprova a própria validação da rota", async () => {
    for (const modelo of MODELOS_DE_FOLLOWUP) {
      const { client } = clientFake({
        etapa: { id: ETAPA, name: "Quer agendar", is_archived: false },
      });
      deps.client.mockResolvedValue(client);
      const res = await POST(
        req({ model_id: modelo.id, ...(modelo.pedeEtapa ? { stage_id: ETAPA } : {}) }),
      );
      expect([modelo.id, res.status]).toEqual([modelo.id, 201]);
    }
  });
});
