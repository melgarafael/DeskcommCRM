/**
 * Autenticação dos webhooks do WAHA — fail-closed.
 *
 * O que existia antes era fail-OPEN: se o segredo não pudesse ser obtido
 * (`fn_decrypt_oauth` falhando, ou o campo trazendo um placeholder), a rota
 * marcava `hmacSkipped = true` e **processava o evento assim mesmo**. Como as
 * duas rotas que criam sessão gravam `webhook_secret_encrypted: Buffer.from([0])`
 * — um byte de enfeite —, esse "caso de exceção" era o estado PERMANENTE de toda
 * instalação: qualquer pessoa que soubesse a URL injetava mensagem falsa no CRM
 * alheio, escolhia o remetente e fazia o WhatsApp da vítima responder para um
 * número arbitrário (provado nesta VPS, com `curl` sem header nenhum).
 *
 * Três regras, nesta ordem:
 *
 *  1. Assinatura presente que NÃO confere ⇒ rejeita. Sempre. Não existe motivo
 *     legítimo para alguém assinar errado, e era o buraco mais óbvio.
 *  2. `WAHA_WEBHOOK_REQUIRE_SIGNATURE=true` ⇒ exige assinatura válida em tudo.
 *     Fica desligado por padrão porque sem a variável certa o WAHA não assina:
 *     medido nesta VPS (2026.7.2), os eventos reais chegavam sem header algum
 *     porque o compose entregava `WHATSAPP_HOOK_HMAC` — nome que não existe na
 *     doc dele; o certo é `WHATSAPP_HOOK_HMAC_KEY`. Ligue quando o WAHA estiver
 *     assinando ou houver um proxy que assine. Ligar isso por default
 *     derrubaria a ingestão de mensagens de todo mundo — remédio pior que a
 *     doença. Quem roda WAHA Plus (ou um proxy que assina) liga e ganha a
 *     verificação forte.
 *     Para saber se já está assinando, `/admin/sistema` mostra ao lado do
 *     interruptor se as últimas entregas chegaram assinadas e sugere ligar
 *     quando sim (`lib/channels/assinatura-das-entregas.ts`, doc 99).
 *  3. Sem assinatura e sem exigência ⇒ aceita, mas devolve `signatureVerified:
 *     false` — e quem chama grava ESSA verdade no log. Antes o log registrava
 *     `valid_signature = true` para evento não verificado.
 *
 * A defesa que não depende do WAHA saber assinar é de rede: a rota global (sem
 * token) só atende a rede interna do Docker, porque o WAHA fala com o app por
 * ali e nunca precisou dela pela internet. A própria rota recusa com 404 o que
 * traz a marca de um proxy de borda (`chegouPelaBorda`, lib/http/ip-do-cliente.ts,
 * régua válida nos proxies que o kit sobe).
 */
import { env } from "@/lib/env";
import { exigirAssinaturaNoWebhookDaInstalacao } from "@/lib/instalacao/comportamento";

import { verifyHmacSha512 } from "./ingest";

/** Curto demais para ser segredo de verdade — é placeholder ou lixo de decrypt. */
const MIN_SECRET_LEN = 16;

export type WahaWebhookAuth =
  | { ok: true; signatureVerified: boolean }
  | { ok: false; reason: "bad_signature" | "signature_required" };

export interface WahaWebhookAuthInput {
  rawBody: string;
  signatureHeader: string | null;
  /** Segredo por sessão já decifrado (null quando não há/não decifrou). */
  sessionSecret: string | null;
}

export function authenticateWahaWebhook(input: WahaWebhookAuthInput): WahaWebhookAuth {
  const { rawBody, signatureHeader, sessionSecret } = input;

  const envSecret = (env.WAHA_HMAC_SECRET ?? "").trim();
  const secret =
    sessionSecret && sessionSecret.length >= MIN_SECRET_LEN
      ? sessionSecret
      : envSecret.length >= MIN_SECRET_LEN
        ? envSecret
        : null;

  // A exigência tem DUAS camadas, com a mesma divisão de papéis da política de
  // cadastro: a linha da INSTALAÇÃO (escrita pela tela de admin) está acima, e
  // o `.env` é o PISO — ele responde quando o processo ainda não leu o banco
  // (issue #1034). Sem banco nesta vida do processo, isto é o de hoje.
  const required = exigirAssinaturaNoWebhookDaInstalacao(
    env.WAHA_WEBHOOK_REQUIRE_SIGNATURE === "true",
  );

  if (signatureHeader) {
    // Assinou: tem que conferir. Sem segredo para conferir, não há como
    // confiar — e confiar no que não dá para verificar é o defeito original.
    if (!secret) return { ok: false, reason: "bad_signature" };
    return verifyHmacSha512(rawBody, signatureHeader, secret)
      ? { ok: true, signatureVerified: true }
      : { ok: false, reason: "bad_signature" };
  }

  if (required) return { ok: false, reason: "signature_required" };
  return { ok: true, signatureVerified: false };
}
