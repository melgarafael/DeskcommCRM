import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EventRow } from "@/lib/event-log/dispatcher";

const admin = { from: vi.fn(), auth: { admin: { getUserById: vi.fn() } } };
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => admin }));

function query(data: unknown, error: { message: string } | null = null) {
  const q: Record<string, unknown> = {};
  for (const method of ["select", "eq", "in", "limit", "order", "insert"]) q[method] = vi.fn(() => q);
  q.maybeSingle = vi.fn(async () => ({ data, error }));
  q.single = vi.fn(async () => ({ data, error }));
  return q;
}

const row = (overrides: Partial<EventRow> = {}): EventRow => ({
  id: "event-1", organization_id: "org-1", event_type: "lead.won", entity_kind: "crm_lead", entity_id: "lead-1",
  payload: {}, metadata: { actor_user_id: "user-1" }, consumed_by: [], attempts: 0, ...overrides,
});

describe("advomaxContratacaoHandler", () => {
  beforeEach(() => {
    vi.resetModules();
    admin.from.mockReset();
    admin.auth.admin.getUserById.mockReset();
    process.env.ADVOMAX_API_URL = "https://gestao.example";
    process.env.ADVOMAX_CRM_INTEGRATION_KEY = "server-only-key";
    admin.auth.admin.getUserById.mockResolvedValue({ data: { user: { email: "ana@example.com" } } });
  });

  it("cria cliente/caso no Gestão com idempotência e sem expor segredo no corpo", async () => {
    admin.from
      .mockReturnValueOnce(query({ id: "lead-1", status: "won", title: "Ação trabalhista", description: "Contrato fechado", contact_id: "contact-1" }))
      .mockReturnValueOnce(query({ id: "contact-1", display_name: "Maria Silva", name: null, email: "maria@example.com", phone_number: "+5511999999999" }))
      .mockReturnValueOnce(query({ contact_id: "contact-1", pessoa_codigo: 42, status: "linked" }))
      .mockReturnValueOnce(query({ created_by: "user-2" }))
      .mockReturnValueOnce(query(null));
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ pessoa_codigo: 42, processo_codigo: 99 }), { status: 201 }));
    vi.stubGlobal("fetch", fetchMock);
    const { advomaxContratacaoHandler } = await import("@/lib/advomax/contratacao.handler");

    const result = await advomaxContratacaoHandler.handle(row());
    expect(result.status).toBe("ok");
    const init = (fetchMock.mock.calls as unknown as Array<[string, RequestInit]>)[0]?.[1] as RequestInit;
    expect((init.headers as Record<string, string>)["X-CRM-Idempotency-Key"]).toBe("lead:lead-1:won:v1");
    expect((init.headers as Record<string, string>)["X-CRM-Integration-Key"]).toBe("server-only-key");
    expect(String(init.body)).not.toContain("server-only-key");
    expect(JSON.parse(String(init.body))).toMatchObject({ lead_id: "lead-1", pessoa_codigo: 42, criar_processo: true });
    const processInsert = (admin.from.mock.results as unknown as Array<{ value: Record<string, ReturnType<typeof vi.fn>> }>)[4]?.value;
    expect(processInsert?.insert).toHaveBeenCalledWith(expect.objectContaining({
      organization_id: "org-1", contact_id: "contact-1", processo_codigo: 99,
    }));
  });

  it("persiste o vínculo CRM quando o Gestão cria a Pessoa", async () => {
    admin.from
      .mockReturnValueOnce(query({ id: "lead-1", status: "won", title: "Ação", description: null, contact_id: "contact-1" }))
      .mockReturnValueOnce(query({ id: "contact-1", display_name: "Maria", name: null, email: null, phone_number: null }))
      .mockReturnValueOnce(query(null))
      .mockReturnValueOnce(query({ created_by: "user-2" }))
      .mockReturnValueOnce(query(null))
      .mockReturnValueOnce(query(null));
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ pessoa_codigo: 77, processo_codigo: 101 }), { status: 201 })));
    const { advomaxContratacaoHandler } = await import("@/lib/advomax/contratacao.handler");

    const result = await advomaxContratacaoHandler.handle(row({ metadata: {} }));
    expect(result.status).toBe("ok");
    const insert = (admin.from.mock.results as unknown as Array<{ value: Record<string, ReturnType<typeof vi.fn>> }>)[4]?.value;
    if (!insert) throw new Error("query de vínculo não foi criada");
    expect(insert.insert).toHaveBeenCalledWith(expect.objectContaining({
      organization_id: "org-1", contact_id: "contact-1", pessoa_codigo: 77,
      status: "linked", authority_source: "crm_contract", created_by: null,
    }));
    const processInsert = (admin.from.mock.results as unknown as Array<{ value: Record<string, ReturnType<typeof vi.fn>> }>)[5]?.value;
    expect(processInsert?.insert).toHaveBeenCalledWith(expect.objectContaining({ processo_codigo: 101 }));
  });

  it("recusa recibo do Gestão que troca silenciosamente a Pessoa vinculada", async () => {
    admin.from
      .mockReturnValueOnce(query({ id: "lead-1", status: "won", title: "Ação", description: null, contact_id: "contact-1" }))
      .mockReturnValueOnce(query({ id: "contact-1", display_name: "Maria", name: null, email: null, phone_number: null }))
      .mockReturnValueOnce(query({ contact_id: "contact-1", pessoa_codigo: 42, status: "linked" }))
      .mockReturnValueOnce(query({ created_by: "user-2" }));
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ pessoa_codigo: 77, processo_codigo: 101 }), { status: 200 })));
    const { advomaxContratacaoHandler } = await import("@/lib/advomax/contratacao.handler");

    const result = await advomaxContratacaoHandler.handle(row({ metadata: {} }));
    expect(result).toMatchObject({ status: "error", detail: "recibo_pessoa_inconsistente" });
  });

  it("reagenda indisponibilidade do Gestão", async () => {
    admin.from
      .mockReturnValueOnce(query({ id: "lead-1", status: "won", title: "Ação", description: null, contact_id: "contact-1" }))
      .mockReturnValueOnce(query({ id: "contact-1", display_name: "Maria", name: null, email: null, phone_number: null }))
      .mockReturnValueOnce(query(null))
      .mockReturnValueOnce(query({ created_by: "user-2" }));
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("", { status: 503 })));
    const { advomaxContratacaoHandler } = await import("@/lib/advomax/contratacao.handler");
    const result = await advomaxContratacaoHandler.handle(row());
    expect(result.status).toBe("retry");
    expect(result.retry_at).toBeTypeOf("string");
  });

  it("não cria caso para evento que não representa ganho", async () => {
    admin.from.mockReturnValueOnce(query({ id: "lead-1", status: "open", title: "Ação", description: null, contact_id: null }));
    const { advomaxContratacaoHandler } = await import("@/lib/advomax/contratacao.handler");
    const result = await advomaxContratacaoHandler.handle(row({ event_type: "lead.stage_changed" }));
    expect(result.status).toBe("skipped");
    expect(result.detail).toBe("nao_e_ganho");
  });

  it("cria e vincula o caso quando o ganho veio de mudança de etapa", async () => {
    admin.from
      .mockReturnValueOnce(query({ id: "lead-1", status: "won", title: "Ação", description: null, contact_id: "contact-1" }))
      .mockReturnValueOnce(query({ id: "contact-1", display_name: "Maria", name: null, email: null, phone_number: null }))
      .mockReturnValueOnce(query({ contact_id: "contact-1", pessoa_codigo: 42, status: "linked" }))
      .mockReturnValueOnce(query({ created_by: "user-2" }))
      .mockReturnValueOnce(query(null));
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ pessoa_codigo: 42, processo_codigo: 102 }), { status: 201 })));
    const { advomaxContratacaoHandler } = await import("@/lib/advomax/contratacao.handler");

    const result = await advomaxContratacaoHandler.handle(row({ event_type: "lead.stage_changed" }));

    expect(result.status).toBe("ok");
    expect(advomaxContratacaoHandler.events).toContain("lead.stage_changed");
  });
});
