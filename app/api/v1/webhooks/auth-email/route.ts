import { createHash, randomUUID } from "node:crypto";
import { env } from "@/lib/env";
import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { marcaDaSaida } from "@/lib/branding/saida";
import { checkRateLimit } from "@/lib/ai/dispatcher/rate-limit";
import { verificarAssinaturaAuth } from "@/lib/email/assinatura-auth";
import { payloadEmailAuthSchema, prepararEmailsAuth } from "@/lib/email/envio-auth";
import { criarRecibosAuth } from "@/lib/email/recibo-auth";
import { sendEmail } from "@/lib/email/roteador";
import { logger } from "@/lib/logger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const requestId = randomUUID();
  const erro = (code: string, message: string, status: number) =>
    fail(code, message, status, { requestId });
  if (!env.AUTH_EMAIL_HOOK_SECRET)
    return erro("not_configured", "Envio Auth não configurado.", 503);
  // Limite de leitura real, não só Content-Length (que pode faltar ou mentir).
  const leitor = request.body?.getReader();
  if (!leitor) return erro("validation_error", "Corpo ausente.", 400);
  const partes: Uint8Array[] = [];
  let tamanho = 0;
  try {
    for (;;) {
      const { done, value } = await leitor.read();
      if (done) break;
      tamanho += value.length;
      if (tamanho > 65536) {
        await leitor.cancel();
        return erro("payload_too_large", "Corpo muito grande.", 413);
      }
      partes.push(value);
    }
  } catch {
    return erro("validation_error", "Não foi possível ler o corpo.", 400);
  }
  const corpo = Buffer.concat(partes).toString("utf8");
  const id = verificarAssinaturaAuth(corpo, request.headers, env.AUTH_EMAIL_HOOK_SECRET);
  if (!id) return erro("invalid_signature", "Assinatura inválida.", 401);
  let bruto: unknown;
  try {
    bruto = JSON.parse(corpo);
  } catch {
    return erro("validation_error", "JSON inválido.", 400);
  }
  const parsed = payloadEmailAuthSchema.safeParse(bruto);
  if (!parsed.success) return erro("validation_error", "Evento de e-mail inválido.", 400);
  const identificador = createHash("sha256").update(parsed.data.user.id).digest("hex");
  const limite = await checkRateLimit(`auth-email:${identificador}`, 20, 60);
  if (!limite.allowed) return erro("rate_limited", "Aguarde antes de tentar novamente.", 429);
  const acao = parsed.data.email_data.email_action_type;
  let organizationId: string | null = null;
  try {
    const emails = await prepararEmailsAuth(parsed.data, {
      appUrl: env.NEXT_PUBLIC_APP_URL,
      supabaseUrl: env.NEXT_PUBLIC_SUPABASE_URL,
      marca: marcaDaSaida,
    });
    organizationId = emails[0]?.organizationId ?? null;
    const recibos = criarRecibosAuth();
    for (const [indice, email] of emails.entries()) {
      const recibo = await recibos.reservar(id, indice, corpo);
      if (recibo.estado === "enviado") continue;
      if (recibo.estado === "ocupado") throw new Error("envio_em_andamento");
      const { organizationId: _org, ...mensagem } = email;
      const enviado = await sendEmail(mensagem);
      if (!enviado.ok) {
        await recibo.liberar();
        // Não expor erro do provedor: pode conter endereço ou fragmentos da mensagem.
        throw new Error("transporte_recusou");
      }
      await recibo.concluir();
      void audit({
        action: "auth.email_sent",
        organizationId,
        requestId,
        bypassedRls: true,
        metadata: { tipo: acao, via: enviado.via, destinatario_indice: indice },
      });
    }
    // GoTrue ignora o conteúdo da resposta quando o status é 200.
    return ok({}, { requestId });
  } catch {
    logger.error("Envio Auth não concluído", { request_id: requestId, tipo: acao });
    void audit({
      action: "auth.email_delivery_failed",
      organizationId,
      requestId,
      metadata: { tipo: acao },
    });
    return erro(
      "email_delivery_failed",
      "Não foi possível enviar o e-mail. Confira transporte e recibos.",
      503,
    );
  }
}
