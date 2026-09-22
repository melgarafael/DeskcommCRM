"use client";

import * as React from "react";

/**
 * Chama `fn` depois de `delayMs` sem novas chamadas. Para filtros que disparam
 * busca no servidor a cada tecla: o estado reflete na hora, o request espera.
 */
export function useDebouncedCallback<T extends (...args: never[]) => void>(
  fn: T,
  delayMs: number,
): (...args: Parameters<T>) => void {
  const ref = React.useRef<T>(fn);
  React.useEffect(() => {
    ref.current = fn;
  });
  const timer = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  React.useEffect(() => {
    const atual = timer.current;
    return () => {
      if (atual) clearTimeout(atual);
    };
  }, []);

  return React.useCallback(
    (...args: Parameters<T>) => {
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => ref.current(...args), delayMs);
    },
    [delayMs],
  );
}
