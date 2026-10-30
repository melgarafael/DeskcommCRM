import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * POST /api/v1/message-templates/:id/midias — sobe UMA mídia (multipart
 * `file`): uma imagem (#2526) ou o áudio de um recurso (#2833), e a LIGA ao
 * template.
 *
 * O desenho é o de `POST /products/:id/fotos`, que a issue aponta como
 * referência técnica de armazenamento, validação e envio — só que o bucket é o
 * `whatsapp-media` privado do atendimento (é ele que o pipeline de envio já
 * serve), e o prefixo é `<org>/templates/<template>/`.
 *
 * O caminho é gerado AQUI, nunca aceito do cliente. O formato é decidido pela
 * ASSINATURA dos bytes (`farejarTipoDeMidia`: JPEG/PNG, OGG/MP3/AAC/AMR/WAV),
 * não pelo `content-type` que o navegador declarou: esse é do cliente, e o
 * arquivo vai ser servido ao WhatsApp de outra pessoa.
 *
 * O ÁUDIO entra por aqui e não por rota paralela (#2833): mesma coluna
 * `midias`, mesmo bucket, mesmo prefixo — um vocabulário só. O que muda entre
 * os dois tipos é o farejador e o TETO, que é do tipo já farejado.
 *
 * Quem grava é a própria linha, via RLS `message_templates_write` — o mesmo
 * gate do PATCH: dono do pessoal, manager+ no compartilhado. O upload
 * ADICIONA; `substituir_audio` troca uma entrada atual sem ocupar uma sexta
 * vaga. Remover sem substituir é o PATCH. Os dois escritores comparam a lista
 * inteira lida; o snapshot esperado também recusa uma edição já desatualizada.
 */
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { type NextRequest } from "next/server";

import { audit } from "@/lib/audit";
import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { roleAtLeast } from "@/lib/auth/types";
import { traduzir } from "@/lib/i18n/dicionario";
import { logger } from "@/lib/logger";
import { camposDoUploadDeTemplateSchema, snapshotDeMidiasSchema } from "@/lib/schemas/templates";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { apagarMidiasDoTemplate } from "@/lib/templates/midias-no-bucket";
import {
  BUCKET_DAS_MIDIAS,
  MAXIMO_DE_MIDIAS,
  TAMANHO_MAXIMO_DO_AUDIO,
  type MidiaDeTemplate,
  extensaoDaMidia,
  ehMidiaDeAudio,
  farejarTipoDeMidia,
  midiaPertenceAoTemplate,
  prefixoDoTemplate,
  tetoDaMidia,
} from "@/lib/templates/midias";

export const dynamic = "force-dynamic";

interface RouteParams {
  params: Promise<{ id: string }>;
}

export async function POST(req: NextRequest, { params }: RouteParams): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const authz = await requireRole("agent", { requestId, resource: "message_templates" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const { org } = authz;
  const { id } = await params;

  const supabase = await createClient();
  const { data: linha, error: erroLeitura } = await supabase
    .from("message_templates")
    .select("owner_user_id, midias")
    .eq("id", id)
    .eq("organization_id", org.orgId)
    .maybeSingle();
  if (erroLeitura) {
    logger.error("[message-templates/midias] falha ao ler o template", {
      requestId,
    });
    return fail("internal_error", "Erro ao ler o template.", 500, { requestId });
  }
  if (!linha) return fail("not_found", t("Template não encontrado."), 404, { requestId });

  const { owner_user_id: owner, midias } = linha as {
    owner_user_id: string | null;
    midias: MidiaDeTemplate[] | null;
  };
  // O schema atual exige array não nulo. Um dado fora desse contrato não
  // pode virar uma lista vazia e autorizar um upload sobre outra versão.
  if (!snapshotDeMidiasSchema.safeParse(midias).success) {
    return fail("conflict", t("As mídias mudaram. Recarregue a página."), 409, { requestId });
  }
  const atuais = midias as MidiaDeTemplate[];
  // A MESMA régua do POST de criação: compartilhado só por manager+. A RLS
  // barraria de qualquer forma; isto dá o erro claro ANTES de subir o arquivo.
  if (owner === null && !roleAtLeast(org.role, "manager")) {
    return fail("forbidden", t("Só manager+ altera template compartilhado."), 403, { requestId });
  }
  // Recusa pelo Content-Length declarado ANTES de bufferizar o corpo (como a
  // rota de mídia da conversa). O teto daqui é o MAIOR dos dois (áudio, 16 MB)
  // mais a folga do multipart: o tipo ainda não foi farejado, e o teto por tipo
  // é conferido abaixo, sobre os bytes.
  const declarado = Number(req.headers.get("content-length") ?? 0);
  if (declarado > TAMANHO_MAXIMO_DO_AUDIO + 1_048_576) {
    return fail("payload_too_large", t("A mídia passou do tamanho máximo aceito."), 413, {
      requestId,
    });
  }

  const form = await req.formData().catch(() => null);
  const file = form?.get("file");
  if (!(file instanceof File)) {
    return fail("validation_failed", t("Campo 'file' (multipart) obrigatório."), 422, { requestId });
  }
  const snapshot = form?.get("midias_esperadas");
  let esperado: unknown = undefined;
  if (snapshot !== null && snapshot !== undefined) {
    if (typeof snapshot !== "string") return fail("validation_failed", t("Dados inválidos."), 422, { requestId });
    try {
      esperado = JSON.parse(snapshot) as unknown;
    } catch {
      return fail("validation_failed", t("Dados inválidos."), 422, { requestId });
    }
  }
  const substituir = form?.get("substituir_audio");
  const campos = camposDoUploadDeTemplateSchema.safeParse({
    ...(substituir === null || substituir === undefined ? {} : { substituir_audio: substituir }),
    ...(esperado === undefined ? {} : { midias_esperadas: esperado }),
  });
  if (!campos.success) return fail("validation_failed", t("Dados inválidos."), 422, { requestId });
  if (campos.data.midias_esperadas !== undefined && !isDeepStrictEqual(atuais, campos.data.midias_esperadas)) {
    return fail("conflict", t("As mídias mudaram. Recarregue a página."), 409, { requestId });
  }
  const referencia = campos.data.substituir_audio;
  const indice = referencia === undefined ? -1 : atuais.findIndex((m) => m.storage_path === referencia);
  if (referencia !== undefined && (indice < 0 || atuais.filter((m) => m.storage_path === referencia).length !== 1)) {
    return fail("conflict", t("As mídias mudaram. Recarregue a página."), 409, { requestId });
  }
  const anterior = indice < 0 ? undefined : atuais[indice];
  if (anterior && (!midiaPertenceAoTemplate(anterior.storage_path, org.orgId, id) || !ehMidiaDeAudio(anterior))) {
    return fail("validation_failed", t("Dados inválidos."), 422, { requestId });
  }
  if (!anterior && atuais.length >= MAXIMO_DE_MIDIAS) {
    return fail("validation_failed", t("Cada resposta rápida tem no máximo 5 mídias."), 422, { requestId });
  }
  const bytes = new Uint8Array(await file.arrayBuffer());
  const tipo = farejarTipoDeMidia(bytes);
  if (!tipo) {
    return fail(
      "unsupported_media_type",
      t("A mídia precisa ser JPG, PNG ou áudio (OGG, MP3, AAC, AMR ou WAV)."),
      415,
      {
        requestId,
        details: { content_type_declarado: file.type || null },
      },
    );
  }
  if (anterior && !tipo.startsWith("audio/")) {
    return fail("validation_failed", t("O arquivo precisa ser de áudio."), 422, { requestId });
  }
  // O teto é do TIPO já farejado: 5 MB para imagem, 16 MB para áudio — o teto de
  // imagem não serve para áudio, e é aqui que a diferença morde.
  if (file.size > tetoDaMidia(tipo)) {
    return fail(
      "payload_too_large",
      tipo.startsWith("audio/")
        ? t("O áudio precisa ter até 16 MB.")
        : t("A imagem precisa ter até 5 MB."),
      413,
      { requestId },
    );
  }

  const caminho = `${prefixoDoTemplate(org.orgId, id)}${randomUUID()}.${extensaoDaMidia(tipo)}`;
  const admin = createAdminClient();
  const { error: erroUp } = await admin.storage
    .from(BUCKET_DAS_MIDIAS)
    .upload(caminho, bytes, { contentType: tipo, upsert: false })
    .catch(() => ({ error: { message: "upload_failed" } }));
  if (erroUp) {
    logger.error("[message-templates/midias] upload falhou", { requestId });
    return fail("internal_error", "Erro ao subir a mídia.", 500, { requestId });
  }

  const nova: MidiaDeTemplate = {
    storage_path: caminho,
    media_mime: tipo,
    media_size_bytes: file.size,
  };
  const { data: gravada, error: erroGrava, count } = await Promise.resolve(supabase
    .from("message_templates")
    .update({
      midias: anterior ? atuais.map((m, i) => i === indice ? nova : m) : [...atuais, nova],
      updated_at: new Date().toISOString(),
    }, { count: "exact" })
    .eq("id", id)
    .eq("organization_id", org.orgId)
    // JSON.stringify explícito: o SDK não serializa objetos no operador eq.
    // A igualdade JSONB protege também os clientes legados durante esta escrita.
    .eq("midias", JSON.stringify(atuais))
    .select("midias")
    .maybeSingle()).catch(() => ({ data: null, error: { message: "write_failed" }, count: null }));
  if (erroGrava || (!gravada && count !== 0)) {
    // Erro de transporte ou confirmação ausente NÃO prova rollback. O UPDATE
    // pode já ter ligado o objeto novo: conservar eventual órfão é preferível
    // a apagar os bytes de uma referência válida. Não há reconciliação por SELECT.
    logger.error("[message-templates/midias] gravação não confirmada", { requestId });
    return fail("internal_error", t("Não foi possível confirmar a gravação. Recarregue a página antes de tentar de novo."), 500, { requestId });
  }
  if (!gravada) {
    // Só zero linhas confirmado pelo PostgREST permite limpar o upload próprio.
    await apagarMidiasDoTemplate([caminho], requestId);
    return fail("conflict", t("As mídias mudaram. Recarregue a página."), 409, { requestId });
  }

  // O arquivo anterior continua disponível até a nova referência persistir.
  if (anterior) await apagarMidiasDoTemplate([anterior.storage_path], requestId);

  void audit({
    action: "template.media_added",
    actorUserId: authz.user.id,
    organizationId: org.orgId,
    resourceType: "message_template",
    resourceId: id,
    requestId,
    metadata: { total: ((gravada as { midias: MidiaDeTemplate[] }).midias ?? []).length, substituida: !!anterior },
  });

  return ok({ midias: (gravada as { midias: MidiaDeTemplate[] }).midias ?? [] }, { requestId });
}
