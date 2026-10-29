/**
 * CERCA: NENHUM `<Link>` DO MENU VOLTA A PREFETCHAR A ÁRVORE INTEIRA (#3170).
 *
 * O conserto da #3170 é uma linha por link (`prefetch={false}` + prefetch por
 * intenção, em `hooks/navigation/prefetchPorIntencao.ts`). O defeito, porém,
 * volta sozinho: basta alguém escrever um `<Link href={item.href}>` novo no menu
 * — e o `<Link>` do App Router prefetcha por padrão. Um item esquecido não é um
 * item: medido nesta base, cada item visível custa um render RSC completo
 * (`proxy.ts` + `loadAuthUser` + as cinco consultas de `app/app/layout.tsx`) em
 * TODA tela de `/app`, e é essa rajada que disputa o servidor com o clique.
 *
 * A régua é dura de propósito e não olha o nome da variável: TODO `<Link>` do
 * menu tem de receber as props do hook (o espalhamento `{...algo(href)}`), ou
 * declarar `prefetch={false}` à mão. Ler o texto-fonte é a mesma técnica de
 * `i18n-espanhol-cobre-a-tela` e das cercas de navegação: o que se está
 * prendendo é a FORMA do JSX, não o resultado de um render.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const ARQUIVOS_DO_MENU = [
  "components/shell/Sidebar.tsx",
  "components/shell/BarraInferior.tsx",
];

function fonte(relativo: string): string {
  return readFileSync(join(process.cwd(), relativo), "utf8");
}

/** Cada `<Link ...>` do arquivo, do `<Link` até o fecho da tag de abertura. */
function tagsLink(texto: string): string[] {
  const tags: string[] = [];
  let de = texto.indexOf("<Link");
  while (de !== -1) {
    const fim = texto.indexOf(">", de);
    tags.push(texto.slice(de, fim === -1 ? undefined : fim));
    de = texto.indexOf("<Link", fim === -1 ? texto.length : fim);
  }
  return tags;
}

/** As props do hook viajam juntas: `prefetch: false` + `onPointerEnter`/`onFocus`. */
const PEDE_POR_INTENCAO = /\{\.\.\.[A-Za-z_$][\w$]*\(\s*[\w.$[\]'"]+\s*\)\}/;
const PREFETCH_DESLIGADO = /prefetch\s*=\s*\{false\}/;

describe("#3170 — o menu não prefetcha a árvore inteira", () => {
  for (const arquivo of ARQUIVOS_DO_MENU) {
    it(`${arquivo}: todo <Link> declara prefetch por intenção`, () => {
      const tags = tagsLink(fonte(arquivo));
      expect(tags.length, `${arquivo} não tem <Link> nenhum — a cerca perdeu o alvo`).toBeGreaterThan(0);
      const semPrefetch = tags.filter(
        (tag) => !PEDE_POR_INTENCAO.test(tag) && !PREFETCH_DESLIGADO.test(tag),
      );
      expect(
        semPrefetch,
        `Todo <Link> do menu precisa de \`{...intencao(href)}\` (ou \`prefetch={false}\`). ` +
          `Sem isso o Next prefetcha a tela inteira sozinho e disputa o servidor com o clique:\n` +
          semPrefetch.join("\n---\n"),
      ).toEqual([]);
    });
  }

  it("o hook que desliga o prefetch automático existe e é o do módulo de navegação", () => {
    const texto = fonte("hooks/navigation/prefetchPorIntencao.ts");
    expect(texto).toContain("export function usePrefetchPorIntencao");
    expect(texto).toContain("prefetch: false as const");
    expect(texto).toContain("router.prefetch(href)");
  });
});
