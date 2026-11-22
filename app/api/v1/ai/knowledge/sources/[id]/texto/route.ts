import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * PUT /api/v1/ai/knowledge/sources/[id]/texto — EDITAR O TEXTO COLADO (#4596).
 *
 * Um documento criado colando texto é guardado como `.md` no bucket do acervo
 * (`app/api/v1/ai/knowledge/sources/route.ts`, `origem: "texto_colado"`). Até
 * aqui só FAQ tinha edição de conteúdo: corrigir uma vírgula na política de
 * troca exigia apagar o material e criar de novo, perdendo o vínculo com os
 * assistentes que o consultam.
 *
 * Esta rota regrava o MESMO arquivo e reindexa pelo MESMO `emit_event` da
 * criação. Nenhuma coluna do material muda — o arquivo é a fonte da verdade, e
 * o indexador relê o arquivo a cada `knowledge_source.updated`.
 *
 * Rota irmã, e não um ramo do PATCH, de propósito: o PATCH troca nome,
 * metadados e pares de FAQ; esta só troca o texto de um tipo de material. O que
 * ela recusa, e por quê:
 *
 *  - FAQ: o conteúdo mora em `ai_faq_items`, e o caminho é o PATCH com `items`.
 *  - Arquivo enviado (PDF, CSV…): regravar markdown por cima de um PDF trocaria
 *    o arquivo da pessoa por outra coisa. Só `origem: "texto_colado"` com
 *    `ext: "md"` passa.
 *  - `blob_path` fora da pasta da organização da sessão: esta rota escreve com
 *    o cliente admin, então só regrava o que está na pasta de quem pediu.
 *  - Arquivado: o indexador ignora material arquivado, e "salvo" sem reindexar
 *    seria uma promessa falsa.
 *
 * Auth: sessão por cookie, papel >= manager. `organization_id` vem da sessão.
 */

import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";
import { z } from "zod";

import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { BUCKET_DE_CONHECIMENTO } from "@/lib/ai/rag/ingest/documento";
import { caminhoDaOrganizacao } from "@/lib/ai/knowledge/caminho-do-arquivo";
import { veioDeTextoColado } from "@/lib/ai/rag/tipos-de-fonte";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

const corpoSchema = z.object({
  // Vazio apagaria o material: quem quer tirá-lo do agente arquiva.
  texto: z.string().refine((t) => t.trim().length > 0, "O texto não pode ficar vazio."),
});

interface FonteDoTexto {
  id: string;
  source_type: string;
  agent_id: string | null;
  status: string | null;
  is_active: boolean;
  source_metadata: Record<string, unknown> | null;
}

/**
 * O caminho do `.md` que dá para regravar, ou `null` se o material não veio de
 * texto colado nesta organização.
 */
function caminhoDoTextoColado(fonte: FonteDoTexto, orgId: string): string | null {
  if (!veioDeTextoColado(fonte.source_type, fonte.source_metadata)) return null;
  const caminho = fonte.source_metadata?.blob_path;
  return caminhoDaOrganizacao(caminho, orgId) ? caminho : null;
}

export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const { id: sourceId } = await params;

  const authz = await requireRole("manager", { requestId, resource: "ai_knowledge" });
  if (!authz.ok) return authz.response;
  const { user: authUser, org: activeOrg } = authz;

  let rawBody: unknown;
  try {
    rawBody = await req.json();
  } catch {
    return fail("invalid_request", "Body JSON inválido.", 400, { requestId });
  }

  const parsed = corpoSchema.safeParse(rawBody);
  if (!parsed.success) {
    return fail("validation_failed", "Campos inválidos.", 422, {
      requestId,
      details: parsed.error.flatten(),
    });
  }
  const { texto } = parsed.data;

  const supabase = await createClient();
  const { data, error: fetchErr } = await supabase
    .from("ai_knowledge_sources")
    .select("id, source_type, agent_id, status, is_active, source_metadata")
    .eq("id", sourceId)
    .eq("organization_id", activeOrg.orgId)
    .maybeSingle();

  if (fetchErr) {
    console.error("[ai-knowledge-texto] leitura do material falhou:", fetchErr.message);
    return fail("internal_error", "Erro ao verificar o material.", 500, { requestId });
  }
  if (!data) {
    return fail("not_found", "Material não encontrado.", 404, { requestId });
  }

  const fonte = data as unknown as FonteDoTexto;
  const caminho = caminhoDoTextoColado(fonte, activeOrg.orgId);
  if (!caminho) {
    return fail(
      "unprocessable_entity",
      "Só dá para editar o texto de um documento criado colando texto. " +
        "Perguntas e respostas se editam pelo próprio editor; arquivo enviado, enviando de novo.",
      422,
      { requestId },
    );
  }
  if (fonte.status === "archived" || !fonte.is_active) {
    return fail(
      "conflict",
      "Este material está arquivado: o agente não o consulta, e a edição não seria preparada.",
      409,
      { requestId },
    );
  }

  const admin = createAdminClient();

  const { error: upErr } = await admin.storage
    .from(BUCKET_DE_CONHECIMENTO)
    .upload(caminho, Buffer.from(texto, "utf8"), {
      contentType: "text/markdown",
      upsert: true,
    });
  if (upErr) {
    console.error("[ai-knowledge-texto] regravar o texto falhou:", upErr.message);
    return fail("internal_error", "Erro ao guardar o texto do material.", 500, { requestId });
  }

  // O mesmo evento da criação e do PATCH: o indexador relê o arquivo.
  const { error: emitErr } = await admin.rpc("emit_event" as never, {
    p_event_type: "knowledge_source.updated",
    p_entity_kind: "ai_knowledge_source",
    p_entity_id: sourceId,
    p_payload: {
      knowledge_source_id: sourceId,
      agent_id: fonte.agent_id,
      source_type: fonte.source_type,
    },
    p_organization_id: activeOrg.orgId,
  } as never);

  if (emitErr) {
    console.warn("[ai-knowledge-texto] emit_event falhou (não bloqueia):", emitErr.message);
  }

  // Mesma ação de auditoria do PATCH. Só o nome do campo, nunca o texto: a
  // tabela é append-only e a cascata da LGPD não a alcança.
  void audit({
    action: "ai.knowledge_source_updated",
    actorUserId: authUser.id,
    organizationId: activeOrg.orgId,
    resourceType: "ai_knowledge_source",
    resourceId: sourceId,
    requestId,
    metadata: { source_type: fonte.source_type, campos: ["texto"] },
  });

  return ok({ id: sourceId }, { requestId });
}
