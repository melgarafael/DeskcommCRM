import type { ReactNode } from "react";

/**
 * A superfície clara do Audit Log.
 *
 * Duas entradas — `page.tsx` e `loading.tsx` —, e é justamente o par que já
 * errou duas vezes aqui quando tratado arquivo a arquivo. O layout fecha os
 * dois de uma vez.
 *
 * Sem `p-6`: o `-m-6` cancela o respiro do `<main>` e as duas filhas já têm o
 * seu (`p-6` na página, `p-6 space-y-4` no esqueleto).
 */
export default function AuditLayout({ children }: { children: ReactNode }) {
  return (
    <div data-superficie="clara" className="-m-6 min-h-[calc(100%+3rem)] bg-bg text-text">
      {children}
    </div>
  );
}
