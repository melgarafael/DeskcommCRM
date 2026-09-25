import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { traduzir } from "@/lib/i18n/dicionario";
import { IDIOMAS } from "@/lib/i18n/idiomas";

/**
 * O AVISO "SEM CHAVE DE IA" NÃO DOBRA A PREPOSIÇÃO.
 *
 * `app/onboarding/setup-ai/_form.tsx` monta a frase com `t("<prefixo>")` +
 * `provedorLegivel()`, e `provedorLegivel()` já começa com a preposição
 * (`t("da")` + provedor, ou `t("da inteligência escolhida na instalação")`).
 * Com o prefixo "Não achei chave de", a tela dizia "Não achei chave de da
 * Anthropic (Claude)" — e, em espanhol, "No encontré ninguna clave de de la".
 *
 * O prefixo é lido do próprio formulário, então trocar a frase lá sem ajustar
 * o dicionário (ou o contrário) cai aqui.
 */

const FORM = readFileSync(join(process.cwd(), "app/onboarding/setup-ai/_form.tsx"), "utf8");
const PREFIXO = /\{t\("([^"]+)"\)\}\s*\{provedorLegivel\(/.exec(FORM)?.[1];
const INICIOS_DO_PROVEDOR = ["da", "da inteligência escolhida na instalação"];

describe("aviso de onboarding sem chave de IA", () => {
  it("o formulário ainda monta a frase com um prefixo + provedorLegivel()", () => {
    expect(PREFIXO, "o padrão t(\"…\") {provedorLegivel(…)} sumiu do _form.tsx").toBeTruthy();
  });

  it.each(IDIOMAS)("%s: o prefixo não termina em preposição (provedorLegivel já traz a sua)", (idioma) => {
    const prefixo = traduzir(PREFIXO ?? "", idioma).trim();
    for (const inicio of INICIOS_DO_PROVEDOR) {
      const frase = `${prefixo} ${traduzir(inicio, idioma)}`;
      expect(frase).not.toMatch(/\b(de|da|do|del)\s+(de|da|do|del)\b/i);
    }
  });
});
