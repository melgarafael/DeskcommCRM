import { describe, expect, it } from "vitest";
import { configuracaoDeEmailsAuth } from "./configuracao-auth";
import { estruturaDeEmail } from "./estrutura";
import { melhorFrenteSobre, razaoDeContraste } from "@/lib/branding/contraste";
import { NEUTROS_DE_SAIDA } from "@/lib/branding/saida";
import type { MarcaDeSaida } from "@/lib/branding/saida";

const marca: MarcaDeSaida = {
  nome: "Instalação & Filhos",
  logoUrl: null,
  accent: "#ab5498",
  accentFg: melhorFrenteSobre("#ab5498"),
  origens: { nome: "instalacao", cor: "instalacao" },
};
describe("catálogo de e-mails Auth", () => {
  it("cobre 13 tipos sem modificar configuração de transporte, segurança ou URLs", () => {
    const config = configuracaoDeEmailsAuth(marca);
    expect(Object.keys(config)).toHaveLength(26);
    for (const [key, value] of Object.entries(config)) {
      expect(key).toMatch(/^mailer_(subjects_|templates_)/);
      if (key.startsWith("mailer_templates_")) {
        expect(value).toContain("Instalação &amp; Filhos");
        expect(value).toContain('role="presentation"');
        expect(value).toContain(marca.accent);
        expect(value).not.toContain("<img");
      }
    }
    expect(config.mailer_templates_confirmation_content).toContain(
      "{{ .RedirectTo }}&token_hash={{ .TokenHash }}",
    );
    expect(config.mailer_templates_recovery_content).toContain(
      "{{ .RedirectTo }}&token_hash={{ .TokenHash }}",
    );
    expect(config.mailer_templates_reauthentication_content).toContain("{{ .Token }}");
  });
  it("não mistura organizações entre renderizações e mostra identidade mesmo sem logo", () => {
    const a = estruturaDeEmail(
      { ...marca, nome: "Org A", logoUrl: "https://a.example.test/logo.png" },
      "<p>Oi</p>",
    );
    const b = estruturaDeEmail({ ...marca, nome: "Org B" }, "<p>Oi</p>");
    expect(a).toContain("https://a.example.test/logo.png");
    expect(b).toContain("Org B");
    expect(b).not.toContain("Org A");
    expect(b).not.toContain("<img");
  });
  it.each(["#ffff00", "#ab5498", "#000000", "#ffffff"])("frente legível para %s", (accent) => {
    expect(razaoDeContraste(accent, melhorFrenteSobre(accent))).toBeGreaterThanOrEqual(4.5);
  });
});

it("rodapé mantém contraste mínimo no fundo do e-mail", () => {
  expect(razaoDeContraste(NEUTROS_DE_SAIDA.suave, NEUTROS_DE_SAIDA.fundo)).toBeGreaterThanOrEqual(
    4.5,
  );
});
