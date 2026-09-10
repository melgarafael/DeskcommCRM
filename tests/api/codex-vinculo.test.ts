import { beforeEach, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const deps = vi.hoisted(() => ({
  support: vi.fn(),
  role: vi.fn(),
  audit: vi.fn(),
  iniciar: vi.fn(),
  trocar: vi.fn(),
  salvar: vi.fn(),
  revogar: vi.fn(),
  statusRow: vi.fn(),
}));

vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: deps.support }));
vi.mock("@/lib/auth/require-role", () => ({ requireRole: deps.role }));
vi.mock("@/lib/audit", () => ({ audit: deps.audit }));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: () => ({
      select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: deps.statusRow }) }) }),
    }),
  }),
}));
vi.mock("@/lib/ai/codex/oauth", async (importOriginal) => ({
  ...((await importOriginal()) as object),
  iniciarDeviceCode: deps.iniciar,
  trocarDeviceCodePorTokens: deps.trocar,
}));
vi.mock("@/lib/ai/codex/armazenamento", () => ({
  salvarVinculo: deps.salvar,
  revogarVinculo: deps.revogar,
}));

import { GET, POST } from "@/app/api/v1/ai/credentials/codex/route";
import { POST as POLL } from "@/app/api/v1/ai/credentials/codex/poll/route";
import { POST as DISCONNECT } from "@/app/api/v1/ai/credentials/codex/disconnect/route";

const admin = { ok: true, user: { id: "admin-1", idioma: "pt-BR" }, org: { orgId: "org-1" } };
const manager = { ok: true, user: { id: "manager-1", idioma: "pt-BR" }, org: { orgId: "org-1" } };

beforeEach(() => {
  vi.resetAllMocks();
  deps.support.mockResolvedValue(null);
  deps.statusRow.mockResolvedValue({ data: null });
});

const post = (body: unknown) =>
  new NextRequest("http://localhost/api/v1/ai/credentials/codex", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

it("suporte somente leitura é barrado antes de tudo", async () => {
  deps.support.mockResolvedValue(new Response("readonly", { status: 403 }));
  expect((await POST(post({}))).status).toBe(403);
  expect(deps.role).not.toHaveBeenCalled();
});

it("GET sem vínculo devolve ausente (manager passa, sem segredo)", async () => {
  deps.role.mockResolvedValue(manager);
  const res = await GET();
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ data: { provider: "openai-codex", status: "ausente" } });
});

it("POST iniciar devolve user_code e audita (sem token na resposta)", async () => {
  deps.role.mockResolvedValue(admin);
  deps.iniciar.mockResolvedValue({
    userCode: "ABCD-1234",
    verificationUri: "https://x",
    expiresIn: 600,
    deviceCode: "dev-1",
    intervalSecs: 5,
  });
  const res = await POST(post({ label: "ChatGPT" }));
  expect(res.status).toBe(200);
  const corpo = (await res.json()) as { data: Record<string, unknown> };
  expect(corpo.data.user_code).toBe("ABCD-1234");
  expect(JSON.stringify(corpo)).not.toMatch(/refresh|access_token/i);
  expect(deps.audit).toHaveBeenCalledWith(expect.objectContaining({ action: "ai.codex.inicio" }));
});

it("POST iniciar sem client configurado → 500 misconfigured (R1, sem throw cru)", async () => {
  deps.role.mockResolvedValue(admin);
  deps.iniciar.mockRejectedValue(new Error("OPENAI_CODEX_CLIENT_ID ausente — defina o client OAuth (D1)."));
  const res = await POST(post({}));
  expect(res.status).toBe(500);
  const corpo = (await res.json()) as { error: { code: string } };
  expect(corpo.error.code).toBe("misconfigured");
});

it("POST iniciar com provedor fora → 502 ai_provider_error (sem throw cru)", async () => {
  deps.role.mockResolvedValue(admin);
  deps.iniciar.mockRejectedValue(new Error("codex_device_init_500"));
  const res = await POST(post({}));
  expect(res.status).toBe(502);
  const corpo = (await res.json()) as { error: { code: string } };
  expect(corpo.error.code).toBe("ai_provider_error");
});

it("poll pendente não grava nada", async () => {
  deps.role.mockResolvedValue(admin);
  deps.trocar.mockResolvedValue({ pendente: true });
  const res = await POLL(post({ device_auth_id: "device-12345", user_code: "ABCD-1234" }));
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ data: { pendente: true } });
  expect(deps.salvar).not.toHaveBeenCalled();
  expect(deps.audit).not.toHaveBeenCalled();
});

it("poll aprovado conecta sem vazar token e audita", async () => {
  deps.role.mockResolvedValue(admin);
  deps.trocar.mockResolvedValue({
    pendente: false,
    refreshToken: "rt-secreto",
    accessToken: "at-secreto",
    idToken: null,
    expiresIn: 3600,
  });
  deps.salvar.mockResolvedValue({ id: "vinc-1" });
  const res = await POLL(post({ device_auth_id: "device-12345", user_code: "ABCD-1234", label: "ChatGPT" }));
  expect(res.status).toBe(200);
  const corpo = (await res.json()) as { data: Record<string, unknown> };
  expect(corpo.data).toEqual({ conectado: true });
  expect(JSON.stringify(corpo)).not.toMatch(/rt-secreto|at-secreto/);
  expect(deps.salvar).toHaveBeenCalledWith(
    expect.objectContaining({
      orgId: "org-1",
      label: "ChatGPT",
      refreshToken: "rt-secreto",
      accountId: null,
    }),
  );
  expect(deps.audit).toHaveBeenCalledWith(
    expect.objectContaining({ action: "ai.codex.conexao", resourceId: "vinc-1" }),
  );
});

it("disconnect revoga e audita", async () => {
  deps.role.mockResolvedValue(admin);
  const res = await DISCONNECT();
  expect(res.status).toBe(200);
  expect(deps.revogar).toHaveBeenCalledOnce();
  expect(deps.audit).toHaveBeenCalledWith(expect.objectContaining({ action: "ai.codex.desconexao" }));
});

it("poll com troca falhando → 502 ai_provider_error (sem throw cru)", async () => {
  deps.role.mockResolvedValue(admin);
  deps.trocar.mockRejectedValue(new Error("codex_device_exchange_401"));
  const res = await POLL(post({ device_auth_id: "device-12345", user_code: "ABCD-1234" }));
  expect(res.status).toBe(502);
  const corpo = (await res.json()) as { error: { code: string } };
  expect(corpo.error.code).toBe("ai_provider_error");
  expect(deps.salvar).not.toHaveBeenCalled();
});

it("poll aprovado mas banco falhando → 500 internal_error (sem throw cru)", async () => {
  deps.role.mockResolvedValue(admin);
  deps.trocar.mockResolvedValue({
    pendente: false,
    refreshToken: "rt-secreto",
    accessToken: "at-secreto",
    idToken: null,
    expiresIn: 3600,
  });
  deps.salvar.mockRejectedValue(new Error("codex_vinculo_banco: connection refused"));
  const res = await POLL(post({ device_auth_id: "device-12345", user_code: "ABCD-1234" }));
  expect(res.status).toBe(500);
  const corpo = (await res.json()) as { error: { code: string } };
  expect(corpo.error.code).toBe("internal_error");
});
