/**
 * O FILTRO DA AUDITORIA IGNORA ACENTO (#4168).
 *
 * O popover de filtro comparava `o.label.toLowerCase().includes(search.toLowerCase())`.
 * A lista de ações é feita de CÓDIGOS (`lgpd.exportacao`), sem acento por
 * construção — o texto acentuado que se digita ali vem das EMPRESAS
 * (`Exclusão Fiscal`, `Clínica São João`), e era justamente ele que não casava.
 *
 * A régua é a mesma das outras três telas: `termoSemAcento`
 * (`lib/inbox/termo-de-busca.ts`), nos dois lados da comparação.
 *
 * Prova de componente com o termo da issue; não houve digitação em navegador.
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (chave: string) => chave }));

import { AuditFiltersAdmin } from "@/components/admin/audit/AuditFiltersAdmin";

const EMPRESAS = [
  // O slug é ASCII de propósito: se ele contivesse "exclusao", a busca casaria
  // pelo slug e o teste ficaria verde mesmo sem a régua — passaria pelo motivo
  // errado. Quem tem de casar é o `display_name` acentuado.
  { id: "t1", slug: "empresa-1", display_name: "Exclusão Fiscal" },
  { id: "t2", slug: "empresa-2", display_name: "Clínica São João" },
];

function montar() {
  render(<AuditFiltersAdmin filters={{}} onChange={vi.fn()} tenants={EMPRESAS} />);
}

async function buscar(termo: string) {
  fireEvent.click(screen.getByRole("button", { name: "Tenants" }));
  const campo = await screen.findByPlaceholderText("Buscar...");
  fireEvent.change(campo, { target: { value: termo } });
  return campo;
}

afterEach(cleanup);

describe('Auditoria: "exclusao" acha a opção "Exclusão"', () => {
  it("sem acento, a empresa acentuada continua sugerida — e só ela", async () => {
    montar();
    await buscar("exclusao");
    expect(screen.getByRole("button", { name: "Exclusão Fiscal (empresa-1)" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Clínica São João/ })).toBeNull();
  });

  it("termo que não existe continua devolvendo nenhum resultado", async () => {
    montar();
    await buscar("financeiro");
    expect(screen.getByText("Nenhum resultado")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Exclusão Fiscal/ })).toBeNull();
  });
});
