import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * POST /api/v1/prospecting/arquivo — sobe o ARQUIVO DA PRIMEIRA ABORDAGEM
 * (#4751), multipart `file`.
 *
 * Até a #4757 a tela só oferecia as imagens que já estavam nas respostas
 * rápidas: vídeo e PDF, que a configuração da campanha aceita desde a #4581, não
 * tinham por onde entrar fora de uma conversa. Esta rota é o caminho que faltava
 * — e o único. Ela não cria um segundo vocabulário de mídia:
 *
 *   · o TIPO sai dos bytes (`farejarArquivoDaAbordagem`), nunca do
 *     `content-type` declarado;
 *   · o TAMANHO e o tipo aceitos são decididos por `classificarMidiaDaAbordagem`,
 *     a MESMA função do schema da campanha e do worker — a tela não tem régua
 *     própria para divergir;
 *   · o caminho é `{org}/prospecting/<uuid>.<ext>` no bucket `whatsapp-media`,
 *     o mesmo que `prepararMidiaDaAbordagem` assina para o envio;
 *   · o que a rota devolve é exatamente o descritor que a configuração guarda
 *     (`storage_path`, `media_mime`, `media_size_bytes`), então a tela manda de
 *     volta o mesmo caminho que o worker vai ler — sem tradução no meio.
 *
 * O papel é o da tela de prospecção (admin), o mesmo da leitura da campanha. O
 * arquivo é escrito com service role, como todo escritor de Storage do produto;
 * o `{org}` vem da autorização, nunca do corpo.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";

import { fail, ok } from "@/lib/api/wrappers";
import { lerCorpoComTeto } from "@/lib/api/corpo-com-teto";
import { requireRole } from "@/lib/auth/require-role";
import { traduzir } from "@/lib/i18n/dicionario";
import { logger } from "@/lib/logger";
import { MAX_MEDIA_BYTES } from "@/lib/messaging/media/types";
import { descreverArquivoDaAbordagem } from "@/lib/prospecting/arquivo-da-abordagem";
import { BUCKET_DA_MIDIA_DA_CAMPANHA } from "@/lib/prospecting/midia-da-abordagem";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

const headers = { "Cache-Control": "no-store" };

export async function POST(req: NextRequest): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const authz = await requireRole("admin", { requestId, resource: "prospecting" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const orgId = authz.org.orgId;

  // O teto do bucket (50 MB, o mesmo do PDF) mais a folga do multipart. O teto
  // POR TIPO é conferido abaixo, sobre os bytes: um vídeo de 20 MB precisa ser
  // recebido para ser recusado com a frase certa, não com "corpo grande demais".
  const corpo = await lerCorpoComTeto(req, MAX_MEDIA_BYTES + 1_048_576, {
    requestId,
    idioma: authz.user.idioma,
    acimaDoTeto: t("O arquivo passa do tamanho máximo aceito."),
  });
  if (!corpo.ok) return corpo.response;
  let form: FormData;
  try {
    form = await corpo.corpo.formData();
  } catch {
    return fail("validation_failed", t("Envie o arquivo como multipart/form-data."), 422, {
      requestId,
      headers,
    });
  }
  const arquivo = form.get("file");
  // POR FORMA, e não `instanceof File`: `instanceof` compara contra o construtor
  // do realm, e aqui há três (undici no runtime do Next, jsdom na suíte, o
  // browser). Um File legítimo do undici é `false` contra o `File` do jsdom — a
  // guarda nunca seria exercitada por teste. O que a rota usa é `arrayBuffer()` e
  // `size`, e é isso que a forma exige.
  const pareceArquivo =
    typeof arquivo === "object" &&
    arquivo !== null &&
    typeof (arquivo as { arrayBuffer?: unknown }).arrayBuffer === "function" &&
    typeof (arquivo as { size?: unknown }).size === "number";
  if (!pareceArquivo)
    return fail("validation_failed", t("Campo 'file' (multipart) obrigatório."), 422, {
      requestId,
      headers,
    });
  const enviado = arquivo as unknown as File;

  const bytes = new Uint8Array(await enviado.arrayBuffer());
  const descrito = descreverArquivoDaAbordagem({ organizationId: orgId, id: randomUUID(), bytes });
  if (!descrito.ok)
    return fail(descrito.codigo, t(descrito.motivo), descrito.codigo === "unsupported_media_type" ? 415 : 422, {
      requestId,
      headers,
      // O tipo DECLARADO fica no log como a mentira que era — nunca como decisão.
      details: { content_type_declarado: enviado.type || null },
    });

  const { midia } = descrito;
  const admin = createAdminClient();
  const { error } = await admin.storage
    .from(BUCKET_DA_MIDIA_DA_CAMPANHA)
    .upload(midia.storage_path, Buffer.from(bytes), {
      contentType: midia.media_mime,
      upsert: false,
    });
  if (error) {
    logger.error("[prospecting/arquivo] falha ao guardar o arquivo", { requestId });
    return fail("internal_error", t("Não foi possível guardar o arquivo. Tente novamente."), 500, {
      requestId,
      headers,
    });
  }

  return ok({ midia, nome: enviado.name }, { status: 201, requestId, headers });
}
