import { LOGO_DO_PRODUTO, MONOGRAMA_DO_PRODUTO } from "@/lib/branding";
import { cn } from "@/lib/utils";

/**
 * A marca do PRODUTO — o que a tela mostra quando ninguém configurou marca
 * própria (`marcaEhADoProduto`, em `lib/branding.ts`).
 *
 * PNG de `public/brand/` em vez do SVG inline de antes: a arte do produto agora
 * é o monograma e o lockup dourados aprovados, e redesenhá-los em vetor seria
 * recriar à mão o que o arquivo já entrega em pixel.
 *
 * É um `<div>` com a arte em `background-image` — e NÃO um `<img>` — de
 * propósito: a barra lateral usa `<img>` para o logo CONFIGURADO, e o e2e
 * `marca-logo.spec.ts` lê "barra sem `<img>`" como "sem logo do revendedor". Um
 * `<img>` do produto ali faria a spec medir a coisa errada. `role="img"` +
 * `aria-label` mantêm o nome anunciado para leitor de tela, como o `<svg>`
 * fazia.
 *
 * Sem moldura clara: o dourado sobre transparente já é desenhado para os dois
 * temas, e o e2e `logo-moldura-no-tema-escuro.spec.ts` (caso 5) mede que a marca
 * do produto não recebe moldura no escuro.
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

function acessibilidade(nome: string, decorativo: boolean) {
  return decorativo
    ? ({ "aria-hidden": true } as const)
    : ({ role: "img", "aria-label": nome } as const);
}

/** O monograma sozinho — para a barra recolhida, avatar e cantos apertados. */
export function SimboloDoProduto({ nome, className, decorativo = false }: Props) {
  return (
    <div
      {...acessibilidade(nome, decorativo)}
      // `bg-contain`: o monograma é 3:2 e o canto é quadrado — conter em vez de
      // esticar.
      className={cn("shrink-0 bg-contain bg-center bg-no-repeat", className)}
      style={{ backgroundImage: `url(${MONOGRAMA_DO_PRODUTO})` }}
    />
  );
}

/** Monograma + nome — para a barra aberta e a fachada de entrada. */
export function LogotipoDoProduto({ nome, className, decorativo = false }: Props) {
  return (
    <div
      {...acessibilidade(nome, decorativo)}
      className={cn("shrink-0 bg-contain bg-center bg-no-repeat", className)}
      style={{
        backgroundImage: `url(${LOGO_DO_PRODUTO})`,
        // O lockup é 1284×856: sem proporção declarada o `div` colapsa, porque
        // `background-image` não dá tamanho intrínseco como o `viewBox` dava.
        aspectRatio: "1284 / 856",
      }}
    />
  );
}
