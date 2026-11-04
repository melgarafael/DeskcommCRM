/**
 * Entrada do webhook ÚNICO da instalação: um endpoint para todos os números
 * conectados com um clique (`zernio/webhook-da-instalacao.ts`).
 *
 * A rota por sessão sabe de quem é o evento pelo TOKEN do caminho. Aqui não há
 * token: quem diz a sessão é o próprio evento, e por isso a assinatura é
 * conferida ANTES de qualquer leitura — sem ela, o corpo não escolhe nada.
 *
 *   - evento com conta (`message.*`, `whatsapp.template.*`, `account.*`): a
 *     sessão de um clique ativa com aquela conta;
 *   - evento de número sem conta (`whatsapp.number.*`): a sessão de um clique
 *     ativa com aquele número;
 *   - o resto (inclusive o `webhook.test` do painel do provedor) é descartado
 *     com 200: o provedor reentrega o que não recebeu 200, e um evento que nunca
 *     vai servir reentregaria para sempre.
 *
 * Só sessões de um clique: a de chave própria tem a sua assinatura, na URL do
 * seu token, e um evento dela que chegasse aqui não seria desta instalação.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { logger } from "@/lib/logger";

import { CHANNEL_PROVIDER_ZERNIO } from "./capabilities";
import {
  contaDoEventoZernio,
  verifyInboundWebhookSignature,
  type InboundWebhookInput,
} from "./inbound";
import { samePhone } from "./phone-variants";
import { segredoDoWebhookDaInstalacao } from "./zernio/webhook-da-instalacao";

export type SessaoDaEntrada = InboundWebhookInput["session"] & { archived_at?: string | null };

export type EntradaDaInstalacao =
  | { tipo: "sessao"; sessao: SessaoDaEntrada; secret: string }
  | { tipo: "recusa"; status: 401 | 404; motivo: string }
  | { tipo: "ignorar"; motivo: string };

const COLUNAS = "id, organization_id, provider, display_name, phone_number, archived_at";

/** O número de um evento `whatsapp.number.*`, ou `null`. */
function numeroDoEvento(rawBody: string): string | null {
  try {
    const p = JSON.parse(rawBody) as { event?: unknown; number?: { phoneNumber?: unknown } };
    if (typeof p.event !== "string" || !p.event.startsWith("whatsapp.number.")) return null;
    return typeof p.number?.phoneNumber === "string" && p.number.phoneNumber
      ? p.number.phoneNumber
      : null;
  } catch {
    return null;
  }
}

export async function resolverEntradaDaInstalacao(
  admin: SupabaseClient,
  rawBody: string,
  headers: Headers,
): Promise<EntradaDaInstalacao> {
  const secret = await segredoDoWebhookDaInstalacao();
  // Sem webhook registrado, esta entrada não existe: 404, como token desconhecido.
  if (!secret) return { tipo: "recusa", status: 404, motivo: "sem_webhook_da_instalacao" };
  if (!verifyInboundWebhookSignature(CHANNEL_PROVIDER_ZERNIO, rawBody, headers, secret)) {
    return { tipo: "recusa", status: 401, motivo: "bad_signature" };
  }

  const daInstalacao = () =>
    admin
      .from("channel_sessions")
      .select(COLUNAS)
      .eq("provider", CHANNEL_PROVIDER_ZERNIO)
      .eq("zernio_credencial_da_instalacao", true)
      .is("archived_at", null);

  const conta = contaDoEventoZernio(rawBody);
  if (conta) {
    const { data, error } = await daInstalacao().eq("zernio_account_id", conta).limit(2);
    if (error) throw new Error(`sessão da conta não lida: ${error.message}`);
    const sessoes = (data ?? []) as SessaoDaEntrada[];
    if (sessoes.length > 1) {
      // Uma conta em duas organizações ativas não deveria existir (um perfil por
      // organização, uma conta por perfil). Escolher uma seria entregar a
      // conversa de um cliente a outro.
      logger.warn("[entrada-da-instalacao] conta em mais de uma sessão ativa; evento descartado", {
        sessoes: sessoes.map((s) => s.id),
      });
      return { tipo: "ignorar", motivo: "conta_em_mais_de_uma_sessao" };
    }
    const [sessao] = sessoes;
    return sessao
      ? { tipo: "sessao", sessao, secret }
      : { tipo: "ignorar", motivo: "conta_desconhecida" };
  }

  const numero = numeroDoEvento(rawBody);
  if (numero) {
    const { data, error } = await daInstalacao();
    if (error) throw new Error(`sessões da instalação não lidas: ${error.message}`);
    const doNumero = ((data ?? []) as SessaoDaEntrada[]).filter(
      (s) => !!s.phone_number && samePhone(s.phone_number, numero),
    );
    const [sessao] = doNumero;
    return doNumero.length === 1 && sessao
      ? { tipo: "sessao", sessao, secret }
      : { tipo: "ignorar", motivo: "numero_desconhecido" };
  }

  return { tipo: "ignorar", motivo: "evento_sem_conta" };
}
