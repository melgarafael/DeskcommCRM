/**
 * D-6 / spec da cobrança §9: o painel do tenant mostra o TIPO da suspensão.
 * "Reativar tenant" só para a administrativa; a de cobrança sai pelo card
 * Cobrança (Dar prazo / Tornar isenta) — a rota /reactivate da PR 1 a recusa
 * com `suspensao_de_cobranca`, e um botão que sempre falha é o "o botão não
 * funciona" que a D-6 quer evitar.
 */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/components/admin/tenants/SuspendDialog", () => ({ SuspendDialog: () => null }));
vi.mock("@/components/admin/tenants/ReactivateDialog", () => ({ ReactivateDialog: () => null }));
vi.mock("@/components/admin/ImpersonateButton", () => ({ ImpersonateButton: () => null }));

import { TenantActions } from "@/components/admin/tenants/TenantActions";

const ORG = "bbbbbbbb-0000-4000-8000-000000000001";
afterEach(cleanup);

describe("TenantActions — o tipo da suspensão decide a saída", () => {
  it("⭐ suspensa por cobrança: diz o tipo, esconde 'Reativar tenant' e aponta o card Cobrança", () => {
    render(<TenantActions organizationId={ORG} status="suspended" suspendedKind="cobranca" displayName="B" />);
    expect(screen.getByTestId("tipo-da-suspensao").textContent).toBe("Suspensa por falta de pagamento");
    expect(screen.queryByRole("button", { name: "Reativar tenant" })).toBeNull();
    expect(screen.getByText("Para reativar, use o card Cobrança: Dar prazo ou Tornar isenta.")).toBeTruthy();
  });

  it("suspensão administrativa: diz o tipo e mantém 'Reativar tenant'", () => {
    render(<TenantActions organizationId={ORG} status="suspended" suspendedKind="administrativa" displayName="B" />);
    expect(screen.getByTestId("tipo-da-suspensao").textContent).toBe("Suspensão administrativa");
    expect(screen.getByRole("button", { name: "Reativar tenant" })).toBeTruthy();
  });

  it("ativa: nenhum tipo, e 'Suspender tenant' presente", () => {
    render(<TenantActions organizationId={ORG} status="active" displayName="B" />);
    expect(screen.queryByTestId("tipo-da-suspensao")).toBeNull();
    expect(screen.getByRole("button", { name: "Suspender tenant" })).toBeTruthy();
  });
});
