import { describe, expect, it } from "vitest";

import { PUBLIC_PATHS } from "@/lib/auth/public-paths";
import type { MarcaDeSaida } from "@/lib/branding/saida";
import {
  MODELOS_DE_ACESSO,
  assuntoDoModelo,
  montarTemplateDeAcesso,
} from "@/lib/email/templates/acesso-gotrue";

/**
 * O CONTRATO DOS MOLDES DE E-MAIL DO GoTrue.
 *
 * Cada caso aqui prende um modo de falha que já aconteceu numa instalação real
 * — nenhum é zelo preventivo.
 */

const MARCA: MarcaDeSaida = {
  nome: 'Acme "Test" & Cia',
  logoUrl: "https://exemplo.test/logo.png",
  accent: "#506d48",
  accentFg: "#ffffff",
  origens: { nome: "instalacao", cor: "instalacao" },
};

describe("moldes de acesso do GoTrue", () => {
  for (const modelo of MODELOS_DE_ACESSO) {
    describe(modelo, () => {
      const html = montarTemplateDeAcesso(modelo, MARCA);

      it("linka com token_hash — o formato que NÃO depende de cookie", () => {
        // O modelo padrão do GoTrue usa `{{ .ConfirmationURL }}`, que leva ao
        // `/auth/v1/verify` e devolve um `code` PKCE. O verificador vive num
        // cookie SameSite=Strict, que não viaja num clique vindo de webmail —
        // a conta confirma e a sessão nunca fecha.
        expect(html).toContain("{{ .TokenHash }}");
        expect(html).not.toContain("{{ .ConfirmationURL }}");
      });

      it("usa `&`, nunca `?` — `.RedirectTo` já traz `?type=`", () => {
        // Com `?` o separador duplica (`...?type=signup?token_hash=...`) e o
        // parser de URL do browser para de reconhecer `token_hash`.
        expect(html).toContain("{{ .RedirectTo }}&token_hash={{ .TokenHash }}");
        expect(html).not.toContain("{{ .RedirectTo }}?token_hash");
      });

      it("não sobrou placeholder de renderização por script", () => {
        // `__APP_NAME__` e `__ACCENT__` são do caminho do `marca-emails.sh`.
        // Aqui a marca já vem resolvida; um `__` sobrando iria literal para a
        // caixa de entrada do cliente.
        expect(html).not.toMatch(/__[A-Z_]+__/);
      });

      it("escapa a marca — ela vem de texto livre no banco", () => {
        expect(html).toContain("Acme &quot;Test&quot; &amp; Cia");
        expect(html).not.toContain('Acme "Test" & Cia');
      });

      it("o assunto leva a marca — senão chega em inglês, do padrão do GoTrue", () => {
        expect(assuntoDoModelo(modelo, MARCA)).toContain(MARCA.nome);
      });
    });
  }

  it("sem logo configurado, nada é desenhado no lugar", () => {
    const html = montarTemplateDeAcesso("confirmation", { ...MARCA, logoUrl: null });
    expect(html).not.toContain("<img");
  });

  it("a rota dos moldes é PÚBLICA — senão o GoTrue recebe a tela de login", () => {
    // Este é o caso mais caro do arquivo. Quem busca é o GoTrue, que não tem
    // sessão nossa: sem entrada em PUBLIC_PATHS o proxy responde 307 para
    // `/login`, o GoTrue segue o redirect, recebe o HTML da tela de login e
    // manda ISSO para a caixa de entrada. Medido em 2026-09-09 com um caminho
    // de arquivo; o Gmail marcou como phishing.
    const publico = (p: string) => PUBLIC_PATHS.some((re) => re.test(p));
    for (const modelo of MODELOS_DE_ACESSO) {
      expect(publico(`/email-templates/${modelo}`)).toBe(true);
    }
    // E não abre a porta para sub-path futuro nascer público de carona.
    expect(publico("/email-templates/qualquer-outra")).toBe(false);
    expect(publico("/email-templates/confirmation/x")).toBe(false);
  });
});
