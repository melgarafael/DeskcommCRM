/**
 * Excluir só existe para o tenant suspenso — e não para o suspenso por
 * COBRANÇA: excluí-lo deixaria a assinatura cobrando no provedor. O servidor
 * recusa do mesmo jeito (409 `exclusao_com_cobranca_pendente`); a tela não
 * oferece o botão e diz por quê.
 */
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { TenantCounts, TenantOrganization } from "@/hooks/useTenantDetail";

vi.mock("./SuspendDialog", () => ({ SuspendDialog: () => null }));
vi.mock("./ReactivateDialog", () => ({ ReactivateDialog: () => null }));
vi.mock("./DeleteTenantDialog", () => ({ DeleteTenantDialog: () => null }));
vi.mock("./EditTenantDialog", () => ({ EditTenantDialog: () => null }));
vi.mock("@/components/admin/ImpersonateButton", () => ({ ImpersonateButton: () => null }));

import { TenantActions } from "./TenantActions";

const ORG: TenantOrganization = {
  id: "33333333-3333-4333-8333-333333333333",
  slug: "acme",
  display_name: "Acme",
  legal_name: null,
  cnpj: null,
  status: "suspended",
  onboarded_at: null,
  suspended_at: "2026-10-01T12:00:00.000Z",
  suspended_kind: "administrativa",
  created_at: "2026-01-01T12:00:00.000Z",
  settings: null,
  country: null,
  timezone: null,
  locale: null,
  currency: null,
  media_retention_days: null,
  media_retention_enforced: true,
  dpo_email: null,
  privacy_policy_url: null,
};
const COUNTS = {} as TenantCounts;
const EXPLICACAO = /não pode ser excluída enquanto houver cobrança pendente/;

describe("TenantActions — excluir", () => {
  it("suspensão administrativa: o botão aparece", () => {
    render(<TenantActions organization={ORG} counts={COUNTS} />);
    expect(screen.getByRole("button", { name: "Excluir tenant" })).toBeInTheDocument();
    expect(screen.queryByText(EXPLICACAO)).toBeNull();
  });

  it("suspensão sem tipo (nula) vale como administrativa", () => {
    render(<TenantActions organization={{ ...ORG, suspended_kind: null }} counts={COUNTS} />);
    expect(screen.getByRole("button", { name: "Excluir tenant" })).toBeInTheDocument();
  });

  it("suspensão por cobrança: sem botão, com a explicação", () => {
    render(<TenantActions organization={{ ...ORG, suspended_kind: "cobranca" }} counts={COUNTS} />);
    expect(screen.queryByRole("button", { name: "Excluir tenant" })).toBeNull();
    expect(screen.getByText(EXPLICACAO)).toBeInTheDocument();
  });
});
