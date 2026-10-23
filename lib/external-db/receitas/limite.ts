/**
 * TETO DE ITENS de uma execução de receita — usado pela ferramenta do agente
 * (`crm_consultar_receita`) e pela pré-visualização da rota, para as duas
 * nunca divergirem.
 *
 * - `limiteItens`: o que o agente pediu (`busca.limite`), limitado ao teto da
 *   receita (`receita.tetoDeItens`).
 * - `limiteMax`: teto total enviado ao dialeto — o menor entre o `max_rows`
 *   da conexão (200 por padrão) e o `limiteItens × nº de termos` (ou 1 sem
 *   termos). É a mesma conta da prévia.
 */
export function limiteDaReceita(params: {
  buscaLimite: number | undefined;
  tetoDeItens: number;
  maxRows: number | undefined;
  termos: unknown[] | undefined;
}): { limiteItens: number; limiteMax: number } {
  const limiteItens = Math.min(params.buscaLimite ?? params.tetoDeItens, params.tetoDeItens);
  const limiteMax = Math.min(
    params.maxRows ?? 200,
    limiteItens * (Array.isArray(params.termos) ? params.termos.length : 1),
  );
  return { limiteItens, limiteMax };
}
