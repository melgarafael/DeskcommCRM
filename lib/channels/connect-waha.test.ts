import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { connectWahaChannel } from "./connect-waha";
vi.mock("@/lib/audit", () => ({ audit: vi.fn() }));
const org = "20000000-0000-4000-8000-000000000001";
const key = "20000000-0000-4000-8000-000000000002";
const channel = { id: key, organization_id: org, waha_session_name: "owned", status: "STARTING", archived_at: null };
function fixture() {
  const finishes: Record<string, unknown>[] = [];
  const db = { rpc: vi.fn(async (name: string, args: Record<string, unknown>) => {
    if (name === "fn_reserve_channel_connection") return { data: { channel, receipt_id: key, lease_token: key, replay: false }, error: null };
    finishes.push(args);
    return { data: { ...channel, status: args.p_status }, error: null };
  }) } as unknown as SupabaseClient;
  const transport = { getVerifiedSession: vi.fn(async () => null), createSession: vi.fn(async () => ({ created: true, session: { name: "owned", status: "STOPPED" } })),
    startExistingSession: vi.fn(async () => ({ name: "owned", status: "SCAN_QR_CODE" })),
    deleteSession: vi.fn(async () => {}), stopSession: vi.fn(async () => {}) };
  return { db, transport, finishes, input: { organizationId: org, idempotencyKey: key, userId: key, requestId: key } };
}
describe("conexão recuperável", () => {
  it("publica somente o status confirmado pelo transporte e pelo DB", async () => {
    const f = fixture(); const result = await connectWahaChannel(f.db, f.db, f.transport, f.input);
    expect(result.channel.status).toBe("SCAN_QR_CODE");
    expect(f.finishes.map((c) => c.p_status)).toEqual(["remote_created", "SCAN_QR_CODE"]);
  });
  it("timeout de criação não atesta ausência e preserva FAILED para reparo", async () => {
    const f = fixture(); f.transport.createSession.mockRejectedValue(new Error("timeout"));
    await expect(connectWahaChannel(f.db, f.db, f.transport, f.input)).rejects.toThrow("connection_repair_required");
    expect(f.transport.deleteSession).not.toHaveBeenCalled();
    expect(f.finishes.at(-1)).toMatchObject({ p_status: "FAILED" });
  });
  it("falha após criação própria preserva remoto e marca FAILED", async () => {
    const f = fixture(); f.transport.startExistingSession.mockRejectedValue(new Error("bad_start"));
    await expect(connectWahaChannel(f.db, f.db, f.transport, f.input)).rejects.toThrow("connection_repair_required");
    expect(f.transport.deleteSession).not.toHaveBeenCalled();
    expect(f.finishes.at(-1)).toMatchObject({ p_status: "FAILED" });
  });
  it("nova tentativa reutiliza a mesma identidade após falha", async () => {
    const f = fixture(); f.transport.startExistingSession.mockRejectedValue(new Error("bad_start"));
    await expect(connectWahaChannel(f.db, f.db, f.transport, f.input)).rejects.toThrow("connection_repair_required");
    f.transport.createSession.mockResolvedValue({ created: false, session: { name: "owned", status: "STOPPED" } });
    f.transport.startExistingSession.mockResolvedValue({ name: "owned", status: "SCAN_QR_CODE" });
    expect((await connectWahaChannel(f.db, f.db, f.transport, f.input)).channel.status).toBe("SCAN_QR_CODE");
    expect(f.transport.createSession).toHaveBeenNthCalledWith(2, "owned");
    expect(f.transport.startExistingSession).toHaveBeenNthCalledWith(2, "owned");
    expect(f.transport.deleteSession).not.toHaveBeenCalled();
  });
  it("sessão já existente não é propriedade de compensação da chamada", async () => {
    const f = fixture(); f.transport.createSession.mockResolvedValue({ created: false, session: { name: "owned", status: "STOPPED" } });
    f.transport.startExistingSession.mockRejectedValue(new Error("bad_start"));
    await expect(connectWahaChannel(f.db, f.db, f.transport, f.input)).rejects.toThrow("connection_repair_required");
    expect(f.transport.deleteSession).not.toHaveBeenCalled();
  });
  it("lease perdida proíbe compensação destrutiva", async () => {
    const f = fixture(); f.transport.startExistingSession.mockRejectedValue(new Error("bad_start"));
    vi.mocked(f.db.rpc).mockImplementation(((name: string) => Promise.resolve( name === "fn_reserve_channel_connection"
      ? { data: { channel, receipt_id: key, lease_token: key, replay: false }, error: null } as never
      : { data: null, error: { message: "connection_lease_lost", code: "55P03" } })) as unknown as typeof f.db.rpc);
    await expect(connectWahaChannel(f.db, f.db, f.transport, f.input)).rejects.toThrow();
    expect(f.transport.deleteSession).not.toHaveBeenCalled();
  });
  it("replay confirmado não toca no transporte", async () => {
    const f = fixture();
    vi.mocked(f.db.rpc).mockResolvedValue({ data: { channel: { ...channel, status: "SCAN_QR_CODE" }, receipt_id: key, replay: true }, error: null } as never);
    expect((await connectWahaChannel(f.db, f.db, f.transport, f.input)).replay).toBe(true);
    expect(f.transport.createSession).not.toHaveBeenCalled();expect(f.transport.deleteSession).not.toHaveBeenCalled();
  });
});
