/**
 * "Pagar agora" no aviso da Central (pedido do dono: link de pagamento em TODO
 * aviso). O link vem da assinatura NA HORA da leitura — o do dia do aviso pode
 * ter vencido —, só para quem administra (a mesma régua de Plano e cobrança) e
 * só nos avisos da régua (`kind='cobranca'` sem referência).
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { ROLE_RANK, type Role } from "@/lib/auth/types";

type Aviso = { kind: string; ref_kind: string | null };

export async function anexarLinkDePagamento<T extends Aviso>(
  admin: SupabaseClient,
  orgId: string,
  papel: Role,
  itens: readonly T[],
): Promise<Array<T | (T & { link_de_pagamento: string | null })>> {
  const daRegua = (i: Aviso) => i.kind === "cobranca" && i.ref_kind === null;
  if (ROLE_RANK[papel] < ROLE_RANK.admin || !itens.some(daRegua)) return [...itens];
  const { data, error } = await admin.from("cobranca_assinaturas").select("link_de_pagamento").eq("organization_id", orgId).maybeSingle();
  // Falha aberta na INFORMAÇÃO: sem a leitura, o aviso segue com o caminho para o plano.
  const link = error ? null : ((data as { link_de_pagamento: string | null } | null)?.link_de_pagamento ?? null);
  return itens.map((i) => (daRegua(i) ? { ...i, link_de_pagamento: link } : i));
}
