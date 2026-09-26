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
  protocolo?: string | null;
  solicitadoEm?: string | null;
  ocorridoEm?: string;
  googleActionId?: string;
}

/** Leitura falha fechada: erro de banco nunca autoriza um segundo envio. */
export async function lerRegistro(
  admin: SupabaseClient,
  organizationId: string,
  leadId: string,
  evento: NomeDoEvento,
) {
  const { data, error } = await admin
    .from("ad_conversion_dispatches")
    .select(
      "status, platform, value_cents, currency, remote_request_id, remote_requested_at, event_occurred_at, google_action_id",
    )
    .eq("organization_id", organizationId)
    .eq("lead_id", leadId)
    .eq("event_name", evento)
    .maybeSingle();
  if (error) throw new Error("Não foi possível consultar o registro de conversão.");
  return data as {
    status: string;
    platform: string;
    value_cents: number | null;
    currency: string | null;
    remote_request_id?: string | null;
    remote_requested_at?: string | null;
    event_occurred_at?: string | null;
    google_action_id?: string | null;
  } | null;
}

export async function jaFoiEnviada(
  admin: SupabaseClient,
  organizationId: string,
  leadId: string,
  evento: NomeDoEvento,
): Promise<boolean> {
  return (await lerRegistro(admin, organizationId, leadId, evento))?.status === "sent";
}

/**
 * Grava o desfecho. Falhas propagam para o drain reagendar; o identificador
 * estável da venda protege uma nova tentativa após uma resposta já recebida.
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
      ...(registro.protocolo !== undefined ? { remote_request_id: registro.protocolo } : {}),
      ...(registro.solicitadoEm !== undefined
        ? { remote_requested_at: registro.solicitadoEm }
        : {}),
      ...(registro.ocorridoEm ? { event_occurred_at: registro.ocorridoEm } : {}),
      ...(registro.googleActionId ? { google_action_id: registro.googleActionId } : {}),
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
    throw new Error("Não foi possível persistir o resultado da conversão.");
  }
}
