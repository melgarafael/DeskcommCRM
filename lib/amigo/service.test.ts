import { beforeEach, describe, expect, it, vi } from "vitest";
const gateways = vi.hoisted(() => ({ load: vi.fn(), request: vi.fn(), db: vi.fn() }));
vi.mock("./store", () => ({ loadAmigoConnection: gateways.load }));
vi.mock("./transport", () => ({ requestAmigo: gateways.request }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: gateways.db }));
import { executeAmigo } from "./service";

describe("serviço compartilhado Amigo", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  it("recusa operação automática global antes de buscar o token", async () => {
    await expect(
      executeAmigo(
        {
          organizationId: "org",
          actor: { type: "ai_agent", id: "run", role: "admin" },
          role: "admin",
          requestId: "r",
          contactId: "contato",
        },
        "patient_birthdays",
        { date: "11-06" },
      ),
    ).rejects.toMatchObject({ status: 403 });
    expect(gateways.load).not.toHaveBeenCalled();
    expect(gateways.request).not.toHaveBeenCalled();
  });
  it("sem configuração não faz uma chamada externa", async () => {
    gateways.load.mockResolvedValue(null);
    await expect(
      executeAmigo(
        {
          organizationId: "org",
          actor: { type: "user", id: "u", role: "admin" },
          role: "admin",
          requestId: "r",
        },
        "places",
        {},
      ),
    ).rejects.toMatchObject({ code: "amigo_not_configured" });
    expect(gateways.request).not.toHaveBeenCalled();
  });
  it("usa credencial do servidor e nunca devolve token na resposta", async () => {
    gateways.load.mockResolvedValue({
      id: "c",
      token: "fixture-secret",
      active: false,
      timezone: "America/Fortaleza",
    });
    gateways.request.mockResolvedValue({
      data: [{ id: 3, name: "Unidade teste" }],
      status: "success",
    });
    const result = await executeAmigo(
      {
        organizationId: "org",
        actor: { type: "user", id: "u", role: "admin" },
        role: "admin",
        requestId: "r",
      },
      "places",
      {},
    );
    expect(result).toMatchObject({ data: [{ id: 3, name: "Unidade teste" }] });
    expect(JSON.stringify(result)).not.toContain("fixture-secret");
  });
});
