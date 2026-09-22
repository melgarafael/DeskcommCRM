import type { SupabaseClient } from "@supabase/supabase-js";

import type { PedidoIntel } from "./inteligencia";

/**
 * JANELA DE VENDAS — carrega N linhas em rajadas paralelas, não uma a uma.
 *
 * O loop sequencial de 1000 em 1000 custava um roundtrip por página (11 idas
 * para 10 mil pedidos no dashboard — 10s de application-code medidos no
 * dev-server.log). Rajadas de 5 derrubam o muro para ~5 idas. Só leitura,
 * mesma ordem crescente, mesmo teto de 25 mil com corte documentado.
 */
export async function carregarJanelaDeVendas(
  supabase: SupabaseClient,
  orgId: string,
  inicioJanela: string,
  limite = 25000,
  pagina = 1000,
  rajada = 5,
): Promise<{ linhas: PedidoIntel[]; cortado: boolean }> {
  const linhas: PedidoIntel[] = [];
  let cortado = false;
  for (let base = 0; base < limite; base += pagina * rajada) {
    const pedidos = Array.from({ length: rajada }, (_, k) => {
      const de = base + k * pagina;
      return supabase
        .from("commercial_orders")
        .select("id, total_cents, status, origem, vendedor_user_id, contact_id, created_at")
        .eq("organization_id", orgId)
        .not("status", "in", "(rascunho,cancelado)")
        .gte("created_at", `${inicioJanela}T00:00:00Z`)
        .order("created_at", { ascending: true })
        .range(de, de + pagina - 1);
    });
    const resultados = await Promise.all(pedidos);
    let parou = false;
    for (const r of resultados) {
      if (r.error || !r.data || r.data.length === 0) {
        parou = true;
        break;
      }
      for (const p of r.data as unknown as PedidoIntel[]) linhas.push(p);
      if (r.data.length < pagina) parou = true;
    }
    if (parou) break;
    if (base + pagina * rajada >= limite) cortado = true;
  }
  return { linhas, cortado };
}
