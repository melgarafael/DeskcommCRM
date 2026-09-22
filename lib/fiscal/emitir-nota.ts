import type { SupabaseClient } from "@supabase/supabase-js";

import { ApiError } from "@/lib/api/types";
import { resolverProvedor } from "@/lib/fiscal/provedor";
import {
  COLUNAS_DA_NOTA,
  STATUS_FATURAVEL,
  type ConfigFiscalSalva,
} from "@/lib/schemas/fiscal";

/**
 * A EMISSÃO de nota fiscal — fora da rota, de propósito.
 *
 * Mesmo padrão do `_handler` da agenda: a regra mora aqui e a ROTA e o
 * ASSISTENTE chamam a mesma função. Sem isto, a `/executar` reimplementaria
 * as travas (pedido faturado, config, nota viva) e as duas divergiriam com o
 * tempo — a primeira divergência seria uma nota duplicada.
 *
 * Assíncrona por desenho: a nota nasce `em_emissao` e o drain processa (stub
 * volta para `pendente`; spednfe transmite). Quem chama nunca espera a SEFAZ.
 */
export interface EmitirNotaInput {
  supabase: SupabaseClient;
  admin: SupabaseClient;
  orgId: string;
  userId: string;
  requestId: string;
  orderId: string;
}

export interface NotaEmitida {
  id: string;
  order_id: string | null;
  serie: string;
  status: string;
  provedor: string;
  total_cents: number;
}

export async function emitirNota(input: EmitirNotaInput): Promise<NotaEmitida> {
  const { supabase, admin, orgId, userId, requestId, orderId } = input;

  const { data: config } = await supabase
    .from("fiscal_settings")
    .select("serie, natureza_operacao, cfop_padrao, emitente_documento, provedor")
    .eq("organization_id", orgId)
    .maybeSingle();
  if (!config) {
    throw new ApiError(
      422,
      "validation_failed",
      { requestId },
      requestId,
      "Configure os dados fiscais primeiro (Notas → Configuração fiscal).",
    );
  }
  const cfg = config as unknown as ConfigFiscalSalva & { provedor: string };

  const { data: pedido } = await supabase
    .from("commercial_orders")
    .select("id, numero, cliente_nome, cliente_documento, total_cents, frete_cents, status")
    .eq("id", orderId)
    .eq("organization_id", orgId)
    .maybeSingle();
  const ped = pedido as unknown as {
    id: string;
    numero: number;
    total_cents: number;
    status: string;
  } | null;
  if (!ped) throw new ApiError(404, "not_found", { requestId }, requestId, "Pedido não encontrado.");
  if (!(STATUS_FATURAVEL as readonly string[]).includes(ped.status)) {
    throw new ApiError(
      422,
      "validation_failed",
      { requestId },
      requestId,
      `Pedido está "${ped.status}" — só faturado vira nota.`,
    );
  }

  // Um pedido, uma nota viva: segunda via nasce de reimpressão, não de nova
  // emissão (que duplicaria o fato fiscal).
  const { data: existente } = await supabase
    .from("invoices")
    .select("id, status")
    .eq("organization_id", orgId)
    .eq("order_id", ped.id)
    .neq("status", "cancelada")
    .maybeSingle();
  if (existente) {
    throw new ApiError(409, "conflict", { requestId }, requestId, "Este pedido já tem nota (não cancelada).");
  }

  const escolha = resolverProvedor(cfg);

  const { data: nota, error } = await supabase
    .from("invoices")
    .insert({
      organization_id: orgId,
      order_id: ped.id,
      serie: cfg.serie,
      numero: null,
      chave_acesso: null,
      xml: null,
      status: "em_emissao",
      provedor: escolha,
      erro: null,
      total_cents: ped.total_cents,
      created_by: userId,
    })
    .select(COLUNAS_DA_NOTA)
    .single();
  if (error || !nota) {
    throw new ApiError(500, "internal_error", { requestId }, requestId, "Erro ao registrar a nota.");
  }
  const notaId = (nota as unknown as { id: string }).id;

  const { error: erroJob } = await supabase.from("fiscal_jobs").insert({
    organization_id: orgId,
    invoice_id: notaId,
    tipo: "emitir",
    status: "pendente",
    created_by: userId,
  });
  if (erroJob) {
    throw new ApiError(500, "internal_error", { requestId }, requestId, "Nota criada, mas a fila recusou o job.");
  }

  await admin.from("fiscal_events").insert({
    organization_id: orgId,
    invoice_id: notaId,
    tipo: "criada",
    status: "em_emissao",
  });

  return nota as unknown as NotaEmitida;
}
