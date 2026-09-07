// @vitest-environment node
//
// Multipart real (File/FormData) precisa do realm do Node — jsdom (default do
// projeto) tem seu próprio File/FormData que corrompe o corpo ao passar pelo
// parser de multipart do NextRequest (undici). Provado isolando o roundtrip:
// jsdom FormData.set(nodeFile) coage pra string "[object File]" (Symbol de
// branding não bate entre realms); com o File global do runtime real (Node), o
// roundtrip preserva os bytes exatos do zip.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { zipSync, strToU8 } from "fflate";

import { requireRole } from "@/lib/auth/require-role";
import { audit } from "@/lib/audit";
import { importSkillPackage } from "@/lib/ai/skills/install";
import { fail } from "@/lib/api/wrappers";
import type { AuthUser } from "@/lib/auth/types";

/**
 * Task 5 — POST /api/v1/ai/skills/import (multipart .zip):
 *  - zip válido → chama importSkillPackage com org SEMPRE de requireRole (nunca
 *    do form) e responde { name, version_id } sem double-nest; audit ai.skill_imported;
 *  - zip inválido (parseSkillPackage falha) → 422 com o code do parser, sem
 *    chegar a chamar importSkillPackage.
 */

vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn(() => ({})) }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));
vi.mock("@/lib/ai/skills/db", () => ({ getSkillsPool: vi.fn(() => ({})) }));
vi.mock("@/lib/ai/skills/install", () => ({ importSkillPackage: vi.fn() }));

const ORG_ID = "22222222-2222-4222-8222-222222222222";
const USER_ID = "11111111-1111-4111-8111-111111111111";

function makeZip(files: Record<string, string>): Uint8Array {
  const entries: Record<string, Uint8Array> = {};
  for (const [p, c] of Object.entries(files)) entries[p] = strToU8(c);
  return zipSync(entries);
}

const validSkillMd = `---
name: frete-gratis
description: Explica a política de frete grátis ao cliente.
matcher:
  any_keywords: [frete, entrega]
---
Quando o cliente perguntar sobre frete, confirme o CEP.`;

function mockAuthzOk() {
  const user: AuthUser = {
    id: USER_ID,
    email: "a@example.com",
    full_name: null,
    avatar_url: null,
    is_platform_admin: false,
    idioma: "pt-BR" as const,
    organizations: [{ organization_id: ORG_ID, organization_name: "Org", role: "manager" }],
  };
  vi.mocked(requireRole).mockResolvedValue({
    ok: true,
    user,
    org: { orgId: ORG_ID, name: "Org", role: "manager" },
  });
}

function postReq(zipBytes: Uint8Array, filename = "skill.zip") {
  const form = new FormData();
  form.set("file", new File([zipBytes as BlobPart], filename, { type: "application/zip" }));
  return new NextRequest("http://localhost/api/v1/ai/skills/import", {
    method: "POST",
    body: form,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("POST /api/v1/ai/skills/import", () => {
  it("sem auth → repassa authz.response", async () => {
    vi.mocked(requireRole).mockResolvedValue({
      ok: false,
      response: fail("unauthenticated", "Auth required.", 401, {}),
    });
    const { POST } = await import("./route");
    const res = await POST(postReq(makeZip({ "SKILL.md": validSkillMd })));
    expect(res.status).toBe(401);
    expect(importSkillPackage).not.toHaveBeenCalled();
  });

  it("zip válido → importSkillPackage com org de requireRole, responde {name,version_id}, audita", async () => {
    mockAuthzOk();
    vi.mocked(importSkillPackage).mockResolvedValue({ versionId: "ver-1", name: "frete-gratis" });

    const { POST } = await import("./route");
    const res = await POST(postReq(makeZip({ "SKILL.md": validSkillMd })));

    expect(res.status).toBe(201);
    const body = (await res.json()) as { data: { name: string; version_id: string } };
    expect(body.data).toEqual({ name: "frete-gratis", version_id: "ver-1" });
    expect(body).not.toHaveProperty("data.data");

    expect(importSkillPackage).toHaveBeenCalledTimes(1);
    const [, input] = vi.mocked(importSkillPackage).mock.calls[0]!;
    expect(input.organizationId).toBe(ORG_ID); // org SEMPRE de requireRole, nunca do form
    expect(input.pkg.name).toBe("frete-gratis");

    expect(vi.mocked(audit)).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "ai.skill_imported",
        organizationId: ORG_ID,
        resourceId: "ver-1",
      }),
    );
  });

  it("zip inválido (sem SKILL.md) → 422 com o code do parser, sem chamar importSkillPackage", async () => {
    mockAuthzOk();
    const { POST } = await import("./route");
    const res = await POST(postReq(makeZip({ "leia.txt": "oi" })));

    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("skill_md_missing");
    expect(importSkillPackage).not.toHaveBeenCalled();
    expect(audit).not.toHaveBeenCalled();
  });

  it("campo 'file' ausente → 400 invalid_request", async () => {
    mockAuthzOk();
    const form = new FormData();
    const req = new NextRequest("http://localhost/api/v1/ai/skills/import", {
      method: "POST",
      body: form,
    });
    const { POST } = await import("./route");
    const res = await POST(req);
    expect(res.status).toBe(400);
  });

  it("content-length > 6MB → 413 skill_upload_too_large antes de bufferizar", async () => {
    mockAuthzOk();
    const req = new NextRequest("http://localhost/api/v1/ai/skills/import", {
      method: "POST",
      headers: { "content-length": "7000000" },
      body: new FormData(), // nunca é lido — guard falha antes
    });
    const { POST } = await import("./route");
    const res = await POST(req);
    expect(res.status).toBe(413);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("skill_upload_too_large");
    expect(importSkillPackage).not.toHaveBeenCalled();
  });
});

// Este teste isola o handler; autoridade de suporte é exercitada na suíte própria.
vi.mock("@/lib/impersonate/support", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/impersonate/support")>(),
  requireSupportWrite: vi.fn(async () => null),
  authenticatedSessionId: vi.fn(async () => "f2200000-0000-4000-8000-000000000099"),
}));
