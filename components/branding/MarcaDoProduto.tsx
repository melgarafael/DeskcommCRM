import { LOGOTIPO, SIMBOLO } from "@/lib/branding/desenho";
import { cn } from "@/lib/utils";

/**
 * A marca do PRODUTO desenhada em SVG inline — o que a tela mostra quando
 * ninguém configurou marca própria (`marcaEhADoProduto`, em `lib/branding.ts`).
 *
 * Inline, e não `<img src="/algo.svg">`, por três motivos:
 *  - as cores seguem o TEMA: sálvia mais clara e nome em creme no escuro, como
 *    a régua do produto já define — um arquivo estático teria uma cor só;
 *  - nada em `public/`: um `.svg` fixo ali seria servido na instalação de um
 *    revendedor que configurou a marca dele (ver `lib/branding/desenho.ts`);
 *  - a barra lateral já usa `<img>` para o logo CONFIGURADO, e o e2e
 *    `marca-logo.spec.ts` mede "barra sem `<img>`" como "sem logo do
 *    revendedor". Um `<img>` do produto ali faria a spec medir a coisa errada.
 *
 * O texto alternativo é o `nome` que a tela já resolveu — nunca uma string
 * fixa, para que a catraca de marca (`tests/unit/branding.test.ts`) continue
 * contando ZERO ocorrências fora de `lib/branding.ts`.
 */

type Props = {
  readonly nome: string;
  readonly className?: string;
  /** `true` quando o texto ao lado já nomeia a marca — evita ler duas vezes. */
  readonly decorativo?: boolean;
};

const SIMBOLO_CLARO_ESCURO = "fill-[#506d48] dark:fill-[#82a077]";
const NOME_CLARO_ESCURO = "fill-[#1c1a16] dark:fill-[#f5f4ef]";
const SUFIXO_CLARO_ESCURO = "fill-[#5d594f] dark:fill-[#8e8b7f]";

// As classes acima repetem os hexes de `CORES_DA_MARCA` porque o Tailwind só
// gera utilitário para valor LITERAL no fonte. Quem impede os dois de divergirem
// é `tests/unit/marca-do-produto.test.tsx`, que compara as classes à paleta —
// e não uma asserção em runtime: um throw aqui derrubaria a casca inteira.
export const CLASSES_DE_COR = {
  simbolo: SIMBOLO_CLARO_ESCURO,
  nome: NOME_CLARO_ESCURO,
  sufixo: SUFIXO_CLARO_ESCURO,
} as const;

function acessibilidade(nome: string, decorativo: boolean) {
  return decorativo
    ? ({ "aria-hidden": true } as const)
    : ({ role: "img", "aria-label": nome } as const);
}

/** O símbolo sozinho — para a barra recolhida, avatar e cantos apertados. */
export function SimboloDoProduto({ nome, className, decorativo = false }: Props) {
  return (
    <svg
      viewBox={SIMBOLO.viewBox}
      className={cn("shrink-0", className)}
      {...acessibilidade(nome, decorativo)}
    >
      <g className={SIMBOLO_CLARO_ESCURO} transform={SIMBOLO.transform}>
        <path d={SIMBOLO.d} />
        <rect {...SIMBOLO.modulo} />
      </g>
    </svg>
  );
}

/** Símbolo + nome — para a barra aberta e a fachada de entrada. */
export function LogotipoDoProduto({ nome, className, decorativo = false }: Props) {
  return (
    <svg
      viewBox={LOGOTIPO.viewBox}
      className={cn("shrink-0", className)}
      {...acessibilidade(nome, decorativo)}
    >
      <g className={SIMBOLO_CLARO_ESCURO} transform={LOGOTIPO.simbolo.transform}>
        <path d={LOGOTIPO.simbolo.d} />
        <rect {...LOGOTIPO.simbolo.modulo} />
      </g>
      <g className={NOME_CLARO_ESCURO}>
        {LOGOTIPO.nome.map((g) => (
          <path key={g.transform} transform={g.transform} d={g.d} />
        ))}
      </g>
      <g className={SUFIXO_CLARO_ESCURO}>
        {LOGOTIPO.sufixo.map((g) => (
          <path key={g.transform} transform={g.transform} d={g.d} />
        ))}
      </g>
    </svg>
  );
}
