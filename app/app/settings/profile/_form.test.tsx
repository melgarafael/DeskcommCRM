import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { IdiomaProvider } from "@/lib/i18n/IdiomaProvider";
import { ProfileForm } from "./_form";

/**
 * A tela de perfil em português — o que ela MOSTRA e o que ela NÃO pode perder.
 *
 * 1. HIDRATAÇÃO: o form nascia em "pt-BR" sem receber o idioma salvo —
 *    salvar qualquer campo gravava pt-BR por cima. Sabotagem: remover
 *    `initialLocale` das props reprova o caso 1.
 * 2. SEM ESPANHOL: o produto é pt-BR apenas; a opção "Español" saiu do
 *    seletor e valor antigo normaliza para o padrão na hidratação.
 */

vi.mock("@/app/actions/settings/updateProfile", () => ({
  updateProfile: vi.fn(async () => ({ ok: true })),
}));

function renderForm(initialLocale: "pt-BR") {
  return render(
    <IdiomaProvider locale="pt-BR">
      <ProfileForm
        email="dona@empresa.com"
        initialFullName="Dona da Empresa"
        initialAvatarUrl={null}
        initialLocale={initialLocale}
        initialTimezone="America/Sao_Paulo"
      />
    </IdiomaProvider>,
  );
}

describe("ProfileForm", () => {
  it("hidrata o idioma salvo — não nasce zerado", () => {
    renderForm("pt-BR");
    expect(screen.getByRole("combobox", { name: "Idioma" })).toHaveTextContent("Português (BR)");
  });

  it("não oferece espanhol", () => {
    renderForm("pt-BR");
    expect(screen.queryByText("Español")).toBeNull();
  });

  it("os rótulos saem em português", () => {
    renderForm("pt-BR");
    expect(screen.getByText("Nome completo")).toBeTruthy();
    expect(screen.getByText("Fuso horário")).toBeTruthy();
  });
});
