import type { ReactNode } from "react";

/**
 * A superfície clara de Contatos.
 *
 * ── Por que um `layout.tsx`, e não o wrapper por página da Agenda ────────────
 *
 * Contatos são TRÊS telas — a lista, o detalhe (`[id]`) e o esqueleto de
 * carregamento — e a superfície precisa valer nas três. Repetir o wrapper em
 * cada uma é a forma de esquecer uma: aconteceu duas vezes já, no `loading` da
 * Agenda e no do Funil, e nos dois casos o sintoma foi o mesmo — esqueleto
 * escuro que clareia de repente quando os dados chegam, que é o jeito mais
 * barato de fazer uma tela parecer quebrada. O `layout` fecha a categoria
 * inteira de uma vez, inclusive para a próxima tela que alguém adicionar aqui.
 *
 * ── Por que SEM `p-6` ───────────────────────────────────────────────────────
 *
 * `-m-6` cancela o respiro do `<main>` do AppShell para o Paper alcançar a
 * borda; quem o repõe são as próprias telas, que já têm `p-6` (`_client.tsx` da
 * lista e do detalhe, e o `loading.tsx`). Pôr `p-6` aqui TAMBÉM daria 48px.
 *
 * E o wrapper ficar sem padding é o que mantém a altura idêntica à de antes:
 * sem padding, a caixa de conteúdo dele é a própria altura, então o `h-full` de
 * qualquer filho resolve para o mesmo valor que resolvia contra o `<main>`.
 */
export default function ContatosLayout({ children }: { children: ReactNode }) {
  return (
    <div data-superficie="clara" className="-m-6 min-h-[calc(100%+3rem)] bg-bg text-text">
      {children}
    </div>
  );
}
