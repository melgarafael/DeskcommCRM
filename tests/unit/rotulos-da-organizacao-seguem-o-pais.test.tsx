/**
 * A TELA DA ORGANIZAÇÃO LÊ OS RÓTULOS DO PERFIL DO PAÍS (issue #1946, item 4).
 *
 * Medido na tela de Configurações › Organização: `legal_name` e `cnpj` eram
 * rotulados em duro com "Razão social" e "CNPJ". O PR #1945 tirou o Brasil das
 * telas de negócio e de contato, mas a tela da organização ficou para trás — e
 * ela é justamente onde o PAÍS se escolhe, ao lado dos campos que rotula.
 *
 * Os dois rótulos vêm de `perfil.empresa` (mesmo formato do `documento.rotulo`
 * do titular), então a mesma troca de país que muda o documento do contato
 * muda estes dois. O último caso lê o ARQUIVO: o defeito era literal escrito,
 * e literais voltam sem quebrar teste nenhum de renderização.
 *
 * FORA DAQUI, declarado na issue: a validação do número (NIF × CNPJ) e a
 * decisão do prazo não entram neste item — só os rótulos visíveis.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

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

describe("os rótulos da organização seguem o perfil do país", () => {
  it("Brasil rotula 'Razão social' e 'CNPJ', e nada de rótulo português", () => {
    tela("BR");
    expect(screen.getByLabelText("Razão social")).toBeTruthy();
    expect(screen.getByLabelText("CNPJ")).toBeTruthy();
    expect(screen.queryByLabelText("Denominação social")).toBeNull();
    expect(screen.queryByLabelText("NIPC")).toBeNull();
  });

  it("Portugal rotula 'Denominação social' e 'NIPC', e nada de rótulo brasileiro", () => {
    tela("PT");
    expect(screen.getByLabelText("Denominação social")).toBeTruthy();
    expect(screen.getByLabelText("NIPC")).toBeTruthy();
    expect(screen.queryByLabelText("Razão social")).toBeNull();
    expect(screen.queryByLabelText("CNPJ")).toBeNull();
  });

  it("país vazio (a coluna nula) vale Brasil — o mesmo degrau do resto do perfil", () => {
    tela(null);
    expect(screen.getByLabelText("Razão social")).toBeTruthy();
    expect(screen.getByLabelText("CNPJ")).toBeTruthy();
  });

  it("em espanhol os rótulos de Portugal saem traduzidos", () => {
    tela("PT", "es");
    expect(screen.getByLabelText("Denominación social")).toBeTruthy();
    expect(screen.getByLabelText("NIPC")).toBeTruthy();
  });

  it("o arquivo não guarda mais os literais brasileiros — o defeito era literal", () => {
    const fonte = readFileSync(
      join(__dirname, "..", "..", "app", "app", "settings", "tenant", "_form.tsx"),
      "utf8",
    );
    expect(fonte).not.toContain('t("Razão social")');
    expect(fonte).not.toContain('t("CNPJ")');
    expect(fonte).toContain("perfil.empresa.rotuloNomeLegal");
    expect(fonte).toContain("perfil.empresa.rotuloNumero");
  });
});
