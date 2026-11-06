import { beforeEach, describe, expect, it, vi } from "vitest";
const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const f = vi.hoisted(() => ({
  context: vi.fn(),
  patch: vi.fn(),
  audit: vi.fn(),
  refresh: vi.fn(),
}));
vi.mock("@/app/actions/onboarding/_shared", () => ({
  requireOnboardingCtx: f.context,
  patchOnboardingState: f.patch,
  OnboardingError: class extends Error {
    constructor(
      public code: string,
      message: string,
    ) {
      super(message);
    }
  },
}));
vi.mock("@/lib/audit", () => ({ audit: f.audit }));
vi.mock("next/cache", () => ({ revalidatePath: f.refresh }));
vi.mock("next/navigation", () => ({
  redirect: (path: string) => {
    throw new Error(`REDIRECT:${path}`);
  },
}));
import { acceptWelcome } from "@/app/actions/onboarding/acceptWelcome";
import { OnboardingError } from "@/app/actions/onboarding/_shared";
function form(org: string | null = A) {
  const d = new FormData();
  if (org !== null) d.set("organization_id", org);
  d.set("display_name", "Empresa A");
  d.set("o_que_faz", "Serviços de teste");
  d.set("timezone", "America/Sao_Paulo");
  return d;
}
beforeEach(() => {
  vi.clearAllMocks();
  f.context.mockResolvedValue({ orgId: A, userId: "user-a", role: "admin" });
  f.patch.mockResolvedValue(undefined);
});
describe("welcome preserva organização e condição atômica do wizard", () => {
  it("outra organização devolvida pelo contexto nunca é renomeada", async () => {
    f.context.mockResolvedValue({ orgId: B, userId: "user-a", role: "admin" });
    expect(await acceptWelcome(form(A))).toEqual({ ok: false, error: "organization_changed" });
    expect(f.patch).not.toHaveBeenCalled();
    expect(f.audit).not.toHaveBeenCalled();
  });
  it.each([null, "inválido"])(
    "destino ausente ou inválido recusa antes de resolver contexto: %s",
    async (org) => {
      expect(await acceptWelcome(form(org))).toEqual({ ok: false, error: "organization_changed" });
      expect(f.context).not.toHaveBeenCalled();
      expect(f.patch).not.toHaveBeenCalled();
    },
  );
  it("pin do formulário é validado pelo contexto e só grava A em wizard", async () => {
    await expect(acceptWelcome(form())).rejects.toThrow("REDIRECT:/onboarding");
    expect(f.context).toHaveBeenCalledWith(A);
    expect(f.patch).toHaveBeenCalledWith(
      A,
      expect.objectContaining({
        welcome: expect.objectContaining({
          display_name: "Empresa A",
          o_que_faz: "Serviços de teste",
        }),
      }),
      { display_name: "Empresa A", timezone: "America/Sao_Paulo" },
      { soNoWizard: true },
    );
    expect(f.audit).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: A, action: "onboarding.welcome_completed" }),
    );
  });
  it("wizard concluído concorrentemente redireciona sem auditar sucesso", async () => {
    f.patch.mockRejectedValue(new OnboardingError("org_ja_configurada", "Já configurada"));
    await expect(acceptWelcome(form())).rejects.toThrow("REDIRECT:/app/inbox");
    expect(f.audit).not.toHaveBeenCalled();
    expect(f.refresh).not.toHaveBeenCalled();
  });
  it("falha de sessão não escreve", async () => {
    f.context.mockRejectedValue(new Error("sessão indisponível"));
    await expect(acceptWelcome(form())).rejects.toThrow("sessão indisponível");
    expect(f.patch).not.toHaveBeenCalled();
  });
});
