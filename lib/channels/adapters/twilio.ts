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
 *
 * A recusa por STOP (o destinatário pediu para sair na operadora) também
 * BLOQUEIA o contato aqui, e não só falha a mensagem: todo envio passa por este
 * adapter (Inbox, agente, follow-up, automação, campanha), então é o único lugar
 * que cobre todos os caminhos. O bloqueio é o mesmo do STOP recebido
 * (`aplicarOptOutPendente`), que não repete quem já está bloqueado.
 */
import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";

import { encontrarContatoPorTelefone } from "../contato-por-telefone";
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
        if (err.motivo === "destinatario_descadastrado") {
          await bloquearQuemPediuParaSair(envelope.organizationId, `+${toE164Digits(envelope.to)}`);
        }
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

/**
 * O fornecedor recusou porque o destinatário respondeu STOP na operadora. O
 * pedido é o mesmo do STOP que entra pela Inbox, então o caminho também:
 * `aplicarOptOutPendente` bloqueia, audita `contact.blocked`, fecha negócios e
 * demandas abertos — e não faz nada com quem já está bloqueado.
 *
 * Nunca lança: o envio já falhou, e o erro que importa para quem chamou é o da
 * recusa. Bloqueio que não grava vai para o log.
 *
 * `import()` dinâmico: `pos-entrada` puxa o motor de negócios, que alcança a
 * camada de canais de volta; carregar na hora evita o ciclo de módulos.
 */
async function bloquearQuemPediuParaSair(organizationId: string, telefone: string): Promise<void> {
  try {
    const admin = createAdminClient();
    const contato = await encontrarContatoPorTelefone(admin, organizationId, telefone);
    if (!contato) return;
    const { aplicarOptOutPendente } = await import("../pos-entrada");
    await aplicarOptOutPendente(admin, {
      organizationId,
      contactId: contato.id,
      // A palavra que o destinatário mandou à operadora — é ela que o
      // fornecedor está relatando com a recusa.
      texto: "STOP",
      origem: "sms_recusa_stop",
      conversationId: null,
    });
  } catch (err) {
    logger.error("[sms] recusa por STOP: o contato NÃO foi bloqueado", {
      organization_id: organizationId,
      detail: err instanceof Error ? err.message.slice(0, 160) : "desconhecido",
    });
  }
}
