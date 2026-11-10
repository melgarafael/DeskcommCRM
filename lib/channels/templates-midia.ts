/**
 * A IMAGEM DO CABEÇALHO de uma definição aprovada — a lógica, uma vez só.
 *
 * ─── Por que não mora na rota ──────────────────────────────────────────────
 *
 * Cada FONTE de tela tem a sua rota de modelos (ver
 * `lib/channels/templates-fonte.ts`), e cada uma precisa de subir imagem. O
 * upload, porém, não tem NADA de específico de canal: o arquivo vai para o NOSSO
 * storage, em `{org}/templates/…`, e a rota devolve um link assinado que a
 * plataforma baixa na revisão. Duas cópias deste arquivo seriam duas chances de
 * divergir na validação — que é a parte que protege o bucket.
 *
 * ─── Por que a rota de mídia do inbox não serve ────────────────────────────
 *
 * Ela exige uma CONVERSA (o caminho no storage é `org/conversa/…`, e valida
 * acesso à conversa). Aqui não há conversa nenhuma: a imagem é de uma definição
 * que ainda nem foi criada.
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
import { extensaoDe, farejarTipo, pareceSvg } from "@/lib/branding/logo-arquivo";
import { traduzir } from "@/lib/i18n/dicionario";
import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";

/** A revisão leva até 24h; a margem tem de caber num feriado. */
const VALIDADE_SEGUNDOS = 7 * 24 * 60 * 60;

/**
 * Só imagem, e só os formatos que a plataforma aceita no cabeçalho.
 *
 * Recusar aqui é melhor que deixar subir: o arquivo iria para o storage, a
 * definição seria criada, e a recusa chegaria horas depois falando de um
 * formato que o operador escolheu porque a tela deixou.
 *
 * O conjunto é consultado DUAS vezes, e as duas importam: contra o `type` que o
 * navegador declarou (barato, descarta o engano honesto) e contra o tipo
 * FAREJADO nos bytes (`farejarTipo`), que é o que decide. O rótulo é do cliente
 * e mente quando quer — um SVG renomeado para `.png` passava pela primeira
 * peneira e chegava ao storage com `contentType: image/png`.
 */
const TIPOS = new Set(["image/jpeg", "image/png"]);
const TAMANHO_MAX = 5 * 1024 * 1024;

/**
 * O handler das rotas de mídia do cabeçalho (parceiro e canal oficial).
 *
 * A guarda de suporte (`requireSupportWrite`) fica em CADA rota, antes de
 * chamar este handler: é lá que `tests/unit/suporte-cobertura-de-efeitos.test.ts`
 * a procura, e uma rota nova que reexportasse o handler sem ela passaria calada.
 */
export async function subirImagemDoCabecalho(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();

  const authz = await requireRole("agent", { requestId, resource: "channel_templates" });
  if (!authz.ok) return authz.response;
  const { user, org } = authz;
  const t = (texto: string) => traduzir(texto, user.idioma);

  const form = await req.formData().catch(() => null);
  const file = form?.get("file");
  if (!(file instanceof File)) {
    return fail("validation_failed", t("Campo 'file' (multipart) obrigatório."), 422, { requestId });
  }

  if (file.size > TAMANHO_MAX) {
    return fail("payload_too_large", t("A imagem precisa ter até 5 MB."), 413, { requestId });
  }

  const mime = file.type || "application/octet-stream";
  if (!TIPOS.has(mime)) {
    return fail("unsupported_media_type", t("O cabeçalho aceita imagem JPG ou PNG."), 415, { requestId });
  }

  const bytes = new Uint8Array(await file.arrayBuffer());
  const tipoReal = farejarTipo(bytes);
  if (!tipoReal || !TIPOS.has(tipoReal)) {
    if (pareceSvg(bytes)) {
      return fail(
        "unsupported_media_type",
        t("Arquivos SVG não são aceitos. O cabeçalho aceita imagem JPG ou PNG."),
        415,
        { requestId },
      );
    }
    return fail(
      "unsupported_media_type",
      t("O cabeçalho aceita imagem JPG ou PNG válida."),
      415,
      { requestId },
    );
  }

  const ext = extensaoDe(tipoReal);
  const caminho = `${org.orgId}/templates/${randomUUID()}.${ext}`;
  const admin = createAdminClient();

  const { error: erroUp } = await admin.storage
    .from("whatsapp-media")
    .upload(caminho, Buffer.from(bytes), { contentType: tipoReal, upsert: false });
  if (erroUp) {
    logger.error("[templates/media] upload falhou", { detail: erroUp.message, requestId });
    return fail("internal_error", "Erro ao subir a imagem.", 500, { requestId });
  }

  const { data: assinada, error: erroUrl } = await admin.storage
    .from("whatsapp-media")
    .createSignedUrl(caminho, VALIDADE_SEGUNDOS);
  if (erroUrl || !assinada?.signedUrl) {
    logger.error("[templates/media] assinatura falhou", {
      detail: erroUrl?.message ?? "sem url",
      requestId,
    });
    return fail("internal_error", "Erro ao preparar o link da imagem.", 500, { requestId });
  }

  return ok({ url: assinada.signedUrl, path: caminho }, { requestId });
}
