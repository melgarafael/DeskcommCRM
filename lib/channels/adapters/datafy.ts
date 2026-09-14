/**
 * Adapter do canal Datafy — o transporte do parceiro que espelha a Cloud API.
 *
 * Burro de propósito, como os irmãos: traduz formato e nada mais. As regras de
 * janela/limite/horário vivem na cadeia `before_send`
 * (`docs/doctrine/restricao-de-canal.md`).
 *
 * ─── É o adapter oficial com outro endereço ─────────────────────────────────
 *
 * O Datafy é parceiro homologado pela Meta e expõe a MESMA Cloud API: mesmos
 * caminhos, mesmos corpos. As duas diferenças que importam:
 *
 *  1. **Host.** `https://cloud.datafyapi.com.br/v1` no lugar de
 *     `https://graph.facebook.com/v21.0`.
 *  2. **Token.** `sk_live_…` do Datafy no lugar do token da Meta — e o token
 *     SEMPRE no header `Authorization`, nunca em `?access_token=`.
 *
 * O resto (E.164 em dígitos, `voice: true` para nota de voz, áudio exigindo
 * ogg/opus) é idêntico e vem do módulo neutro `lib/channels/cloud/payload.ts`.
 */
import { createAdminClient } from "@/lib/supabase/admin";
import { cloudContactPayload, cloudMediaPayload, toE164Digits } from "../cloud/payload";
import { graphPartnerGraphBase, resolveGraphPartnerCreds } from "../graph-parceiro/credentials";
import type {
  ChannelAdapter,
  ChannelHealth,
  ChannelTenantScope,
  OutboundEnvelope,
  RecipientInput,
} from "../types";

export const datafyAdapter: ChannelAdapter = {
  provider: "datafy",

  resolveRecipient(input: RecipientInput): string | null {
    // Grupos: a API de grupos da Cloud é recente e não faz parte deste seam.
    if (input.isGroup) return null;
    if (!input.phoneNumber) return null;
    const digits = toE164Digits(input.phoneNumber);
    return digits.length > 0 ? digits : null;
  },

  /**
   * `true` sempre, de propósito — a credencial vive na SESSÃO cifrada e este
   * método é síncrono (não consulta banco). Quem desiste é o `send`, que é
   * async. Devolver `false` aqui faria o handler gravar `queued` sem tentar nada
   * numa instalação conectada pela tela.
   */
  isConfigured(): boolean {
    return true;
  },

  /**
   * Pergunta ao Datafy se o número ainda responde. Mesmo caminho do canal
   * oficial: `GET /v1/{phone_number_id}`. O `sessionRef` deste canal É o
   * `phone_number_id` (ver `resolveSessionRef`).
   */
  async checkHealth(input: ChannelTenantScope & { sessionRef: string }): Promise<ChannelHealth> {
    const creds = await resolveGraphPartnerCreds(createAdminClient(), {
      organizationId: input.organizationId,
      phoneNumberId: input.sessionRef,
    });
    if (!creds) return { reachable: false, status: null, detail: "sem_credencial_para_a_sessao" };

    try {
      const res = await fetch(
        `${graphPartnerGraphBase()}/${encodeURIComponent(input.sessionRef)}?fields=display_phone_number,verified_name,quality_rating`,
        { headers: { Authorization: `Bearer ${creds.token}` }, signal: AbortSignal.timeout(15_000) },
      );
      const body = (await res.json().catch(() => ({}))) as {
        error?: { message?: string; code?: number };
      };

      if (res.status === 401 || res.status === 403) {
        return { reachable: true, status: "FAILED", detail: null };
      }
      if (!res.ok || body.error) {
        return {
          reachable: true,
          status: "FAILED",
          detail: (body.error?.message ?? "").slice(0, 200) || null,
        };
      }
      return { reachable: true, status: "WORKING", detail: null };
    } catch (err) {
      const detail = err instanceof Error ? err.message : "erro_desconhecido";
      return { reachable: false, status: null, detail: detail.slice(0, 200) };
    }
  },

  codes: {
    notConfigured: "datafy_not_configured",
    sendFailed: "datafy_error",
    unknownError: "datafy_unknown",
  },

  async send(envelope: OutboundEnvelope): Promise<{ externalId: string | null }> {
    const creds = await resolveGraphPartnerCreds(createAdminClient(), {
      organizationId: envelope.organizationId,
      phoneNumberId: envelope.sessionRef,
    });
    // Mesmo contrato do canal oficial: sem credencial é NOOP, não exceção.
    if (!creds) return { externalId: null };

    const corpo =
      cloudContactPayload(envelope) ??
      cloudMediaPayload(envelope) ??
      { type: "text", text: { body: envelope.body ?? "" } };

    await envelope.beforeSend?.();
    const res = await fetch(
      `${graphPartnerGraphBase()}/${encodeURIComponent(creds.phoneNumberId)}/messages`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${creds.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          messaging_product: "whatsapp",
          recipient_type: "individual",
          to: envelope.to,
          ...corpo,
        }),
      },
    );

    const body = (await res.json().catch(() => ({}))) as {
      messages?: { id?: string }[];
      error?: { code?: number; message?: string; error_data?: { details?: string } };
    };

    if (!res.ok || body.error) {
      const detalhe = body.error?.error_data?.details ?? body.error?.message ?? `http_${res.status}`;
      throw new Error(`datafy_${body.error?.code ?? res.status}: ${detalhe}`);
    }

    return { externalId: body.messages?.[0]?.id ?? null };
  },
};
