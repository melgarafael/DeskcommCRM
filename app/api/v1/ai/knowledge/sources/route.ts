import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * GET  /api/v1/ai/knowledge/sources — os materiais da organização
 * POST /api/v1/ai/knowledge/sources — cadastra um material
 *
 * Desde a 0181 o acervo é da ORGANIZAÇÃO, não de um agente. `agent_id` continua
 * aceito e vira registro histórico de onde o material nasceu; quem lê o quê é
 * escolha da versão publicada de cada assistente
 * (`ai_agent_versions.knowledge_source_ids`).
 *
 * Auth: sessão por cookie, papel >= manager para escrever.
 * `organization_id` SEMPRE sai da sessão autenticada — nunca do corpo.
 */

import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";
import { z } from "zod";
import { ok, fail } from "@/lib/api/wrappers";
import { loadAuthUser, resolveActiveOrg } from "@/lib/auth/server";
import { requireRole } from "@/lib/auth/require-role";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { parseFaqMarkdown } from "@/lib/ai/rag/ingest/faq";
import { temChaveDeEmbedding } from "@/lib/ai/embeddings/chave";
import {
  aceitaTextoColado,
  canonizarTipoDeFonte,
  ePerguntaEResposta,
  rotuloDoTipo,
} from "@/lib/ai/rag/tipos-de-fonte";
import { BUCKET_DE_CONHECIMENTO } from "@/lib/ai/rag/ingest/documento";

export const dynamic = "force-dynamic";

// ---------------------------------------------------------------------------
// Zod
// ---------------------------------------------------------------------------

const faqItemSchema = z.object({
  question: z.string().min(1),
  answer: z.string().min(1),
  tags: z.array(z.string()).optional().default([]),
  locale: z.string().optional().default("pt-BR"),
});

/**
 * O tipo chega como texto livre e é CANONIZADO na borda.
 *
 * Um `z.enum` aqui recusaria os nomes legados (`policy`, `conversations`) que
 * quem integrou por API ainda manda — e o CHECK do banco saiu justamente para o
 * vocabulário poder crescer sem migration. `canonizarTipoDeFonte` traduz; o que
 * não traduzir é recusado com a lista do que existe.
 */
const createSourceSchema = z.object({
  /** Opcional desde a 0181: o material é da organização. */
  agent_id: z.string().uuid().optional(),
  source_type: z.string().min(1),
  name: z.string().trim().min(2).max(120),
  items: z.array(faqItemSchema).optional(),
  markdown_blob: z.string().optional(),
  source_metadata: z.record(z.string(), z.unknown()).optional().default({}),
});

const SELECT_COLUNAS =
  "id, agent_id, organization_id, source_type, name, status, last_index_status, " +
  "last_index_error, last_indexed_at, chunks_count, is_active, source_metadata, " +
  "active_kb_version_id, ingested_at, created_at, updated_at";

// ---------------------------------------------------------------------------
// GET
// ---------------------------------------------------------------------------

export async function GET(_req: NextRequest): Promise<Response> {
  const requestId = randomUUID();

  const authUser = await loadAuthUser();
  if (!authUser) {
    return fail("unauthenticated", "Auth required.", 401, { requestId });
  }
  const activeOrg = await resolveActiveOrg(authUser);
  if (!activeOrg) {
    return fail("forbidden", "Nenhuma organização ativa.", 403, { requestId });
  }

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("ai_knowledge_sources")
    .select(SELECT_COLUNAS)
    .eq("organization_id", activeOrg.orgId)
    .order("created_at", { ascending: false });

  if (error) {
    console.error("[ai-knowledge-sources] GET falhou:", error.message);
    return fail("internal_error", "Erro ao listar os materiais.", 500, { requestId });
  }

  // `ok()` já embrulha em `{ data }`. Com `{ data: data ?? [] }` o corpo saía
  // `{ data: { data: [...] } }` e o hook fazia `.filter` sobre o envelope.
  return ok(data ?? [], { requestId });
}

// ---------------------------------------------------------------------------
// POST
// ---------------------------------------------------------------------------

export async function POST(req: NextRequest): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();

  const authz = await requireRole("manager", { requestId, resource: "ai_knowledge" });
  if (!authz.ok) return authz.response;
  const { org: activeOrg } = authz;

  let rawBody: unknown;
  try {
    rawBody = await req.json();
  } catch {
    return fail("invalid_request", "Body JSON inválido.", 400, { requestId });
  }

  const parsed = createSourceSchema.safeParse(rawBody);
  if (!parsed.success) {
    return fail("validation_failed", "Campos inválidos.", 422, {
      requestId,
      details: parsed.error.flatten(),
    });
  }

  const input = parsed.data;
  const tipo = canonizarTipoDeFonte(input.source_type);
  if (tipo === null) {
    return fail(
      "validation_failed",
      `Tipo de material desconhecido: "${input.source_type}". Use faq, documento, conversas ou catalogo.`,
      422,
      { requestId },
    );
  }

  // Conteúdo mandado para um tipo que esta rota não ingere era ACEITO e
  // descartado em silêncio: a fonte nascia vazia, com 201, e ninguém entendia
  // por que o agente não sabia nada dali. Recusar alto é a única resposta honesta.
  const temConteudo =
    (input.items?.length ?? 0) > 0 || (input.markdown_blob?.trim().length ?? 0) > 0;
  if (temConteudo && !aceitaTextoColado(tipo)) {
    return fail(
      "unprocessable_entity",
      `Material de ${rotuloDoTipo(tipo).toLowerCase()} não recebe conteúdo colado — ` +
        "ele é preenchido automaticamente.",
      422,
      { requestId },
    );
  }

  const supabase = await createClient();

  // `agent_id` é HISTÓRICO. Continua validado — mandar o id de um agente de
  // outra organização tem de doer — mas não decide mais quem lê o material.
  if (input.agent_id) {
    const { data: agent, error: agentErr } = await supabase
      .from("ai_agents")
      .select("id")
      .eq("id", input.agent_id)
      .eq("organization_id", activeOrg.orgId)
      .maybeSingle();

    if (agentErr) {
      console.error("[ai-knowledge-sources] validação do agente falhou:", agentErr.message);
      return fail("internal_error", "Erro ao validar agent_id.", 500, { requestId });
    }
    if (!agent) {
      return fail("not_found", "Assistente não encontrado nesta organização.", 404, { requestId });
    }
  }

  let faqItems: Array<{ question: string; answer: string; tags: string[]; locale: string }> = [];

  if (ePerguntaEResposta(tipo)) {
    if (input.items && input.items.length > 0) {
      faqItems = input.items.map((it) => ({
        question: it.question,
        answer: it.answer,
        tags: it.tags,
        locale: it.locale,
      }));
    } else if (input.markdown_blob) {
      faqItems = parseFaqMarkdown(input.markdown_blob);
      if (faqItems.length === 0) {
        return fail(
          "invalid_request",
          "Não achei nenhum par pergunta/resposta no texto. Use uma linha ## Pergunta: e uma ## Resposta: por item.",
          400,
          { requestId },
        );
      }
    } else {
      return fail("invalid_request", "Cole o conteúdo do material antes de criar.", 400, {
        requestId,
      });
    }
  } else if (tipo === "documento" && !input.markdown_blob?.trim()) {
    return fail(
      "invalid_request",
      "Cole o texto do documento, ou envie o arquivo em /api/v1/ai/knowledge/sources/upload.",
      400,
      { requestId },
    );
  }

  const admin = createAdminClient();

  // TEXTO COLADO DE DOCUMENTO VIRA ARQUIVO.
  //
  // Um documento não é uma lista de pergunta/resposta: é texto corrido, e não
  // havia onde guardá-lo — o indexador só sabia ler `ai_faq_items`, e era por
  // isso que colar uma política produzia uma fonte que nunca indexava nada.
  //
  // Em vez de uma tabela nova para "texto que não é P/R", o texto é guardado
  // como `.md` no mesmo bucket dos arquivos e segue exatamente a mesma rota de
  // extração. Um destino, um caminho, um lugar para consertar.
  let metadata: Record<string, unknown> = { ...(input.source_metadata ?? {}) };
  if (tipo === "documento" && input.markdown_blob) {
    const blobPath = `${activeOrg.orgId}/${randomUUID()}.md`;
    const { error: upErr } = await admin.storage
      .from(BUCKET_DE_CONHECIMENTO)
      .upload(blobPath, Buffer.from(input.markdown_blob, "utf8"), {
        contentType: "text/markdown",
        upsert: false,
      });
    if (upErr) {
      console.error("[ai-knowledge-sources] guardar o texto falhou:", upErr.message);
      return fail("internal_error", "Erro ao guardar o conteúdo do material.", 500, { requestId });
    }
    metadata = { ...metadata, blob_path: blobPath, ext: "md", origem: "texto_colado" };
  }

  const { data: ks, error: ksErr } = await admin
    .from("ai_knowledge_sources")
    .insert({
      organization_id: activeOrg.orgId,
      agent_id: input.agent_id ?? null,
      source_type: tipo,
      name: input.name,
      status: "ready",
      is_active: true,
      source_metadata: metadata,
      ingested_at: new Date().toISOString(),
    })
    .select("id")
    .single();

  if (ksErr || !ks) {
    // `ai_knowledge_sources_nome_unico_por_org`: dois materiais ativos não podem
    // ter o mesmo nome — é por ele que a pessoa os distingue na tela e no
    // seletor do assistente. Sem esta tradução o 23505 saía como 500.
    if (ksErr?.code === "23505") {
      return fail(
        "knowledge_source_name_in_use",
        `Já existe um material chamado "${input.name}". Escolha outro nome.`,
        409,
        { requestId },
      );
    }
    console.error("[ai-knowledge-sources] insert falhou:", ksErr?.message);
    return fail("internal_error", "Erro ao criar o material.", 500, { requestId });
  }

  const ksId: string = (ks as { id: string }).id;

  let itemsCount = 0;
  if (faqItems.length > 0) {
    const rows = faqItems.map((item, idx) => ({
      organization_id: activeOrg.orgId,
      knowledge_source_id: ksId,
      question: item.question,
      answer: item.answer,
      tags: item.tags,
      locale: item.locale,
      position: idx,
    }));

    const { error: itemsErr } = await admin.from("ai_faq_items").insert(rows);

    if (itemsErr) {
      // Fonte sem item nenhum é fonte vazia: melhor desfazer do que deixar uma
      // linha que promete conteúdo e nunca vai indexar nada.
      await admin.from("ai_knowledge_sources").delete().eq("id", ksId);
      console.error("[ai-knowledge-sources] insert dos itens falhou:", itemsErr.message);
      return fail("internal_error", "Erro ao gravar o conteúdo do material.", 500, { requestId });
    }
    itemsCount = rows.length;
  }

  const { error: emitErr } = await admin.rpc("emit_event" as never, {
    p_event_type: "knowledge_source.updated",
    p_entity_kind: "ai_knowledge_source",
    p_entity_id: ksId,
    p_payload: {
      knowledge_source_id: ksId,
      agent_id: input.agent_id ?? null,
      source_type: tipo,
    },
    p_organization_id: activeOrg.orgId,
  } as never);

  if (emitErr) {
    console.warn("[ai-knowledge-sources] emit_event falhou (não bloqueia):", emitErr.message);
  }

  // A resposta DIZ se a indexação vai acontecer. Sem isto a tela prometia
  // "começa em instantes" para uma organização sem chave de embedding, e o
  // material ficava parado sem que nada na tela mudasse.
  const temChave = await temChaveDeEmbedding(activeOrg.orgId);

  return ok(
    { id: ksId, items_count: itemsCount, indexacao_habilitada: temChave },
    { status: 201, requestId },
  );
}
