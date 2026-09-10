import { beforeEach, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const deps = vi.hoisted(() => ({ support: vi.fn(), role: vi.fn(), guardar: vi.fn() }));

vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: deps.support }));
vi.mock("@/lib/auth/require-role", () => ({ requireRole: deps.role }));
vi.mock("@/lib/ai/credenciais/guardar", () => ({ guardarCredencial: deps.guardar }));

import { POST } from "@/app/api/v1/ai/credentials/route";

const admin = {
  ok: true,
  user: { id: "admin-1", idioma: "pt-BR" },
  org: { orgId: "org-1" },
};

beforeEach(() => {
  vi.resetAllMocks();
  deps.support.mockResolvedValue(null);
  deps.role.mockResolvedValue(admin);
});

const post = (body: unknown) =>
  new NextRequest("http://localhost/api/v1/ai/credentials", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

it("openai-codex é recusado na via de chave colada (vínculo é OAuth)", async () => {
  const res = await POST(post({ provider: "openai-codex", label: "X", api_key: "qualquer-coisa" }));
  expect(res.status).toBe(422);
  expect(deps.guardar).not.toHaveBeenCalled();
});
