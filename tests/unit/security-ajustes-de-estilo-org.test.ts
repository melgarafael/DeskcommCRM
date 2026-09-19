// @vitest-environment node
import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const rota = fs.readFileSync(
  path.join(process.cwd(), "app/api/v1/ai/style-adjustments/route.ts"),
  "utf8",
);
const runtime = fs.readFileSync(
  path.join(process.cwd(), "lib/agent-engine/guardrails/ajustes-de-estilo-da-org.ts"),
  "utf8",
);

describe("segurança dos ajustes de estilo por organização", () => {
  it("escrita exige admin e respeita o bloqueio do suporte", () => {
    expect(rota).toContain('requireSupportWrite()');
    expect(rota).toContain('requireRole("admin", { resource: "ai_style_adjustments" })');
  });

  it("leitura e escrita prendem a organização autenticada", () => {
    expect(rota).toContain('.eq("organization_id", org.orgId)');
    expect(rota).toContain('organization_id: org.orgId');
    expect(runtime).toContain("where organization_id = $1");
  });

  it("não aceita localizar/substituir arbitrário no payload", () => {
    expect(rota).toContain("z.enum(AJUSTES_DE_ESTILO)");
    expect(rota).toContain(".strict()");
    expect(rota).not.toMatch(/find|replace|regex|pattern/i);
  });

  it("não usa service role numa rota de usuário", () => {
    expect(rota).toContain('createClient()');
    expect(rota).not.toMatch(/service.?role|createAdminClient|supabaseAdmin/i);
  });
});
