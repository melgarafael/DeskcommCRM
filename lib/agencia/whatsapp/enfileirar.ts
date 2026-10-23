/**
 * A única porta de envio do WhatsApp da agência (SPEC-whatsapp-agencia ›
 * Limites: "todo envio da agência passa por enfileirarWhatsappDaAgencia").
 *
 * Nunca envia dentro da requisição: grava o envio `pendente` e emite o evento;
 * quem entrega é o dreno do `event_log`, com pacing. O evento é gravado na
 * organização DONA do canal — o `event_log` exige uma, e é dela o número que
 * fala.
 */
import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";

import { EVENTO_WHATSAPP_ENFILEIRADO } from "./eventos";
import { mascararTelefone, type MotivoDoEnvio } from "./regra";

export interface PedidoDeEnvio {
  motivo: MotivoDoEnvio;
  referenciaId: string | null;
  /** E.164 com `+`. */
  telefone: string;
  corpo: string;
  /** Avisos: o tipo, para agrupar os iguais enquanto o envio está pendente. */
  grupo?: string | null;
  titulos?: string[];
}

export type ResultadoDaFila =
  | { enfileirado: true; envioId: string }
  | { enfileirado: false; motivo: "sem_configuracao" | "falha_ao_gravar" };

/** Lê só o que decide se há por onde falar. */
export async function canalDaAgencia(): Promise<{ organizationId: string; canalId: string } | null> {
  const { data } = await createAdminClient()
    .from("agencia_config")
    .select("canal_organization_id, canal_session_id")
    .eq("id", true)
    .maybeSingle();
  const c = data as { canal_organization_id: string | null; canal_session_id: string | null } | null;
  return c?.canal_organization_id && c.canal_session_id
    ? { organizationId: c.canal_organization_id, canalId: c.canal_session_id }
    : null;
}

export async function enfileirarWhatsappDaAgencia(pedido: PedidoDeEnvio): Promise<ResultadoDaFila> {
  const canal = await canalDaAgencia();
  if (!canal) return { enfileirado: false, motivo: "sem_configuracao" };

  const db = createAdminClient();
  const { data, error } = await db
    .from("agencia_envios_whatsapp")
    .insert({
      motivo: pedido.motivo,
      referencia_id: pedido.referenciaId,
      telefone: pedido.telefone,
      corpo: pedido.corpo,
      grupo: pedido.grupo ?? null,
      titulos: pedido.titulos ?? [],
    })
    .select("id")
    .single();
  if (error || !data) {
    logger.error("agência: não deu para enfileirar WhatsApp", {
      motivo: pedido.motivo,
      telefone: mascararTelefone(pedido.telefone),
      codigo: error?.code,
    });
    return { enfileirado: false, motivo: "falha_ao_gravar" };
  }
  const envioId = (data as { id: string }).id;

  const { error: erroDoEvento } = await db.from("event_log").insert({
    organization_id: canal.organizationId,
    event_type: EVENTO_WHATSAPP_ENFILEIRADO,
    entity_kind: "agencia_envio_whatsapp",
    entity_id: envioId,
    payload: { envio_id: envioId, motivo: pedido.motivo },
  });
  if (erroDoEvento) {
    // Sem evento ninguém entrega: marca o envio para a tela mostrar a falha.
    await db
      .from("agencia_envios_whatsapp")
      .update({ situacao: "falhou", erro_codigo: "evento_nao_gravado" })
      .eq("id", envioId);
    logger.error("agência: envio gravado, mas o evento não", { envioId, codigo: erroDoEvento.code });
    return { enfileirado: false, motivo: "falha_ao_gravar" };
  }
  return { enfileirado: true, envioId };
}
