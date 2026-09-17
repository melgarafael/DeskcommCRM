import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createAdminClient } from "@/lib/supabase/admin";
import { GET } from "./route";

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));

describe("reserva de orçamento do Advomax", () => {
  beforeEach(() => { vi.clearAllMocks(); process.env.ADVOMAX_CRM_INTEGRATION_KEY = "segredo"; });

  it("recusa chave inválida antes de consultar ou reservar orçamento", async () => {
    const req = new NextRequest("http://localhost/api/v1/integrations/advomax/ai/budget?purpose=max&model=deepseek-v4-flash&external_request_id=11111111-1111-4111-8111-111111111111&estimated_input_tokens=0&max_output_tokens=100", {
      headers: { "X-CRM-Integration-Key": "errada" },
    });
    expect((await GET(req)).status).toBe(401);
    expect(createAdminClient).not.toHaveBeenCalled();
  });

  it("recusa reserva sem chave idempotente antes do banco", async () => {
    const req = new NextRequest("http://localhost/api/v1/integrations/advomax/ai/budget?purpose=max&model=deepseek-v4-flash&estimated_input_tokens=0&max_output_tokens=100", {
      headers: { "X-CRM-Integration-Key": "segredo", "X-CRM-Organization-Id": "11111111-1111-4111-8111-111111111111", "X-Advomax-Empresa-Codigo": "7" },
    });
    expect((await GET(req)).status).toBe(422);
    expect(createAdminClient).not.toHaveBeenCalled();
  });
});
