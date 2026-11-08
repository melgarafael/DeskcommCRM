import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { AuditFiltersAdmin } from "./AuditFiltersAdmin";

/**
 * A BUSCA DOS FILTROS DO PAINEL DE AUDITORIA IGNORA ACENTO (#4168).
 *
 * O rótulo da opção vem do banco/vocabulário — "Clínica Ação", no caso do
 * tenant. A busca do popover comparava `label.toLowerCase().includes(...)`:
 * `exclusao`/`clinica acao` não achavam nada, e o filtro parecia não ter a
 * opção.
 *
 * A régua é `termoSemAcento` (`lib/inbox/termo-de-busca`), a mesma da busca do
 * Inbox — os dois lados passam por ela.
 */

const TENANTS = [{ id: "t-1", slug: "clinica-acao", display_name: "Clínica Ação" }];

function abrirTenants() {
  render(<AuditFiltersAdmin filters={{}} onChange={() => {}} tenants={TENANTS} />);
  fireEvent.click(screen.getByRole("button", { name: "Tenants" }));
  const painel = screen.getByRole("dialog");
  return { painel, busca: within(painel).getByPlaceholderText("Buscar...") };
}

describe("busca dos filtros do painel de auditoria", () => {
  it("acha a opção acentuada digitando sem acento (#4168)", () => {
    const { painel, busca } = abrirTenants();

    fireEvent.change(busca, { target: { value: "clinica acao" } });

    expect(within(painel).getByRole("button", { name: "Clínica Ação (clinica-acao)" })).toBeTruthy();
  });

  it("controle negativo: termo que não casa continua não achando", () => {
    const { painel, busca } = abrirTenants();

    fireEvent.change(busca, { target: { value: "zzz" } });

    expect(within(painel).queryByRole("button", { name: "Clínica Ação (clinica-acao)" })).toBeNull();
    expect(within(painel).getByText("Nenhum resultado")).toBeTruthy();
  });
});
