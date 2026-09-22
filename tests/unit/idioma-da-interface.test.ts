import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

/**
 * O IDIOMA DA INTERFACE — português (BR), único idioma do produto.
 *
 * O espanhol foi removido por decisão de produto: dicionário esvaziado,
 * seletor excluído, opções "Español" fora dos formulários e guardas de
 * cobertura apagados. `t()` segue como identidade (a chave É o texto pt-BR),
 * então nenhuma tela foi reescrita — e uma futura tradução volta sem migração.
 *
 * O que estes casos prendem: que "es" (ou qualquer outro valor antigo salvo
 * em perfil/empresa) cai no padrão em vez de vazar para a tela; que nenhum
 * seletor oferece idioma que não muda nada; e que os elos estruturais
 * (provider, cadeia pessoa→empresa→padrão, validação) continuam de pé.
 */
import { traduzir } from "@/lib/i18n/dicionario";
import { IDIOMAS, IDIOMA_PADRAO, normalizarIdioma } from "@/lib/i18n/idiomas";

describe("traduzir", () => {
  it("em português devolve a própria chave — ela É o texto", () => {
    expect(traduzir("Assumir", "pt-BR")).toBe("Assumir");
  });

  it("nunca devolve vazio", () => {
    for (const texto of ["Assumir", "qualquer coisa", "…"]) {
      for (const idioma of IDIOMAS) {
        expect(traduzir(texto, idioma).length).toBeGreaterThan(0);
      }
    }
  });
});

describe("normalizar o idioma que veio do perfil", () => {
  it("só conhece pt-BR — resto cai no padrão", () => {
    expect(normalizarIdioma("pt-BR")).toBe("pt-BR");
    // Perfis/empresas antigos ainda trazem "es" (e "en-US" de antes disso):
    // nenhum dos dois pode chegar à tela como idioma.
    expect(normalizarIdioma("es")).toBe(IDIOMA_PADRAO);
    expect(normalizarIdioma("en-US")).toBe(IDIOMA_PADRAO);
    expect(normalizarIdioma("klingon")).toBe(IDIOMA_PADRAO);
    expect(normalizarIdioma(null)).toBe(IDIOMA_PADRAO);
    expect(normalizarIdioma(undefined)).toBe(IDIOMA_PADRAO);
  });
});

describe("os elos que somem sem barulho", () => {
  it("o idioma CHEGA ao cliente, e por contexto PRÓPRIO", () => {
    // Buscá-lo numa consulta própria faria a tela aparecer num idioma e
    // trocar meio segundo depois, em toda navegação.
    expect(readFileSync("lib/auth/types.ts", "utf8")).toMatch(/locale\?: string \| null/);
    expect(readFileSync("lib/auth/server.ts", "utf8")).toMatch(
      /user\.user_metadata\?\.locale as string \| undefined/,
    );
    // E a CADEIA: preferência da pessoa → idioma da ORGANIZAÇÃO → padrão.
    const servidor = readFileSync("lib/auth/server.ts", "utf8");
    expect(servidor, "a membership deixou de trazer o idioma da organização").toMatch(
      /organizations\(display_name, locale\)/,
    );
    expect(servidor, "o idioma da sessão parou de cair na organização").toMatch(
      /locale \?\? \(await localeDaOrgAtiva\(memberships\)\)/,
    );
    expect(readFileSync("lib/auth/types.ts", "utf8")).toMatch(/idioma: Idioma/);
    // E o provider de idioma é SEPARADO do de autenticação.
    const layout = readFileSync("app/app/layout.tsx", "utf8");
    expect(layout).toMatch(/<IdiomaProvider locale=\{user\.idioma\}>/);
    expect(
      readFileSync("lib/i18n/IdiomaProvider.tsx", "utf8"),
      "o provider de idioma voltou a depender da autenticação",
    ).not.toMatch(/^import .*auth/m);
  });

  it("a validação do perfil usa a MESMA lista do dicionário", () => {
    expect(readFileSync("lib/schemas/settings.ts", "utf8")).toMatch(/const LOCALES = IDIOMAS;/);
  });

  it("nenhum seletor oferece idioma que não muda a tela", () => {
    // Com um idioma só, oferecer "Español" seria prometer o que a tela não
    // cumpre — a classe que removeu `en-US` pelo mesmo motivo.
    for (const arquivo of [
      "app/app/settings/profile/_form.tsx",
      "app/app/settings/tenant/_form.tsx",
    ]) {
      const fonte = readFileSync(arquivo, "utf8");
      expect(fonte, `${arquivo} ainda oferece espanhol`).not.toMatch(/value="es"/);
    }
    expect(
      readFileSync("components/shell/UserMenu.tsx", "utf8"),
      "seletor de idioma de volta no menu",
    ).not.toMatch(/SeletorDeIdioma/);
  });

  it("a barra lateral traduz — ela aparece em TODA tela", () => {
    const fonte = readFileSync("components/shell/Sidebar.tsx", "utf8");
    expect(fonte).toMatch(/const t = useT\(\);/);
    expect(fonte).toMatch(/\{t\(item\.label\)\}/);
  });

  it("o inbox traduz o que se usa o dia inteiro", () => {
    for (const arquivo of [
      "components/inbox/ConversationHeader.tsx",
      "components/inbox/Composer.tsx",
      "components/inbox/InboxFilters.tsx",
    ]) {
      expect(readFileSync(arquivo, "utf8"), arquivo).toMatch(/const t = useT\(\);/);
    }
  });
});
