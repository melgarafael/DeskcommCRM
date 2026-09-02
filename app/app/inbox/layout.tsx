import type { ReactNode } from "react";

/**
 * A superfície clara do Inbox.
 *
 * ── Por que um `layout.tsx` ─────────────────────────────────────────────────
 *
 * São três entradas — a lista (`page.tsx`), o esqueleto (`loading.tsx`) e o
 * redirecionamento de `[id]` —, e a superfície precisa valer nas duas que
 * renderizam. Esquecer o `loading` foi o defeito que já apareceu duas vezes
 * neste trabalho: esqueleto escuro que clareia quando os dados chegam.
 *
 * ── Por que COM `p-6`, ao contrário dos layouts de Contatos e de IA ─────────
 *
 * Lá o `-m-6` cancela o respiro do `<main>` e cada página repõe o seu. Aqui
 * NENHUMA filha tem respiro próprio: o `InboxLayout` é um painel de três
 * colunas cujo respiro mora dentro de cada coluna (`p-4` na lista, `p-6` na
 * conversa), e o esqueleto copia essa estrutura. Repor o `p-6` aqui é o que
 * mantém o Inbox exatamente onde ele está hoje — recuado 24px, como o `<main>`
 * o recuava.
 *
 * Deixar o painel colado na borda seria mais parecido com um cliente de e-mail
 * de verdade, e é uma decisão de produto — não a tomo de carona numa troca de
 * cor.
 */
export default function LayoutDoInbox({ children }: { children: ReactNode }) {
  return (
    <div data-superficie="clara" className="-m-6 min-h-[calc(100%+3rem)] bg-bg p-6 text-text">
      {children}
    </div>
  );
}
