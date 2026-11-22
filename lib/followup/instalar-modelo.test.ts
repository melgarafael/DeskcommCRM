/**
 * A FUNÇÃO, CHAMADA DIRETO — sem `NextRequest`, sem `Response`.
 *
 * `route.test.ts` mede a borda HTTP. Este mede o contrato de
 * `instalarFluxoDoModelo`, que é o que o servidor MCP chama. O que se prende:
 *
 * 1. **O grafo é do CATÁLOGO**, e a instalação nasce rascunho — sem `status` e
 *    sem `active_version_id` no insert.
 * 2. **`organization_id` sai do ator**, nunca da entrada, e a etapa é conferida
 *    contra ELA: etapa de outra organização é 422, não um fluxo que nunca dispara.
 * 3. **A recusa vem antes do insert** — nenhuma linha é escrita quando o pedido
 *    é recusado.
 * 4. **A auditoria diz QUAL modelo**, com o `requestId` da resposta.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { audit } from "@/lib/audit";
import { instalarFluxoDoModelo } from "./instalar-modelo";

vi.mock("@/lib/audit", () => ({ audit: vi.fn() }));

const ORG = "11111111-1111-4111-8111-111111111111";
const OUTRA_ORG = "99999999-9999-4999-8999-999999999999";
const EU = "22222222-2222-4222-8222-222222222222";
const ETAPA = "33333333-3333-4333-8333-333333333333";

function dbFake(opts: {
  etapas?: Array<{ id: string; name: string; is_archived: boolean; organization_id: string }>;
  erroDoInsert?: { code: string; message: string };
} = {}) {
  const capturado: { tabela?: string; payload?: Record<string, unknown>; filtros: Record<string, unknown>[] } = {
    filtros: [],
  };
  const db = {
    from(tabela: string) {
      if (tabela === "crm_stages") {
        const filtros: Record<string, unknown> = {};
        const api = {
          select: () => api,
          eq(k: string, v: unknown) {
            filtros[k] = v;
            capturado.filtros.push({ [k]: v });
            return api;
          },
          maybeSingle: async () => ({
            data:
              (opts.etapas ?? []).find((e) =>
                Object.entries(filtros).every(([k, v]) => (e as Record<string, unknown>)[k] === v),
              ) ?? null,
            error: null,
          }),
        };
        return api;
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
  return { capturado, db };
}

function ator(over: Record<string, unknown> = {}) {
  return {
    organizationId: ORG,
    actor: { type: "user", id: EU } as never,
    apiTokenId: null,
    requestId: "req-1",
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("instalarFluxoDoModelo — o caminho feliz", () => {
  it("grava o grafo do catálogo como RASCUNHO e devolve a linha criada", async () => {
    const { capturado, db } = dbFake();

    const r = await instalarFluxoDoModelo(db as never, ator(), {
      model_id: "clinica-consulta-retomada",
    });

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.id).toBe("novo");
    expect(capturado.tabela).toBe("followup_flow_pointers");
    expect(capturado.payload).toMatchObject({ organization_id: ORG });
    // Nem `status` nem `active_version_id`: publicar é ato de gente.
    expect(capturado.payload).not.toHaveProperty("status");
    expect(capturado.payload).not.toHaveProperty("active_version_id");
    expect(vi.mocked(audit)).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "followup_flow.created",
        organizationId: ORG,
        actorUserId: EU,
        requestId: "req-1",
        metadata: expect.objectContaining({ model_id: "clinica-consulta-retomada" }),
      }),
    );
  });

  it("a etapa é conferida contra a organização DO ATOR", async () => {
    const { capturado, db } = dbFake({
      etapas: [{ id: ETAPA, name: "Quer agendar", is_archived: false, organization_id: ORG }],
    });
    await instalarFluxoDoModelo(db as never, ator(), {
      model_id: "clinica-exame-marcar",
      stage_id: ETAPA,
    });
    expect(capturado.filtros).toContainEqual({ organization_id: ORG });
    expect(capturado.payload?.trigger_config).toEqual({
      kind: "stage_change",
      params: { stage_id: ETAPA },
      cancel_on_reply: true,
    });
  });
});

describe("instalarFluxoDoModelo — as recusas vêm ANTES do insert", () => {
  it("modelo que não existe mais é 404", async () => {
    const { capturado, db } = dbFake();
    const r = await instalarFluxoDoModelo(db as never, ator(), { model_id: "clinica-nao-existe" });
    expect(r).toEqual({
      ok: false,
      code: "not_found",
      status: 404,
      message: "Este modelo não existe mais.",
    });
    expect(capturado.payload).toBeUndefined();
  });

  it("etapa ausente é 422 trigger_stage_missing", async () => {
    const { capturado, db } = dbFake();
    const r = await instalarFluxoDoModelo(db as never, ator(), { model_id: "clinica-exame-marcar" });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect([r.code, r.status]).toEqual(["trigger_stage_missing", 422]);
    expect(capturado.payload).toBeUndefined();
  });

  it("etapa da OUTRA organização é 422 — nunca o dado, nunca o insert", async () => {
    const { capturado, db } = dbFake({
      etapas: [{ id: ETAPA, name: "Quer agendar", is_archived: false, organization_id: OUTRA_ORG }],
    });
    const r = await instalarFluxoDoModelo(db as never, ator(), {
      model_id: "clinica-exame-marcar",
      stage_id: ETAPA,
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect([r.code, r.status]).toEqual(["trigger_stage_not_found", 422]);
    expect(capturado.payload).toBeUndefined();
  });

  it("etapa arquivada é 422 e NOMEIA a etapa", async () => {
    const { capturado, db } = dbFake({
      etapas: [{ id: ETAPA, name: "Quer agendar", is_archived: true, organization_id: ORG }],
    });
    const r = await instalarFluxoDoModelo(db as never, ator(), {
      model_id: "clinica-exame-marcar",
      stage_id: ETAPA,
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("trigger_stage_archived");
    expect(r.message).toContain("Quer agendar");
    expect(capturado.payload).toBeUndefined();
  });

  it("nome repetido é 409 nomeando o fluxo que já existe", async () => {
    const { db } = dbFake({ erroDoInsert: { code: "23505", message: "duplicate key" } });
    const r = await instalarFluxoDoModelo(db as never, ator(), { model_id: "clinica-consulta-retomada" });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect([r.code, r.status]).toEqual(["conflict", 409]);
    expect(r.message).toContain("Você já tem um fluxo chamado");
  });
});
