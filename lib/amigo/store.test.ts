// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  from: vi.fn(),
  rpc: vi.fn(),
  request: vi.fn(),
  encrypt: vi.fn(),
  decrypt: vi.fn(),
}));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({ from: mocks.from, rpc: mocks.rpc }),
}));
vi.mock("@/lib/webhooks/secrets", () => ({
  encryptWebhookSecret: mocks.encrypt,
  decryptWebhookSecret: mocks.decrypt,
}));
vi.mock("./transport", () => ({ requestAmigo: mocks.request }));
import {
  disconnectAmigo,
  getAmigoConfig,
  loadAmigoConnection,
  provisionAmigo,
  saveAmigoConfig,
} from "./store";
const org = "11111111-1111-4111-8111-111111111111";
const actor = "22222222-2222-4222-8222-222222222222";
const connection = "33333333-3333-4333-8333-333333333333";
const row = {
  id: connection,
  organization_id: org,
  active: false,
  token_last4: "1234",
  validated_at: "2026-11-06T12:00:00Z",
  default_place_id: null,
  timezone: "America/Fortaleza",
  allow_same_day: null,
  months_ahead: null,
  reminders_enabled: false,
  last_sync_at: null,
  last_error: null,
};
type Table = "amigo_connections" | "amigo_credentials" | "user_organizations";
let replies: Record<Table, { data: unknown; error: unknown }>;
let queries: Array<{ table: string; methods: Array<[string, unknown[]]> }>;
beforeEach(() => {
  vi.clearAllMocks();
  replies = {
    amigo_connections: { data: row, error: null },
    amigo_credentials: { data: { ciphertext: "\\xcipher" }, error: null },
    user_organizations: { data: { role: "admin" }, error: null },
  };
  queries = [];
  mocks.from.mockImplementation((table: string) => {
    const entry = { table, methods: [] as Array<[string, unknown[]]> };
    queries.push(entry);
    const q: Record<string, unknown> = {};
    for (const method of ["select", "eq", "is", "not", "order", "limit"])
      q[method] = (...args: unknown[]) => {
        entry.methods.push([method, args]);
        return q;
      };
    q.maybeSingle = () => Promise.resolve(replies[table as Table]);
    return q;
  });
  mocks.rpc.mockResolvedValue({ data: row, error: null });
  mocks.request.mockResolvedValue({
    status: "success",
    data: [{ id: 7, name: "Unidade fictícia" }],
  });
  mocks.encrypt.mockResolvedValue("\\xcipher");
  mocks.decrypt.mockResolvedValue("secret-token-1234");
});
describe("safe config", () => {
  it("recognizes PostgREST missing optional table before provisioning", async () => {
    replies.amigo_connections = { data: null, error: { code: "PGRST205" } };
    expect(await getAmigoConfig(org)).toMatchObject({ configured: false, active: false });
  });
  it("returns unconfigured on absent optional table and never provisions on GET", async () => {
    replies.amigo_connections = { data: null, error: { code: "42P01" } };
    expect(await getAmigoConfig(org)).toMatchObject({
      configured: false,
      active: false,
      connection_id: null,
      reminders_enabled: false,
    });
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
  it("does not mask other database failures or leak their text", async () => {
    replies.amigo_connections = {
      data: null,
      error: { code: "42501", message: "secret-token-1234" },
    };
    await expect(getAmigoConfig(org)).rejects.toThrow("Não foi possível ler");
  });
  it("uses an explicit safe projection and scopes by org", async () => {
    const config = await getAmigoConfig(org);
    expect(config).toEqual({
      configured: true,
      active: false,
      connection_id: connection,
      token_last4: "1234",
      validated_at: row.validated_at,
      default_place_id: null,
      timezone: row.timezone,
      reminders_enabled: false,
      last_sync_at: null,
      last_error: null,
    });
    expect(queries[0]!.methods).toContainEqual(["eq", ["organization_id", org]]);
    expect(JSON.stringify(config)).not.toMatch(/cipher|secret-token|organization_id/);
  });
  it("never returns arbitrary provider/database last_error text", async () => {
    replies.amigo_connections.data = {
      ...row,
      last_error: "Bearer secret-token-1234 patient details",
    };
    expect(JSON.stringify(await getAmigoConfig(org))).not.toMatch(/Bearer|secret-token|patient/);
  });
});
describe("privileged writes", () => {
  it("clears explicit offer overrides with null instead of preserving the old value", async () => {
    await saveAmigoConfig(org, actor, { allow_same_day: null, months_ahead: null } as never);
    expect(mocks.rpc).toHaveBeenCalledWith(
      "fn_amigo_save_config",
      expect.objectContaining({ p_input: { allow_same_day: null, months_ahead: null } }),
    );
  });
  it("rejects non-admin before provision, decrypt or external request", async () => {
    replies.user_organizations.data = { role: "manager" };
    await expect(saveAmigoConfig(org, actor, { token: "secret-token-1234" })).rejects.toThrow(
      "administrador",
    );
    expect(mocks.rpc).not.toHaveBeenCalled();
    expect(mocks.request).not.toHaveBeenCalled();
    expect(mocks.encrypt).not.toHaveBeenCalled();
    expect(queries[0]!.methods).toContainEqual(["eq", ["user_id", actor]]);
    expect(queries[0]!.methods).toContainEqual(["eq", ["organization_id", org]]);
    expect(queries[0]!.methods).toContainEqual(["is", ["revoked_at", null]]);
  });
  it.each([
    { default_place_id: 0 },
    { timezone: "invalid/timezone" },
    { months_ahead: 4 },
    { token: "" },
    { organization_id: org },
  ])("rejects invalid input %j before side effects", async (input) => {
    await expect(saveAmigoConfig(org, actor, input as never)).rejects.toThrow();
    expect(mocks.rpc).not.toHaveBeenCalled();
    expect(mocks.request).not.toHaveBeenCalled();
  });
  it("validates places, encrypts, and atomically saves a NEW inactive connection", async () => {
    const safe = await saveAmigoConfig(org, actor, {
      token: "secret-token-1234",
      active: true,
      default_place_id: 7,
      timezone: "America/Fortaleza",
    });
    expect(mocks.request).toHaveBeenCalledWith("secret-token-1234", "places", {});
    expect(mocks.encrypt).toHaveBeenCalled();
    expect(mocks.rpc).toHaveBeenCalledWith("fn_amigo_save_config", {
      p_org: org,
      p_actor: actor,
      p_input: {
        active: false,
        default_place_id: 7,
        timezone: "America/Fortaleza",
        token_last4: "1234",
      },
      p_ciphertext: "\\xcipher",
      p_connection: null,
    });
    expect(JSON.stringify(safe)).not.toMatch(/cipher|secret-token/);
  });
  it("rejects malformed places response before saving or encrypting", async () => {
    mocks.request.mockResolvedValue({ status: "success", data: null });
    await expect(saveAmigoConfig(org, actor, { token: "secret-token-1234" })).rejects.toThrow(
      "validar",
    );
    expect(mocks.encrypt).not.toHaveBeenCalled();
  });
  it("does not save invalid token or echo unsafe remote errors", async () => {
    mocks.request.mockRejectedValue(new Error("Bearer secret-token-1234"));
    await expect(saveAmigoConfig(org, actor, { token: "secret-token-1234" })).rejects.toThrow(
      "validar",
    );
    expect(mocks.encrypt).not.toHaveBeenCalled();
    expect(mocks.rpc).not.toHaveBeenCalledWith("fn_amigo_save_config", expect.anything());
  });
  it("fails explicitly if encryption is unavailable and never persists plaintext", async () => {
    mocks.encrypt.mockResolvedValue(null);
    await expect(saveAmigoConfig(org, actor, { token: "secret-token-1234" })).rejects.toThrow(
      "cifra",
    );
    expect(mocks.rpc).not.toHaveBeenCalledWith("fn_amigo_save_config", expect.anything());
  });
  it("does not activate without validated token and selected unit", async () => {
    await expect(saveAmigoConfig(org, actor, { active: true })).rejects.toThrow("unidade");
    expect(mocks.rpc).not.toHaveBeenCalledWith("fn_amigo_save_config", expect.anything());
  });
  it("preserves omitted options on updates and scopes the atomic RPC", async () => {
    await saveAmigoConfig(org, actor, { allow_same_day: false, months_ahead: 3 });
    expect(mocks.request).not.toHaveBeenCalled();
    expect(mocks.rpc).toHaveBeenCalledWith("fn_amigo_save_config", {
      p_org: org,
      p_actor: actor,
      p_input: { allow_same_day: false, months_ahead: 3 },
      p_ciphertext: null,
      p_connection: connection,
    });
  });
  it("rejects a unit outside the validated token's places", async () => {
    await expect(
      saveAmigoConfig(org, actor, { token: "secret-token-1234", default_place_id: 99 }),
    ).rejects.toThrow("unidade");
    expect(mocks.rpc).not.toHaveBeenCalledWith("fn_amigo_save_config", expect.anything());
  });
  it("checks selected unit against the existing token before activation and pins its connection", async () => {
    replies.amigo_connections.data = { ...row, default_place_id: 7 };
    await saveAmigoConfig(org, actor, { active: true });
    expect(mocks.request).toHaveBeenCalledWith("secret-token-1234", "places", {});
    expect(mocks.rpc).toHaveBeenCalledWith("fn_amigo_save_config", {
      p_org: org,
      p_actor: actor,
      p_input: { active: true },
      p_ciphertext: null,
      p_connection: connection,
    });
  });
  it("rejects activation with a stale/nonexistent unit", async () => {
    replies.amigo_connections.data = { ...row, default_place_id: 99 };
    await expect(saveAmigoConfig(org, actor, { active: true })).rejects.toThrow("unidade");
  });
  it("reports storage/disconnect/credential-read failures without raw errors", async () => {
    mocks.rpc.mockResolvedValue({ data: null, error: { message: "secret-token-1234" } });
    await expect(disconnectAmigo(org)).rejects.toThrow("desconectar");
    replies.amigo_credentials = { data: null, error: { code: "42501" } };
    await expect(loadAmigoConnection(org)).rejects.toThrow("credencial");
  });
  it("provisions by service RPC with explicit failure", async () => {
    await provisionAmigo();
    expect(mocks.rpc).toHaveBeenCalledWith("fn_provision_amigo");
    mocks.rpc.mockResolvedValue({ data: null, error: { message: "secret" } });
    await expect(provisionAmigo()).rejects.toThrow("preparar");
  });
  it("disconnects atomically through org-scoped privileged RPC", async () => {
    await disconnectAmigo(org);
    expect(mocks.rpc).toHaveBeenCalledWith("fn_amigo_disconnect", { p_org: org });
  });
});
describe("private connection loader", () => {
  it("loads configured inactive connection with private token after org-scoped read", async () => {
    expect(await loadAmigoConnection(org)).toMatchObject({
      id: connection,
      token: "secret-token-1234",
      active: false,
    });
    const query = queries.find((q) => q.table === "amigo_credentials")!;
    expect(query.methods).toContainEqual(["eq", ["organization_id", org]]);
    expect(query.methods).toContainEqual(["eq", ["connection_id", connection]]);
  });
  it("returns null when unconfigured without accessing credentials", async () => {
    replies.amigo_connections.data = null;
    expect(await loadAmigoConnection(org)).toBeNull();
    expect(mocks.decrypt).not.toHaveBeenCalled();
  });
  it("fails closed when credential cannot be decrypted", async () => {
    mocks.decrypt.mockResolvedValue(null);
    await expect(loadAmigoConnection(org)).rejects.toThrow("credencial");
  });
});
