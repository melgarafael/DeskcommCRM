import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { AuditoriaDoSite } from "./AuditoriaDoSite";
import type { OfertaDaCampanha } from "@/lib/prospecting/schema";
import { COMPLEMENTO_SEM_SITE, COMPLEMENTO_TRES } from "../../tests/support/prospeccao-ofertas-fixture";

vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (texto: string) => texto }));

function mostrar(ofertas: OfertaDaCampanha[]) {
  return render(<AuditoriaDoSite
    site={{ classe: "agregador", problemas: [], checklist: { tem: [], falta: [] } }}
    nota={null} numAvaliacoes={null} temInstagram={false} ofertas={ofertas}
    nicho="Clínicas" status="sent"
  />);
}

describe("complemento das ofertas no componente real da auditoria", () => {
  it("três ofertas mostram as duas automações ao lado do site", () => {
    mostrar(["site", "automacao_crm", "automacao_n8n"]);
    expect(screen.getByText(COMPLEMENTO_TRES, { exact: true })).toBeVisible();
    for (const rotulo of screen.getAllByText("Só rede social", { exact: true })) expect(rotulo).toBeVisible();
  });

  it("só site conserva o cenário e não mostra complemento de automação", () => {
    mostrar(["site"]);
    for (const rotulo of screen.getAllByText("Só rede social", { exact: true })) expect(rotulo).toBeVisible();
    expect(screen.queryByText(/sem trocar ninguém da equipe/)).toBeNull();
  });

  it("as duas automações sem site mostram a frase nova sem prefixo de site", () => {
    mostrar(["automacao_crm", "automacao_n8n"]);
    const frase = screen.getByText(COMPLEMENTO_SEM_SITE, { exact: true });
    expect(frase).toBeVisible();
    expect(frase).not.toHaveTextContent(/site/i);
    for (const rotulo of screen.getAllByText("Só rede social", { exact: true })) expect(rotulo).toBeVisible();
  });
});
