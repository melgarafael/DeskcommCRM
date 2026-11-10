import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { UsageTable } from "@/components/admin/usage/UsageTable";
import type { UsageTenantRow } from "@/app/api/v1/admin/usage/route";
vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (s: string) => s }));
afterEach(() => vi.restoreAllMocks());
it("informa chamadas sem preço e exporta o custo em dólar", async () => {
  let exported = "";
  const blob = vi.fn(function (this: unknown, parts: string[]) {
    exported = parts.join("");
  });
  vi.stubGlobal("Blob", blob);
  const originalCreate = URL.createObjectURL;
  const originalRevoke = URL.revokeObjectURL;
  URL.createObjectURL = vi.fn(() => "blob:synthetic");
  URL.revokeObjectURL = vi.fn();
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
  try {
    const row: UsageTenantRow = {
      organization_id: "synthetic",
      tenant_name: "Empresa fictícia",
      tenant_slug: "fixture",
      messages_count: 0,
      conversations_count: 0,
      ai_invocations_count: 3,
      ai_tokens_total: 30,
      ai_cost_cents: 123,
      ai_unpriced_count: 2,
      agent_name: null,
    };
    render(<UsageTable tenants={[row]} range="30d" />);
    expect(screen.getByText("2 chamadas sem preço")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /CSV/i }));
    expect(exported.split("\n")[0]).toContain("custo_usd,chamadas_sem_preco");
    expect(exported.split("\n")[1]).toContain("1.23,2");
  } finally {
    URL.createObjectURL = originalCreate;
    URL.revokeObjectURL = originalRevoke;
    vi.unstubAllGlobals();
  }
});
