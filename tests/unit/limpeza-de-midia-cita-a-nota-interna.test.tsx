/**
 * LIGAR A LIMPEZA CONSENTIMENTO O QUE E APAGADO DE VERDADE.
 *
 * Com o #2309 a "Limpeza automática de mídia antiga" apaga também o anexo de
 * NOTA INTERNA que venceu o prazo. O `window.confirm` de quem liga o
 * interruptor ainda só falava de "mídia de mensagem", e a frase de estado
 * falava só de "mídia das conversas" — um consentimento para ação
 * irreversível que subdeclara o que ele cobre (issue #2428).
 *
 * O teste abre a tela, liga o interruptor e lê o que o confirm devolve; depois
 * confere as três frases de estado (desligado / ligado / confirm) em pt e em
 * es, e que o catálogo en tem as chaves novas.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { TenantForm } from "@/app/app/settings/tenant/_form";
import { IdiomaProvider } from "@/lib/i18n/IdiomaProvider";
import { traduzir } from "@/lib/i18n/dicionario";
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
  media_retention_days: 90,
  media_retention_enforced: false,
  dpo_email: null,
  privacy_policy_url: null,
};

function tela(locale: "pt-BR" | "es" = "pt-BR", enforced = false) {
  render(
    <IdiomaProvider locale={locale}>
      <TenantForm initial={{ ...BASE, media_retention_enforced: enforced }} />
    </IdiomaProvider>,
  );
}

const FRASE_CONFIRM = "Ao ligar, a mídia de mensagem e o anexo de nota interna com mais de {n} dias começarão a ser apagados.";
const FRASE_DESLIGADO = "Desligado: a mídia das conversas e os anexos de nota interna não são apagados por idade.";
const FRASE_LIGADO = "Ligado: apaga a mídia e o anexo de nota interna com mais de {n} dias.";

describe("a confirmação de ligar a limpeza cita o anexo de nota interna", () => {
  it("o confirm menciona a nota interna, não só a mídia de mensagem", () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    tela("pt-BR", false);

    const chave = document.getElementById("media_retention_enforced");
    expect(chave, "o interruptor da limpeza precisa estar na tela").toBeTruthy();
    fireEvent.click(chave as Element);

    expect(confirm, "o confirm precisa ser chamado").toHaveBeenCalledTimes(1);
    const chamada = confirm.mock.calls[0];
    const texto = String(chamada?.[0] ?? "");
    expect(texto).toContain("nota interna");
    expect(texto).toContain("90");
    // a frase velha subdeclarava — não pode voltar
    expect(texto).not.toBe(
      "Ao ligar, a mídia de mensagem com mais de 90 dias começará a ser apagada.",
    );
    confirm.mockRestore();
  });

  it("a frase de ESTADO (desligado) também cita a nota interna", () => {
    tela("pt-BR", false);
    const paragrafo = screen
      .getAllByText(/Desligado:|Desactivado:/)
      .map((n) => n.textContent ?? "")
      .join(" ");
    expect(paragrafo).toContain("nota interna");
  });

  it("a frase de ESTADO (ligado) também cita a nota interna", () => {
    tela("pt-BR", true);
    const paragrafo = screen
      .getAllByText(/Ligado:|Activado:/)
      .map((n) => n.textContent ?? "")
      .join(" ");
    expect(paragrafo).toContain("nota interna");
  });

  it("em espanhol as três frases citam a nota interna", () => {
    expect(traduzir(FRASE_CONFIRM, "es")).toContain("notas internas");
    expect(traduzir(FRASE_DESLIGADO, "es")).toContain("notas internas");
    expect(traduzir(FRASE_LIGADO, "es")).toContain("notas internas");
  });

  it("o catálogo en tem as três chaves novas", () => {
    const caminho = join(__dirname, "..", "..", "lib", "i18n", "traducoes", "en.json");
    const en = JSON.parse(readFileSync(caminho, "utf8")) as Record<string, string>;
    for (const chave of [FRASE_CONFIRM, FRASE_DESLIGADO, FRASE_LIGADO]) {
      expect(en[chave], `falta a tradução en de ${chave.slice(0, 40)}`).toBeTruthy();
    }
  });
});
