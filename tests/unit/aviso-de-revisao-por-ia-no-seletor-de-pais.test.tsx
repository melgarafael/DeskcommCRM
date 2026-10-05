/**
 * A TELA DIZ QUE A REVISÃO DE PORTUGAL FOI FEITA POR IA (doc 88).
 *
 * A ajuda do seletor afirma "Só aparecem países com a lei revisada". Com
 * Portugal revisado por IA, sem advogado, essa frase sozinha induz em erro quem
 * responde pelo documento. O aviso também diz o efeito no fluxo que o operador
 * não vê: trocar para Portugal faz CPF chegar como "NIF inválido".
 */
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { TenantForm } from "@/app/app/settings/tenant/_form";
import { IdiomaProvider } from "@/lib/i18n/IdiomaProvider";
import type { TenantInput } from "@/lib/schemas/settings";

vi.mock("@/app/actions/settings/updateTenant", () => ({
  updateTenant: vi.fn(async () => ({ ok: true })),
}));

const BASE: TenantInput = {
  display_name: "Empresa",
  legal_name: "Empresa Lda",
  cnpj: null,
  timezone: "Europe/Lisbon",
  locale: "pt-BR",
  currency: "EUR",
  media_retention_days: 365,
  media_retention_enforced: true,
  dpo_email: null,
  privacy_policy_url: null,
};

function tela(country: string | null, locale: "pt-BR" | "es" = "pt-BR") {
  render(
    <IdiomaProvider locale={locale}>
      <TenantForm initial={{ ...BASE, country }} />
    </IdiomaProvider>,
  );
}

describe("aviso de revisão por IA no seletor de país", () => {
  it("Portugal escolhido: o aviso aparece, com IA, o efeito no NIF e o \"em regra\"", () => {
    tela("PT");
    const aviso = screen.getByTestId("aviso-revisao-por-ia");
    expect(aviso.getAttribute("role")).toBe("note");
    const texto = aviso.textContent ?? "";
    expect(texto).toContain("revisão feita por IA, sem advogado em Portugal");
    expect(texto).toContain("recusado como NIF inválido");
    expect(texto).toContain("em regra, exigem consentimento prévio (Lei 41/2004, art. 13.º-A)");
  });

  it("Brasil (escrito ou vazio): nenhum aviso", () => {
    tela("BR");
    expect(screen.queryByTestId("aviso-revisao-por-ia")).toBeNull();
  });

  it("país vazio vale Brasil: nenhum aviso", () => {
    tela(null);
    expect(screen.queryByTestId("aviso-revisao-por-ia")).toBeNull();
  });

  it("em espanhol o aviso sai traduzido", () => {
    tela("PT", "es");
    expect(screen.getByTestId("aviso-revisao-por-ia").textContent).toContain("revisión hecha por IA");
  });
});
