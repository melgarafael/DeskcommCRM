/**
 * Adapter do canal Datafy — o transporte do parceiro que espelha a Cloud API
 * (recorte do PR #1130, de @vgamkt).
 *
 * Burro de propósito, como os irmãos: traduz formato e nada mais. Janela,
 * limite e horário vivem na cadeia `before_send` (`docs/doctrine/restricao-de-canal.md`).
 *
 * ─── É o adapter oficial com outro endereço ─────────────────────────────────
 *
 * Mesmos caminhos e corpos da Cloud API. As duas diferenças que importam:
 *
 *  1. **Host.** A base do parceiro (`graphPartnerGraphBase`) no lugar da Graph.
 *  2. **Token.** O `sk_live_…` do parceiro, SEMPRE no header `Authorization`,
 *     nunca em query string.
 *
 * O corpo (E.164 em dígitos, `voice: true` para nota de voz, áudio exigindo
 * ogg/opus) vem das MESMAS funções do adapter oficial — duas cópias garantiriam
 * que a primeira correção de mídia faltasse num lado.
 *
 * ─── Canal desligado não envia ──────────────────────────────────────────────
 *
 * Com `DATAFY_ENABLED` desligado, `send` desiste com o código `notConfigured`:
 * o handler grava a mensagem como `queued` com o motivo, em vez de mandar por
 * um canal que a instalação desligou ou de fingir um `sent` sem id.
 */
import { createAdminClient } from "@/lib/supabase/admin";

import { canalGraphParceiroLigado, graphPartnerGraphBase, resolveGraphPartnerCreds } from "../graph-parceiro/credentials";
import { graphPartnerTemplateOps } from "../graph-parceiro/templates";
import { sendTemplateForSession } from "../meta/send-template-for-session";
import type {
  ChannelAdapter,
  ChannelHealth,
  ChannelTenantScope,
  OutboundEnvelope,
  RecipientInput,
} from "../types";
import { contactPayload, mediaPayload, toE164Digits } from "./meta-cloud";

const NAO_CONFIGURADO = "datafy_not_configured";

export const datafyAdapter: ChannelAdapter = {
  provider: "datafy",

  resolveRecipient(input: RecipientInput): string | null {
    // Grupos: a API de grupos da Cloud não faz parte deste seam.
    if (input.isGroup) return null;
    if (!input.phoneNumber) return null;
    const digits = toE164Digits(input.phoneNumber);
    return digits.length > 0 ? digits : null;
  },

  /**
   * `true` sempre, como o canal oficial (issue #674): a credencial vive na
   * SESSÃO e este método é síncrono. Quem desiste é o `send`, que LANÇA
   * `datafy_not_configured` — o handler traduz o prefixo para `queued`.
   */
  isConfigured(): boolean {
    return true;
  },

  /** `GET /v1/{phone_number_id}` — o mesmo caminho da saúde do canal oficial. */
  async checkHealth(input: ChannelTenantScope & { sessionRef: string }): Promise<ChannelHealth> {
    if (!canalGraphParceiroLigado()) {
      return { reachable: false, status: null, detail: "canal_desligado_na_instalacao" };
    }
    const creds = await resolveGraphPartnerCreds(createAdminClient(), {
      organizationId: input.organizationId,
      phoneNumberId: input.sessionRef,
    });
    if (!creds) return { reachable: false, status: null, detail: "sem_credencial_para_a_sessao" };

    try {
      const res = await fetch(
        `${graphPartnerGraphBase()}/${encodeURIComponent(input.sessionRef)}?fields=display_phone_number,quality_rating`,
        { headers: { Authorization: `Bearer ${creds.token}` }, signal: AbortSignal.timeout(15_000) },
      );
      const body = (await res.json().catch(() => ({}))) as {
        error?: { message?: string; code?: number };
      };
      if (res.status === 401 || res.status === 403) {
        return { reachable: true, status: "FAILED", detail: null };
      }
      if (!res.ok || body.error) {
        return { reachable: true, status: "FAILED", detail: (body.error?.message ?? "").slice(0, 200) || null };
      }
      return { reachable: true, status: "WORKING", detail: null };
    } catch (err) {
      const detail = err instanceof Error ? err.message : "erro_desconhecido";
      return { reachable: false, status: null, detail: detail.slice(0, 200) };
    }
  },

  codes: {
    notConfigured: NAO_CONFIGURADO,
    sendFailed: "datafy_error",
    unknownError: "datafy_unknown",
  },

  /** Gestão das definições aprovadas pela Graph do parceiro. */
  templates: graphPartnerTemplateOps,

  /**
   * Envia uma DEFINIÇÃO aprovada — a saída do gate de janela de 24h.
   *
   * Reusa o mesmo caminho da Cloud API (`sendTemplateForSession`), parametrizado
   * com o host e o token do parceiro: o modelo é montado a partir do espelho
   * (`meta_templates`) e postado na Graph do parceiro.
   */
  async sendTemplate(input): Promise<{ externalId: string | null }> {
    // Mesma régua do `send`: canal desligado na instalação não envia nada.
    if (!canalGraphParceiroLigado()) {
      throw new Error(`${NAO_CONFIGURADO}: o canal está desligado nesta instalação (DATAFY_ENABLED).`);
    }
    const admin = createAdminClient();
    const creds = await resolveGraphPartnerCreds(admin, {
      organizationId: input.organizationId,
      phoneNumberId: input.sessionRef,
    });
    if (!creds) throw new Error(`${NAO_CONFIGURADO}: nenhuma credencial gravada para esta sessão.`);

    const externalId = await sendTemplateForSession(admin, {
      ...(input.beforeSend ? { beforeSend: input.beforeSend } : {}),
      organizationId: input.organizationId,
      sessionRef: input.sessionRef,
      to: input.to,
      name: input.name,
      language: input.language,
      values: input.values,
      // O espelho guarda a definição POR CONEXÃO. Sem o escopo, o mesmo nome e
      // idioma espelhados também pelo canal oficial dão duas linhas, e a
      // consulta do envio falha em vez de achar a desta conexão.
      channelSessionId: creds.channelSessionId,
      transport: {
        phoneNumberId: creds.phoneNumberId,
        token: creds.token,
        graphBase: graphPartnerGraphBase(),
        errorPrefix: "datafy",
      },
    });
    return { externalId };
  },

  async send(envelope: OutboundEnvelope): Promise<{ externalId: string | null }> {
    if (!canalGraphParceiroLigado()) {
      throw new Error(`${NAO_CONFIGURADO}: o canal está desligado nesta instalação (DATAFY_ENABLED).`);
    }
    const creds = await resolveGraphPartnerCreds(createAdminClient(), {
      organizationId: envelope.organizationId,
      phoneNumberId: envelope.sessionRef,
    });
    if (!creds) {
      throw new Error(`${NAO_CONFIGURADO}: nenhuma credencial gravada para esta sessão.`);
    }

    const corpo =
      contactPayload(envelope) ??
      mediaPayload(envelope) ??
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
