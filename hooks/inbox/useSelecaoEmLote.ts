"use client";
import { useCallback, useMemo, useState } from "react";

/**
 * O estado da seleção múltipla na lista de conversas (#2484, fatia F1).
 *
 * A seleção é um `Set` de ids, e não um array com `.includes`: alternar uma
 * linha é a operação mais frequente da tela (clicar, desclicar, clicar de
 * novo), e numa lista de 100 linhas o `Set` mantém isso O(1) sem ninguém
 * pensar no custo.
 *
 * `selecionarTodos` soma as visíveis às já marcadas em vez de substituir: quem
 * marcou três linhas à mão e depois clicou em "selecionar todas" não perde as
 * três — substituir faria o clique PARECER uma falha.
 */
export function useSelecaoEmLote() {
  const [selecionados, setSelecionados] = useState<Set<string>>(() => new Set());

  const alternar = useCallback((id: string) => {
    setSelecionados((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const selecionarTodos = useCallback((ids: string[]) => {
    setSelecionados((prev) => {
      const next = new Set(prev);
      for (const id of ids) next.add(id);
      return next;
    });
  }, []);

  const limpar = useCallback(() => setSelecionados(new Set()), []);

  const ehSelecionado = useCallback((id: string) => selecionados.has(id), [selecionados]);

  return useMemo(
    () => ({
      selecionados,
      quantidade: selecionados.size,
      alternar,
      selecionarTodos,
      limpar,
      ehSelecionado,
    }),
    [selecionados, alternar, selecionarTodos, limpar, ehSelecionado],
  );
}
