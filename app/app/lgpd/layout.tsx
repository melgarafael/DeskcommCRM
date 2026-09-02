import type { ReactNode } from "react";

/**
 * A superfície clara da área de LGPD (a lista de solicitações e o detalhe).
 *
 * Sem `p-6`: o `-m-6` cancela o respiro do `<main>` do AppShell e as duas
 * páginas já têm o seu. `min-h-[calc(100%+3rem)]` é o que faz o Paper cobrir
 * também a faixa de padding do `<main>` — sem ele sobra uma tira escura no
 * rodapé quando o conteúdo é curto, que é justamente o caso de uma lista de
 * solicitações vazia.
 */
export default function LayoutDaLgpd({ children }: { children: ReactNode }) {
  return (
    <div
      data-superficie="clara"
      className="-m-6 min-h-[calc(100%+3rem)] bg-bg text-text"
    >
      {children}
    </div>
  );
}
