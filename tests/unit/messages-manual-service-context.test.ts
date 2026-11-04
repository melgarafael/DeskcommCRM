import { afterEach, describe, expect, it, vi } from "vitest";
import { sendMessageHandler } from "@/app/api/v1/messages/_handler";
import type { HandlerCtx } from "@/lib/api/handlers/types";
import { criarDubleDoHandler } from "@/tests/helpers/duble-do-handler";
const ORG = "11111111-1111-4111-8111-111111111111", CONV = "22222222-2222-4222-8222-222222222222", CONTACT = "33333333-3333-4333-8333-333333333333", USER = "55555555-5555-4555-8555-555555555555";
const admin = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => admin }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => { }) }));
function boundary(revision = 7) { return { organization_id: ORG, conversation_id: CONV, contact_id: CONTACT, service_revision: revision, demanda_id: null, demanda_revision: null, status: "claimed", demanda_fechada_em: null }; }
function setup() {
    vi.stubEnv("WAHA_API_BASE_URL", "http://localhost:3030");
    vi.stubEnv("WAHA_API_KEY", "synthetic-only");
    const transport = vi.fn(async () => new Response(JSON.stringify({ id: { id: "synthetic-receipt" } }), { status: 200 }));
    vi.stubGlobal("fetch", transport);
    admin.rpc.mockReset();
    admin.rpc.mockResolvedValue({ data: boundary(), error: null });
    const duble = criarDubleDoHandler({ conversation: { id: CONV, organization_id: ORG, contact_id: CONTACT, channel_session_id: "44444444-4444-4444-8444-444444444444", is_group: false, group_chat_id: null, bot_silenced_until: "infinity", contacts: { phone_number: "+5531999998888", is_blocked: false }, channel_sessions: { provider: "waha", waha_session_name: "fixture", status: "WORKING" } }, rpcData: () => boundary() });
    return { ...duble, transport };
}
const input = { conversation_id: CONV, type: "text" as const, body: "Resposta fictícia" };
function manual(): HandlerCtx { return { organization_id: ORG, actor: { type: "user", id: USER }, requestId: "fixture", manualReplyOrigin: true } as HandlerCtx; }
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });
describe("origem manual do Inbox sob isolamento", () => {
    it("persiste revisão autorizada para INSERT RETURNING do próprio atendente", async () => { const s = setup(); await sendMessageHandler(s.supabase, manual(), input); expect(s.capturas.inserts.messages?.[0]).toMatchObject({ service_revision: 7, demanda_id: null, demanda_revision: null, sent_by_user_id: USER }); expect(admin.rpc).toHaveBeenCalledWith("fn_service_boundary", { p_org: ORG, p_conversation: CONV }); });
    it("não usa leitura privilegiada nem envia quando RLS esconde a conversa", async () => { const s = setup(); const from = s.supabase.from.bind(s.supabase); s.supabase.from = ((table: string) => table === "conversations" ? { select: () => { const q = { eq: () => q, maybeSingle: async () => ({ data: null, error: null }) }; return q; } } : from(table)) as typeof s.supabase.from; await expect(sendMessageHandler(s.supabase, manual(), input)).rejects.toMatchObject({ status: 404 }); expect(admin.rpc).not.toHaveBeenCalled(); expect(s.transport).not.toHaveBeenCalled(); });
    it("recusa contexto de outra organização antes de gravar ou enviar", async () => { const s = setup(); admin.rpc.mockResolvedValue({ data: { ...boundary(), organization_id: "99999999-9999-4999-8999-999999999999" }, error: null }); await expect(sendMessageHandler(s.supabase, manual(), input)).rejects.toThrow("service_scope_mismatch"); expect(s.capturas.inserts.messages).toHaveLength(0); expect(s.transport).not.toHaveBeenCalled(); });
    it("não inventa contexto quando a origem não existe", async () => { const s = setup(); admin.rpc.mockResolvedValue({ data: null, error: null }); await expect(sendMessageHandler(s.supabase, manual(), input)).rejects.toThrow("service_boundary_stale"); expect(s.capturas.inserts.messages).toHaveLength(0); expect(s.transport).not.toHaveBeenCalled(); });
    it("não recaptura revisão antiga fornecida por trabalho anterior", async () => { const s = setup(); const ctx = { ...manual(), serviceBoundary: boundary(6) }; await expect(sendMessageHandler(s.supabase, ctx, input)).rejects.toThrow("service_boundary_stale"); expect(s.capturas.inserts.messages).toHaveLength(0); expect(s.transport).not.toHaveBeenCalled(); });
    it("mantém caminho de IA sem capturar origem humana", async () => { const s = setup(); await sendMessageHandler(s.supabase, { organization_id: ORG, actor: { type: "ai_agent", id: USER, role: "agent" }, requestId: "ai", serviceBoundary: boundary() }, input); expect(admin.rpc).not.toHaveBeenCalled(); expect(s.capturas.inserts.messages?.[0]).toMatchObject({ service_revision: 7 }); });
    it("não captura origem no caminho interno/token sem marcador da sessão", async () => { const s = setup(); const ctx = manual(); delete ctx.manualReplyOrigin; await sendMessageHandler(s.supabase, ctx, input); expect(admin.rpc).not.toHaveBeenCalled(); });
    it("recusa atendimento encerrado sem reabrir nem enviar", async () => { const s = setup(); admin.rpc.mockResolvedValue({ data: { ...boundary(), status: "closed" }, error: null }); await expect(sendMessageHandler(s.supabase, manual(), input)).rejects.toThrow("service_boundary_stale"); expect(s.capturas.inserts.messages).toHaveLength(0); expect(s.transport).not.toHaveBeenCalled(); });
    it("recusa mudança de revisão entre captura e transporte", async () => { const s = setup(); admin.rpc.mockResolvedValueOnce({ data: boundary(), error: null }).mockResolvedValue({ data: boundary(8), error: null }); await expect(sendMessageHandler(s.supabase, manual(), input)).rejects.toThrow("service_boundary_stale"); expect(s.transport).not.toHaveBeenCalled(); });
    it("erro de leitura da fronteira não permite gravar nem enviar", async () => { const s = setup(); admin.rpc.mockResolvedValue({ data: null, error: { message: "fixture read unavailable" } }); await expect(sendMessageHandler(s.supabase, manual(), input)).rejects.toMatchObject({ message: "fixture read unavailable" }); expect(s.capturas.inserts.messages).toHaveLength(0); expect(s.transport).not.toHaveBeenCalled(); });
});
