/**
 * A imagem do cabeçalho de uma definição — subir do computador, sem colar URL.
 *
 * ─── Por que uma rota própria ──────────────────────────────────────────────
 *
 * A rota de mídia do inbox exige uma CONVERSA (o caminho no storage é
 * `org/conversa/…`, e ela valida acesso à conversa). Aqui não há conversa
 * nenhuma: a imagem é de uma definição que ainda nem foi criada.
 *
 * ─── Por que URL assinada, e por quanto tempo ──────────────────────────────
 *
 * O bucket é PRIVADO (migration 0055), e a plataforma precisa BAIXAR o arquivo
 * para revisar. Uma URL assinada resolve os dois: o arquivo continua fechado
 * para o mundo, e quem tem o link consegue buscá-lo.
 *
 * Sete dias porque a revisão da Meta leva até 24h e a margem tem de caber num
 * fim de semana com feriado. O link é usado UMA vez, no momento da criação — a
 * plataforma copia o arquivo para o armazenamento dela e devolve um
 * identificador próprio; o nosso não precisa sobreviver ao envio.
 *
 * Tornar o bucket público seria a alternativa fácil e está errada: ele guarda
 * também a mídia das conversas, e abrir o bucket inteiro para resolver o
 * cabeçalho de um modelo exporia o histórico de todos os clientes.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

/** A revisão leva até 24h; a margem tem de caber num feriado. */
const VALIDADE_SEGUNDOS = 7 * 24 * 60 * 60;

/**
 * Só imagem, e só os formatos que a plataforma aceita no cabeçalho.
 *
 * Recusar aqui é melhor que deixar subir: o arquivo iria para o storage, a
 * definição seria criada, e a recusa chegaria horas depois falando de um
 * formato que o operador escolheu porque a tela deixou.
 */
const TIPOS = new Set(["image/jpeg", "image/png"]);
const TAMANHO_MAX = 5 * 1024 * 1024;

export async function POST(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();

  // Sobe pro storage o cabeçalho de uma definição aprovada pela Meta — mesmo
  // piso de "channels/templates" e "channels/partner/templates" (admin).
  const authz = await requireRole("admin", { requestId, resource: "channel_partner_templates_media" });
  if (!authz.ok) return authz.response;
  const org = authz.org;

  const form = await req.formData().catch(() => null);
  const file = form?.get("file");
  if (!(file instanceof File)) {
    return fail("validation_failed", "Campo 'file' (multipart) obrigatório.", 422, { requestId });
  }

  const mime = file.type || "application/octet-stream";
  if (!TIPOS.has(mime)) {
    return fail(
      "unsupported_media_type",
      "O cabeçalho aceita imagem JPG ou PNG.",
      415,
      { requestId },
    );
  }
  if (file.size > TAMANHO_MAX) {
    return fail("payload_too_large", "A imagem precisa ter até 5 MB.", 413, { requestId });
  }

  const ext = mime === "image/png" ? "png" : "jpg";
  const caminho = `${org.orgId}/templates/${randomUUID()}.${ext}`;
  const admin = createAdminClient();

  const { error: erroUp } = await admin.storage
    .from("whatsapp-media")
    .upload(caminho, Buffer.from(await file.arrayBuffer()), { contentType: mime, upsert: false });
  if (erroUp) {
    logger.error("[partner/templates/media] upload falhou", { detail: erroUp.message, requestId });
    return fail("internal_error", "Erro ao subir a imagem.", 500, { requestId });
  }

  const { data: assinada, error: erroUrl } = await admin.storage
    .from("whatsapp-media")
    .createSignedUrl(caminho, VALIDADE_SEGUNDOS);
  if (erroUrl || !assinada?.signedUrl) {
    logger.error("[partner/templates/media] assinatura falhou", {
      detail: erroUrl?.message ?? "sem url",
      requestId,
    });
    return fail("internal_error", "Erro ao preparar o link da imagem.", 500, { requestId });
  }

  return ok({ url: assinada.signedUrl, path: caminho }, { requestId });
}
