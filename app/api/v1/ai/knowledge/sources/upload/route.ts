import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * POST /api/v1/ai/knowledge/sources/upload
 *
 * Envio de arquivo (PDF, Markdown ou texto, até 20 MB) para o acervo da
 * organização. Sobe para o bucket privado, cadastra o material e emite o evento
 * — quem extrai, chunka e embeda é o indexador, no worker.
 *
 * ## O que mudou na 0181
 *
 * Antes esta rota chamava `ingestPolicyFile` "para validar a extração" e aquela
 * função **extraía o texto, chunkava e descartava tudo**, devolvendo só a
 * contagem. O arquivo subia, a fonte nascia `status='ready'`, e não havia
 * caminho nenhum que o transformasse em trecho buscável: o indexador só sabia
 * ler `ai_faq_items`. Somado a isso, a rota **não tinha chamador nenhum na
 * interface** — os dois botões que a substituiriam eram toasts "em breve".
 *
 * Hoje a extração continua acontecendo aqui, mas com outro propósito: recusar
 * na hora o arquivo ilegível, enquanto a pessoa ainda está olhando para a tela.
 * O texto extraído não é guardado — o blob é a fonte da verdade, e o worker o lê
 * de novo na hora de indexar (DIRC: calcular, não duplicar).
 *
 * Auth: sessão por cookie, papel >= manager.
 * `organization_id` sai do JWT — NUNCA do corpo.
 */

import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";
import { z } from "zod";
import { ok, fail } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { temChaveDeEmbedding } from "@/lib/ai/embeddings/chave";
import {
  BUCKET_DE_CONHECIMENTO,
  ErroDeExtracao,
  extrairTextoDoArquivo,
  resolverExtensao,
} from "@/lib/ai/rag/ingest/documento";

export const dynamic = "force-dynamic";

const TAMANHO_MAXIMO = 20 * 1024 * 1024; // 20 MB

const nameSchema = z.string().trim().min(2).max(120);
const agentIdSchema = z.string().uuid();

export async function POST(req: NextRequest): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();

  const authz = await requireRole("manager", { requestId, resource: "ai_knowledge" });
  if (!authz.ok) return authz.response;
  const { user: authUser, org: activeOrg } = authz;

  let formData: FormData;
  try {
    formData = await req.formData();
  } catch {
    return fail("invalid_request", "Falha ao processar o envio do arquivo.", 400, { requestId });
  }

  const fileEntry = formData.get("file");
  const agentIdRaw = formData.get("agent_id");
  const nameRaw = formData.get("name");

  if (!(fileEntry instanceof File)) {
    return fail("invalid_request", "Nenhum arquivo foi enviado.", 400, { requestId });
  }
  const file = fileEntry;

  const nameParsed = nameSchema.safeParse(nameRaw);
  if (!nameParsed.success) {
    return fail("validation_failed", "Dê um nome ao material (2 a 120 caracteres).", 422, {
      requestId,
    });
  }
  const name = nameParsed.data;

  // `agent_id` virou HISTÓRICO na 0181 e passou a ser opcional: o material é da
  // organização. Quando vier, continua validado — o id de um agente de outra
  // organização tem de doer.
  let agentId: string | null = null;
  if (agentIdRaw !== null && String(agentIdRaw).length > 0) {
    const agentIdParsed = agentIdSchema.safeParse(agentIdRaw);
    if (!agentIdParsed.success) {
      return fail("validation_failed", "Campo 'agent_id' deve ser UUID válido.", 422, { requestId });
    }
    const supabase = await createClient();
    const { data: agent, error: agentErr } = await supabase
      .from("ai_agents")
      .select("id")
      .eq("id", agentIdParsed.data)
      .eq("organization_id", activeOrg.orgId)
      .maybeSingle();
    if (agentErr) {
      console.error("[conhecimento-upload] validação do agente falhou:", agentErr.message);
      return fail("internal_error", "Erro ao validar agent_id.", 500, { requestId });
    }
    if (!agent) {
      return fail("not_found", "Assistente não encontrado nesta organização.", 404, { requestId });
    }
    agentId = agentIdParsed.data;
  }

  if (file.size > TAMANHO_MAXIMO) {
    return fail("payload_too_large", "O arquivo passa de 20 MB.", 413, { requestId });
  }

  const ext = resolverExtensao(file.name, file.type);
  if (!ext) {
    return fail(
      "unsupported_media_type",
      "Não sei ler esse tipo de arquivo. Envie PDF, Markdown (.md) ou texto (.txt).",
      415,
      { requestId },
    );
  }

  const admin = createAdminClient();
  const blobId = randomUUID();
  const blobPath = `${activeOrg.orgId}/${blobId}.${ext}`;
  const fileBuffer = Buffer.from(await file.arrayBuffer());

  // O MIME vai pela EXTENSÃO resolvida, não pelo que o browser mandou.
  //
  // O bucket tem allowlist de MIME (`application/pdf`, `text/markdown`,
  // `text/x-markdown`, `text/plain`). Um `.md` arrastado de certos sistemas
  // chega com `type` vazio, e `application/octet-stream` seria RECUSADO pelo
  // Storage — o upload falharia com uma mensagem que não tem nada a ver com o
  // que a pessoa fez.
  const MIME_POR_EXTENSAO = {
    pdf: "application/pdf",
    md: "text/markdown",
    txt: "text/plain",
  } as const;

  const { error: uploadErr } = await admin.storage
    .from(BUCKET_DE_CONHECIMENTO)
    .upload(blobPath, fileBuffer, { contentType: MIME_POR_EXTENSAO[ext], upsert: false });

  if (uploadErr) {
    console.error("[conhecimento-upload] upload falhou:", uploadErr.message);
    return fail("internal_error", "Erro ao guardar o arquivo.", 500, { requestId });
  }

  // Recusar o ilegível ENQUANTO a pessoa olha para a tela. Descobrir isso só
  // quando o worker rodar transformaria um erro corrigível num silêncio.
  try {
    await extrairTextoDoArquivo(blobPath, ext);
  } catch (err) {
    await admin.storage.from(BUCKET_DE_CONHECIMENTO).remove([blobPath]);
    if (err instanceof ErroDeExtracao) {
      return fail("unprocessable_entity", err.message, 422, { requestId });
    }
    console.error("[conhecimento-upload] extração falhou:", err);
    return fail("internal_error", "Erro ao ler o arquivo.", 500, { requestId });
  }

  const { data: ks, error: ksErr } = await admin
    .from("ai_knowledge_sources")
    .insert({
      organization_id: activeOrg.orgId,
      agent_id: agentId,
      source_type: "documento",
      name,
      status: "ready",
      is_active: true,
      ingested_at: new Date().toISOString(),
      source_metadata: {
        filename: file.name,
        blob_path: blobPath,
        ext,
        uploaded_by: authUser.id,
        mime_type: file.type,
        size_bytes: file.size,
      },
    })
    .select("id")
    .single();

  if (ksErr || !ks) {
    await admin.storage.from(BUCKET_DE_CONHECIMENTO).remove([blobPath]);
    if (ksErr?.code === "23505") {
      return fail(
        "knowledge_source_name_in_use",
        `Já existe um material chamado "${name}". Escolha outro nome.`,
        409,
        { requestId },
      );
    }
    console.error("[conhecimento-upload] insert falhou:", ksErr?.message);
    return fail("internal_error", "Erro ao registrar o material.", 500, { requestId });
  }

  const ksId = (ks as { id: string }).id;

  const { error: emitErr } = await admin.rpc("emit_event" as never, {
    p_event_type: "knowledge_source.updated",
    p_entity_kind: "ai_knowledge_source",
    p_entity_id: ksId,
    p_payload: { knowledge_source_id: ksId, agent_id: agentId, source_type: "documento" },
    p_organization_id: activeOrg.orgId,
  } as never);

  if (emitErr) {
    console.warn("[conhecimento-upload] emit_event falhou (não bloqueia):", emitErr.message);
  }

  const temChave = await temChaveDeEmbedding(activeOrg.orgId);

  return ok(
    { id: ksId, blob_path: blobPath, indexacao_habilitada: temChave },
    { status: 201, requestId },
  );
}
