import type { ReactNode } from "react";

/**
 * A superfície clara da área de Equipe (a lista de membros e o convite).
 *
 * Ver o layout de LGPD para o porquê do `min-h-[calc(100%+3rem)]` e da
 * ausência de `p-6`.
 */
export default function LayoutDaEquipe({ children }: { children: ReactNode }) {
  return (
    <div
      data-superficie="clara"
      className="-m-6 min-h-[calc(100%+3rem)] bg-bg text-text"
    >
      {children}
    </div>
  );
}
