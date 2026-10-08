/**
 * Um pedido bruto da API → `orders`. Dado ruim devolve `ok:false` (a página
 * segue: um pedido ruim não trava a loja); falha de banco LANÇA (o evento volta
 * para a fila e a página inteira é regravada — o upsert é idempotente).
 *
 * LGPD: pedido já anonimizado é pulado ANTES de resolver contato. Senão a
 * re-sincronização recriaria, a partir do pedido, o contato que o redact apagou.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { PROVEDOR } from "./constantes";
import { extrairChaves, resolverContatoDoPedido } from "./contato-do-pedido";
import { pedidoNuvemshopSchema } from "./pedido-nuvemshop";
import { ErroDeTraducao, traduzirPedido } from "./traduzir-pedido";

export type ResultadoDaGravacao =
  | { ok: true; orderId: string | null; ignorado?: "anonimizado" }
  | { ok: false; motivo: string };

function idDe(bruto: unknown): string {
  const id = (bruto as { id?: unknown } | null)?.id;
  return id === undefined || id === null ? "sem_id" : String(id);
}

export async function gravarPedido(
  admin: SupabaseClient,
  ctx: { orgId: string; storeId: string },
  bruto: unknown,
  resolver: typeof resolverContatoDoPedido = resolverContatoDoPedido,
): Promise<ResultadoDaGravacao> {
  const parsed = pedidoNuvemshopSchema.safeParse(bruto);
  if (!parsed.success) return { ok: false, motivo: `pedido_invalido:${idDe(bruto)}` };
  const pedido = parsed.data;

  let linha;
  try {
    linha = traduzirPedido(pedido);
  } catch (err) {
    if (err instanceof ErroDeTraducao) return { ok: false, motivo: `${err.message}:${String(pedido.id)}` };
    throw err;
  }

  const { data: existente, error: erroLeitura } = await admin
    .from("orders")
    .select("is_anonymized")
    .eq("organization_id", ctx.orgId)
    .eq("external_provider", PROVEDOR)
    .eq("external_id", linha.external_id)
    .maybeSingle();
  if (erroLeitura) throw new Error(`orders_leitura:${erroLeitura.message}`);
  if ((existente as { is_anonymized?: boolean } | null)?.is_anonymized) {
    return { ok: true, orderId: null, ignorado: "anonimizado" };
  }

  const contatoId = await resolver(
    admin,
    { orgId: ctx.orgId, storeId: ctx.storeId, customerId: linha.customer_external_id },
    extrairChaves(pedido),
  );

  const { data, error } = await admin.rpc("fn_gravar_pedido_externo", {
    p_organization_id: ctx.orgId,
    p_pedido: { ...linha, contact_id: contatoId },
  });
  if (error) throw new Error(`fn_gravar_pedido_externo:${error.message}`);
  return { ok: true, orderId: (data as string | null) ?? null };
}
