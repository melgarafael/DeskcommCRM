import { describe, expect, it, vi } from "vitest";

/**
 * Raiz do app: self-host (BILLING_MODE=disabled, default) continua indo
 * direto para /app, sem nenhuma mudança de comportamento. Só a instância com
 * BILLING_MODE=asaas ganha a landing comercial (Fase 4, ADR-0002).
 */

vi.mock("next/navigation", () => ({ redirect: vi.fn() }));
vi.mock("@/lib/asaas/config", () => ({ isBillingEnabled: vi.fn() }));
vi.mock("@/lib/branding/instalacao", () => ({ marcaDaInstalacao: vi.fn(async () => null) }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));

import { redirect } from "next/navigation";
import { isBillingEnabled } from "@/lib/asaas/config";
import { createAdminClient } from "@/lib/supabase/admin";

describe("HomePage", () => {
  it("self-host (billing desligado): redireciona para /app", async () => {
    vi.mocked(isBillingEnabled).mockReturnValue(false);
    const HomePage = (await import("./page")).default;
    await HomePage();
    expect(redirect).toHaveBeenCalledWith("/app");
  });

  it("instância com billing ligado: renderiza a landing em vez de redirecionar", async () => {
    vi.mocked(isBillingEnabled).mockReturnValue(true);
    vi.mocked(createAdminClient).mockReturnValue({
      from: () => ({
        select: () => ({
          eq: () => ({
            order: async () => ({ data: [], error: null }),
          }),
        }),
      }),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);

    vi.mocked(redirect).mockClear();
    const HomePage = (await import("./page")).default;
    const result = await HomePage();

    expect(redirect).not.toHaveBeenCalled();
    expect(result).toBeTruthy();
  });
});
