/**
 * Adapter do canal de SMS (#4415).
 *
 * O endereço é o TELEFONE, como no WhatsApp: o contato é o mesmo, e a conversa
 * de SMS é outra linha de `conversations` (`channel = 'sms'`) ao lado da do
 * WhatsApp. Fatia 1 é só texto; mídia (MMS) recusa com código próprio.
 *
 * As recusas do fornecedor chegam já em categoria (`lib/channels/sms/twilio.ts`)
 * e saem daqui com o prefixo do código que o chamador sabe ler:
 *   * `desacelerar` → `codes.throttled` → a mensagem fica `queued` e o
 *     reenvio desacelerado tenta de novo (app/api/v1/messages/_handler.ts);
 *   * sem credencial → `codes.notConfigured` → `queued` até reconectar;
 *   * o resto → `codes.sendFailed`, com a categoria no texto para o operador.
 */
import { createAdminClient } from "@/lib/supabase/admin";

import { conexaoDeSms } from "../sms/credentials";
import { consultarNumero, enviarSms, SmsRecusado } from "../sms/twilio";
import type { ChannelAdapter, ChannelHealth, ChannelTenantScope, OutboundEnvelope, RecipientInput } from "../types";
import { toE164Digits } from "./meta-cloud";

const CODES = {
  notConfigured: "twilio_not_configured",
  sendFailed: "twilio_error",
  unknownError: "twilio_unknown",
  throttled: "twilio_throttled",
} as const;

export const twilioAdapter: ChannelAdapter = {
  provider: "twilio",

  resolveRecipient(input: RecipientInput): string | null {
    // SMS não tem grupo: a conversa de grupo do WhatsApp não tem para onde ir.
    if (input.isGroup) return null;
    if (!input.phoneNumber) return null;
    const digitos = toE164Digits(input.phoneNumber);
    return digitos.length > 0 ? digitos : null;
  },

  // A credencial mora na SESSÃO, não no ambiente: um método síncrono não tem
  // resposta honesta. Quem sabe é `send()`, que lança `codes.notConfigured`.
  isConfigured(): boolean {
    return true;
  },

  async send(envelope: OutboundEnvelope): Promise<{ externalId: string | null }> {
    if (envelope.kind !== "text") {
      throw new Error(`${CODES.sendFailed}: este canal ainda não envia ${envelope.kind} (só texto, #4415).`);
    }
    const texto = envelope.body ?? "";
    if (texto.trim().length === 0) {
      throw new Error(`${CODES.sendFailed}: mensagem de texto sem corpo.`);
    }

    const conexao = await conexaoDeSms(createAdminClient(), {
      organizationId: envelope.organizationId,
      numeroId: envelope.sessionRef,
    });
    if (!conexao) {
      throw new Error(`${CODES.notConfigured}: nenhuma conta de SMS para esta conexão. Reconecte em Conexões.`);
    }

    await envelope.beforeSend?.();

    try {
      const enviado = await enviarSms(conexao, {
        de: conexao.numero,
        para: `+${toE164Digits(envelope.to)}`,
        texto,
      });
      return { externalId: enviado.sid };
    } catch (err) {
      if (err instanceof SmsRecusado) {
        if (err.motivo === "desacelerar") throw new Error(`${CODES.throttled}: ${err.message}`);
        if (err.motivo === "credencial") throw new Error(`${CODES.notConfigured}: chave da conta recusada. ${err.message}`);
        throw new Error(`${CODES.sendFailed}: ${err.motivo}. ${err.message}`);
      }
      const detalhe = err instanceof Error ? err.message : "erro_desconhecido";
      throw new Error(`${CODES.unknownError}: ${detalhe}`.slice(0, 300));
    }
  },

  async checkHealth(input: ChannelTenantScope & { sessionRef: string }): Promise<ChannelHealth> {
    let conexao: Awaited<ReturnType<typeof conexaoDeSms>>;
    try {
      conexao = await conexaoDeSms(createAdminClient(), {
        organizationId: input.organizationId,
        numeroId: input.sessionRef,
      });
    } catch {
      return { reachable: false, status: null, detail: "credencial_ilegivel" };
    }
    if (!conexao) return { reachable: false, status: null, detail: "sem_credencial_para_a_sessao" };

    const r = await consultarNumero(conexao, conexao.numeroId);
    if (r.estado === "ok") return { reachable: true, status: "WORKING", detail: null };
    if (r.estado === "recusado") return { reachable: true, status: "FAILED", detail: r.detalhe };
    return { reachable: false, status: null, detail: r.detalhe };
  },

  codes: CODES,
};
