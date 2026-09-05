/**
 * O livro-razão dos envios de conversão — idempotência e superfície, na mesma
 * tabela e de propósito.
 *
 * ─── Por que uma linha por (lead, evento), e não um histórico ───────────────
 *
 * A tela precisa responder "quais vendas de anúncio não foram reportadas, e por
 * quê". Um histórico append-only responderia isso com um GROUP BY e cresceria
 * para sempre; o índice único `(organization_id, lead_id, event_name)` da 0204
 * faz a mesma pergunta virar um SELECT com WHERE. O que se perde é a sequência
 * de tentativas — e ela já vive no `event_log`, que é onde histórico mora.
 *
 * ─── Por que `sent` nunca é rebaixado ───────────────────────────────────────
 *
 * Uma venda reportada não "desreporta". Se o lead mudar de etapa de novo meses
 * depois, o handler passa por aqui outra vez; sem a guarda, o upsert trocaria
 * `sent` por `skipped` e a próxima passagem acharia que nunca foi enviado — e
 * mandaria a MESMA venda de novo. Contar a venda duas vezes é o pior desfecho
 * possível, porque a plataforma aceita, o otimizador age sobre o número errado
 * e nada na tela denuncia.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { logger } from "@/lib/logger";
import type { NomeDoEvento, PlataformaDeAnuncio } from "@/lib/plataformas-de-anuncio/types";

export type StatusDeEnvio = "sent" | "skipped" | "error";

export interface RegistroDeEnvio {
  organizationId: string;
  leadId: string;
  plataforma: PlataformaDeAnuncio;
  evento: NomeDoEvento;
  status: StatusDeEnvio;
  /** Slug estável. A tela traduz; o banco guarda o slug. */
  motivo: string | null;
  eventoId: string | null;
  valorCentavos?: number | null;
  moeda?: string | null;
  detalhe?: string | null;
}

/** Já foi reportada com sucesso? Guarda de idempotência, lida antes de tudo. */
export async function jaFoiEnviada(
  admin: SupabaseClient,
  organizationId: string,
  leadId: string,
  evento: NomeDoEvento,
): Promise<boolean> {
  const { data } = await admin
    .from("ad_conversion_dispatches")
    .select("status")
    .eq("organization_id", organizationId)
    .eq("lead_id", leadId)
    .eq("event_name", evento)
    .maybeSingle();

  return (data as { status?: string } | null)?.status === "sent";
}

/**
 * Grava o desfecho. Falha aqui NÃO derruba o envio que já aconteceu — mas é
 * contada, porque um livro-razão que perde linha em silêncio deixa de servir
 * para as três coisas que ele existe para fazer.
 */
export async function registraEnvio(
  admin: SupabaseClient,
  registro: RegistroDeEnvio,
): Promise<void> {
  const { error } = await admin.from("ad_conversion_dispatches").upsert(
    {
      organization_id: registro.organizationId,
      lead_id: registro.leadId,
      platform: registro.plataforma,
      event_name: registro.evento,
      status: registro.status,
      reason: registro.motivo,
      event_id: registro.eventoId,
      value_cents: registro.valorCentavos ?? null,
      currency: registro.moeda ?? null,
      detail: registro.detalhe ?? null,
      attempted_at: new Date().toISOString(),
    },
    { onConflict: "organization_id,lead_id,event_name" },
  );

  if (error) {
    logger.error("[conversoes.registro] falha ao gravar livro-razão", {
      organizationId: registro.organizationId,
      leadId: registro.leadId,
      status: registro.status,
      error: error.message,
    });
  }
}
