/** Leitura completa em páginas com ordem estável; erro nunca vira total parcial. */
export async function lerPaginasDeUso<T extends { id: string }>(
  pagina: (
    depois: string | null,
    tamanho: number,
  ) => PromiseLike<{
    data: T[] | null;
    error: unknown;
  }>,
): Promise<T[]> {
  const tamanho = 500;
  const todas: T[] = [];
  let depois: string | null = null;
  for (;;) {
    const { data, error } = await pagina(depois, tamanho);
    if (error) throw new Error("usage_page_failed");
    const linhas = data ?? [];
    if (linhas.length === 0) return todas;
    const ultimo = linhas[linhas.length - 1]!.id;
    if (!ultimo || (depois !== null && ultimo <= depois)) throw new Error("usage_cursor_stalled");
    todas.push(...linhas);
    // Um servidor pode impor teto menor que o pedido; só página vazia encerra.
    depois = ultimo;
  }
}
