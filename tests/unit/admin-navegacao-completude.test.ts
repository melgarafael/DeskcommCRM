/**
 * TODA TELA DO ADMINISTRADOR DA INSTALAÇÃO TEM PORTA NO MENU — E NA BUSCA.
 *
 * `navegacao-completude.test.ts` cobre só `app/app/**` (a navegação do tenant).
 * O menu do administrador é outra lista, e nada o vigiava: foi assim que
 * `/admin/modulos` nasceu sem porta no PR #1578 — as rotas de honorários
 * mandavam o operador instalar o módulo "em Módulos", e só se chegava lá
 * digitando a URL.
 *
 * A lista mudou de lugar: morava em `components/admin/AdminSidebar.tsx` e saiu
 * para `lib/admin/navegacao.ts` quando a busca (⌘K) do painel virou seu segundo
 * consumidor. Este teste passou a ler a FONTE (`ADMIN_DESTINATIONS`), e não o
 * texto do componente — importar o array de verdade é mais forte que procurar
 * `href: "..."` num arquivo: pega renomeação, entrada condicional e lista
 * montada em runtime.
 *
 * O recorte é o primeiro nível de `app/admin/(protected)/`: é ali que mora cada
 * tela do menu. Subpáginas (`tenants/new`, `audit/[entryId]`) são alcançadas de
 * dentro da tela-mãe, não do menu.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { ADMIN_DESTINATIONS } from "@/lib/admin/navegacao";

const RAIZ = join(process.cwd(), "app", "admin", "(protected)");

function telasDoPrimeiroNivel(): string[] {
  return readdirSync(RAIZ, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !d.name.startsWith("[") && !d.name.startsWith("("))
    .filter((d) => existsSync(join(RAIZ, d.name, "page.tsx")))
    .map((d) => `/admin/${d.name}`)
    .sort();
}

const HREFS = ADMIN_DESTINATIONS.map((d) => d.href);

describe("menu do administrador da instalação", () => {
  it("o instrumento enxerga as telas (controle: /admin/dashboard existe e tem porta)", () => {
    expect(telasDoPrimeiroNivel()).toContain("/admin/dashboard");
    expect(HREFS).toContain("/admin/dashboard");
  });

  it("toda tela de primeiro nível tem uma entrada no menu", () => {
    const semPorta = telasDoPrimeiroNivel().filter((href) => !HREFS.includes(href));
    expect(
      semPorta,
      "tela do administrador sem porta no menu: acrescente-a a ADMIN_DESTINATIONS em lib/admin/navegacao.ts",
    ).toEqual([]);
  });

  it("a busca do painel bebe da MESMA lista do menu (não monta a dela)", () => {
    // Se alguém copiar a lista para dentro da paleta, o menu e a busca passam a
    // divergir no primeiro item novo — e a busca levaria a telas que o menu não
    // mostra. Este teste prende o import, não o conteúdo.
    const paleta = readFileSync(
      join(process.cwd(), "components", "admin", "AdminCommandPalette.tsx"),
      "utf8",
    );
    expect(paleta).toContain('from "@/lib/admin/navegacao"');
    expect(paleta).toContain("destinosDoAdmin");
    expect(paleta, "lista de destinos copiada dentro da paleta").not.toContain('href: "/admin');
  });
});
