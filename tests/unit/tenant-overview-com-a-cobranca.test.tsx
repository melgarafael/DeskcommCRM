/**
 * Spec da cobrança §9 (D-2): com a chave desligada, o badge "Plano" do
 * TenantOverview segue igual; ligada, ele some — o card Cobrança mostra o plano
 * de cobrança e "Rótulo antigo: X". Dois "Plano" diferentes na mesma tela
 * confundiam o dono.
 */
import { cleanup, render, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { TenantOverview } from "@/components/admin/tenants/TenantOverview";
import type { TenantCounts, TenantOrganization } from "@/hooks/useTenantDetail";

const ORG: TenantOrganization = {
  id: "33333333-3333-4333-8333-333333333333",
  slug: "acme",
  display_name: "Acme",
  legal_name: null,
  cnpj: null,
  status: "active",
  onboarded_at: null,
  suspended_at: null,
  created_at: "2026-01-01T12:00:00.000Z",
  settings: { plan: "pro" },
};
const COUNTS: TenantCounts = {
  user_count: 1, conversations_count: 0, messages_count: 0, leads_count: 0, orders_count: 0,
  lgpd_requests_pending: 0, ai_invocations_30d: 0, waha_sessions_count: 0,
};
const INTEGRACOES = { nuvemshop_status: null, nuvemshop_connected_at: null };
afterEach(cleanup);

describe("TenantOverview — o badge Plano e a chave da cobrança", () => {
  it("desligada (padrão): o badge do rótulo antigo segue igual", () => {
    const { container } = render(<TenantOverview organization={ORG} counts={COUNTS} integrations={INTEGRACOES} />);
    expect(within(container).getByText("Plano").nextElementSibling?.textContent).toBe("pro");
  });

  it("⭐ ligada: nenhuma linha 'Plano' no overview", () => {
    const { container } = render(<TenantOverview organization={ORG} counts={COUNTS} integrations={INTEGRACOES} cobrancaLigada />);
    expect(within(container).queryByText("Plano")).toBeNull();
  });
});
