import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createAdminClient } from "@/lib/supabase/admin";
import { POST } from "./route";
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
describe("consumo de IA do Advomax", () => {
  beforeEach(() => { vi.clearAllMocks(); process.env.ADVOMAX_CRM_INTEGRATION_KEY = "segredo"; });
  it("recusa chave inválida antes do banco", async () => {
    const req = new NextRequest("http://localhost/api/v1/integrations/advomax/ai/usage", { method: "POST", headers: { "content-type": "application/json", "X-CRM-Integration-Key": "errada" }, body: "{}" });
    expect((await POST(req)).status).toBe(401); expect(createAdminClient).not.toHaveBeenCalled();
  });
});
