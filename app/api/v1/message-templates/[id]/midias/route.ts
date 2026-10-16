import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * POST /api/v1/message-templates/:id/midias — sobe UMA imagem (multipart
 * `file`) e a LIGA ao template (#2526).
 *
 * O desenho é o de `POST /products/:id/fotos`, que a issue aponta como
 * referência técnica de armazenamento, validação e envio — só que o bucket é o
 * `whatsapp-media` privado do atendimento (é ele que o pipeline de envio já
 * serve), e o prefixo é `<org>/templates/<template>/`.
 *
 * O caminho é gerado AQUI, nunca aceito do cliente. O formato é decidido pela
 * ASSINATURA dos bytes (`farejarTipo`, JPEG e PNG), não pelo `content-type` que
 * o navegador declarou: esse é do cliente, e o arquivo vai ser servido ao
 * WhatsApp de outra pessoa.
 *
 * Quem grava é a própria linha, via RLS `message_templates_write` — o mesmo
 * gate do PATCH: dono do pessoal, manager+ no compartilhado. O upload
 * ADICIONA; remover é o PATCH, que manda a lista completa do que permanece.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";

import { audit } from "@/lib/audit";
import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { roleAtLeast } from "@/lib/auth/types";
import { traduzir } from "@/lib/i18n/dicionario";
import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import {
  BUCKET_DAS_MIDIAS,
  MAXIMO_DE_MIDIAS,
  TAMANHO_MAXIMO_DA_MIDIA,
  extensaoDe,
  farejarTipo,
  prefixoDoTemplate,
  type MidiaDeTemplate,
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
      detalhe: erroLeitura.message,
      requestId,
    });
    return fail("internal_error", "Erro ao subir a imagem.", 500, { requestId });
  }
  if (!linha) return fail("not_found", t("Template não encontrado."), 404, { requestId });

  const { owner_user_id: owner, midias } = linha as {
    owner_user_id: string | null;
    midias: MidiaDeTemplate[] | null;
  };
  const atuais = midias ?? [];
  // A MESMA régua do POST de criação: compartilhado só por manager+. A RLS
  // barraria de qualquer forma; isto dá o erro claro ANTES de subir o arquivo.
  if (owner === null && !roleAtLeast(org.role, "manager")) {
    return fail("forbidden", t("Só manager+ altera template compartilhado."), 403, { requestId });
  }
  if (atuais.length >= MAXIMO_DE_MIDIAS) {
    return fail("validation_failed", t("Cada resposta rápida tem no máximo 5 imagens."), 422, {
      requestId,
    });
  }

  // Recusa pelo Content-Length declarado ANTES de bufferizar o corpo (como a
  // rota de mídia da conversa); o `file.size` abaixo continua o check
  // autoritativo.
  const declarado = Number(req.headers.get("content-length") ?? 0);
  if (declarado > TAMANHO_MAXIMO_DA_MIDIA + 1_048_576) {
    return fail("payload_too_large", t("A imagem precisa ter até 5 MB."), 413, { requestId });
  }

  const form = await req.formData().catch(() => null);
  const file = form?.get("file");
  if (!(file instanceof File)) {
    return fail("validation_failed", t("Campo 'file' (multipart) obrigatório."), 422, { requestId });
  }
  if (file.size > TAMANHO_MAXIMO_DA_MIDIA) {
    return fail("payload_too_large", t("A imagem precisa ter até 5 MB."), 413, { requestId });
  }
  const bytes = new Uint8Array(await file.arrayBuffer());
  const tipo = farejarTipo(bytes);
  if (!tipo) {
    return fail("unsupported_media_type", t("A imagem precisa ser JPG ou PNG."), 415, {
      requestId,
      details: { content_type_declarado: file.type || null },
    });
  }

  const caminho = `${prefixoDoTemplate(org.orgId, id)}${randomUUID()}.${extensaoDe(tipo)}`;
  const admin = createAdminClient();
  const { error: erroUp } = await admin.storage
    .from(BUCKET_DAS_MIDIAS)
    .upload(caminho, bytes, { contentType: tipo, upsert: false });
  if (erroUp) {
    logger.error("[message-templates/midias] upload falhou", { detalhe: erroUp.message, requestId });
    return fail("internal_error", "Erro ao subir a imagem.", 500, { requestId });
  }

  const nova: MidiaDeTemplate = {
    storage_path: caminho,
    media_mime: tipo,
    media_size_bytes: file.size,
  };
  const { data: gravada, error: erroGrava } = await supabase
    .from("message_templates")
    .update({ midias: [...atuais, nova], updated_at: new Date().toISOString() })
    .eq("id", id)
    .eq("organization_id", org.orgId)
    .select("midias")
    .maybeSingle();
  if (erroGrava || !gravada) {
    // RLS recusou o write (outro aba apagou, ou papel insuficiente). O arquivo
    // já subiu: apagar aqui é o que impede órfão de upload fracassado.
    const { error: erroRemove } = await admin.storage.from(BUCKET_DAS_MIDIAS).remove([caminho]);
    if (erroRemove) {
      logger.error("[message-templates/midias] falha ao limpar upload", {
        detalhe: erroRemove.message,
        requestId,
      });
    }
    if (erroGrava) {
      logger.error("[message-templates/midias] falha ao gravar", {
        detalhe: erroGrava.message,
        requestId,
      });
    }
    return fail("internal_error", "Erro ao salvar a imagem.", 500, { requestId });
  }

  void audit({
    action: "template.media_added",
    actorUserId: authz.user.id,
    organizationId: org.orgId,
    resourceType: "message_template",
    resourceId: id,
    requestId,
    metadata: { total: ((gravada as { midias: MidiaDeTemplate[] }).midias ?? []).length },
  });

  return ok({ midias: (gravada as { midias: MidiaDeTemplate[] }).midias ?? [] }, { requestId });
}
