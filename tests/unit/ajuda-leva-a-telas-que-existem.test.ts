import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { BLOCOS_DE_AJUDA, blocosVisiveis } from "@/lib/ajuda/hub";
import { DICIONARIO } from "@/lib/i18n/dicionario";
import { GRUPO_NO_RODAPE, NAV_CATALOG } from "@/lib/navigation/catalogo";
import { destinosDaInterface } from "@/lib/navigation/interface";

/**
 * A AJUDA NÃO PODE APONTAR PARA O NADA.
 *
 * Três defeitos são possíveis neste hub, e os três falham em silêncio na tela:
 *
 *  1. **Link morto.** Uma tela renomeada (`/app/kanban` → outra coisa) deixa o
 *     item apontando para um 404 — e justamente na página que existe para
 *     socorrer quem já está perdido. Aqui a rota é conferida no DISCO, então o
 *     teste pega o rename no mesmo commit que o fez.
 *
 *  2. **Texto sem espanhol.** O hub é servido por `traduzir`, que degrada para
 *     português em silêncio. Quem escolheu espanhol veria meia página em
 *     português e nada ficaria vermelho — o guarda geral de i18n
 *     (`i18n-espanhol-cobre-a-tela`) varre o JSX e resolve `t("…")` literal,
 *     mas não alcança `t(item.texto)`, que é acesso a propriedade de uma
 *     variável. Foi exatamente esse o buraco medido em v1.41.0 com o catálogo
 *     do menu.
 *
 *  3. **O bloco do instalador vazando.** `/app/settings/atualizacao` é do dono
 *     do servidor; oferecê-la a um atendente é oferecer um 403 como ajuda.
 */

const RAIZ = process.cwd();
const BASE = path.join(RAIZ, "app", "app");

function telaExiste(href: string): boolean {
  const relativo = href.replace(/^\/app\/?/, "");
  return fs.existsSync(path.join(BASE, relativo, "page.tsx"));
}

const todosOsTextos = BLOCOS_DE_AJUDA.flatMap((bloco) => [
  bloco.titulo,
  ...bloco.itens.flatMap((item) => [item.texto, item.detalhe]),
]);

describe("a ajuda dentro do produto", () => {
  it("tem porta no catálogo, no rodapé do menu e por último", () => {
    // `NAV_CATALOG` é `as const`: cada membro tem um tipo literal próprio, então
    // `sidebar` NÃO existe na união inteira. Acessar `item.sidebar` direto
    // reprova no typecheck do CI (TS2339) — o narrowing por `in` é o que
    // transforma "propriedade opcional em alguns membros" em leitura legal.
    const item = NAV_CATALOG.find((d) => d.href === "/app/ajuda");
    if (!item) throw new Error("o item /app/ajuda não existe em NAV_CATALOG");

    expect(item.group, "Ajuda tem de viver no rodapé fixo").toBe(GRUPO_NO_RODAPE);
    expect("sidebar" in item && item.sidebar, "sem `sidebar: true` o rodapé não a desenha").toBe(
      true,
    );
    expect(
      NAV_CATALOG.indexOf(item),
      "Ajuda é o ÚLTIMO item: é o que se procura quando o resto falhou",
    ).toBe(NAV_CATALOG.length - 1);
  });

  it("toda tela apontada pelo hub existe no disco", () => {
    const mortos = BLOCOS_DE_AJUDA.flatMap((bloco) => bloco.itens)
      .map((item) => item.href)
      .filter((href) => !telaExiste(href));

    expect(mortos, `Ajuda apontando para tela que não existe:\n  ${mortos.join("\n  ")}`).toEqual(
      [],
    );
  });

  it("todo texto do hub tem espanhol — a chave é o português", () => {
    const semEspanhol = todosOsTextos.filter((texto) => !DICIONARIO[texto]?.es);

    expect(
      semEspanhol,
      `Texto sem tradução em espanhol (o espanhol é o único idioma completo além do\n` +
        `português — ver lib/i18n/registro.ts). Falta em lib/i18n/dicionario.ts:\n  ` +
        semEspanhol.join("\n  "),
    ).toEqual([]);
  });

  it("o bloco de quem instala só aparece para o dono do servidor", () => {
    const destinos = destinosDaInterface(undefined, false, "admin", [], []);
    const paraQuemUsa = blocosVisiveis(false, destinos).map((b) => b.titulo);
    const paraQuemInstala = blocosVisiveis(true, destinos).map((b) => b.titulo);

    expect(paraQuemUsa).not.toContain("Para quem instala e mantém");
    expect(paraQuemInstala).toContain("Para quem instala e mantém");
    // O contrário também importa: quem instala continua vendo o resto.
    expect(paraQuemInstala).toEqual(expect.arrayContaining(paraQuemUsa));
  });

  it("admin de tenant com interface completa mantém as jornadas do produto", () => {
    // Guarda contra o hub esvaziar: um `soParaQuemInstala` mal copiado em todos
    // os blocos deixaria a tela vazia para atendente, gerente e admin.
    const destinos = destinosDaInterface(undefined, false, "admin", [], []);
    expect(blocosVisiveis(false, destinos).flatMap((b) => b.itens).length).toBe(9);
  });
});
