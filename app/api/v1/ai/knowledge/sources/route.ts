/**
 * GET  /api/v1/ai/knowledge/sources  — list knowledge sources for active org
 * POST /api/v1/ai/knowledge/sources  — create a knowledge source (optionally with FAQ items)
 *
 * Auth: cookie session. Role >= manager required for POST.
 * organization_id is ALWAYS resolved from the authenticated session — never from body.
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
import { parseCatalogCsv } from "@/lib/ai/rag/ingest/catalog-csv";

export const dynamic = "force-dynamic";

// ---------------------------------------------------------------------------
// Zod schemas
// ---------------------------------------------------------------------------

const faqItemSchema = z.object({
  question: z.string().min(1),
  answer: z.string().min(1),
  tags: z.array(z.string()).optional().default([]),
  locale: z.string().optional().default("pt-PT"),
});

const sourceTypeEnum = z.enum([
  "faq",
  "policy",
  "conversation",
  "conversations",
  "catalog",
]);

const createSourceSchema = z.object({
  agent_id: z.string().uuid(),
  source_type: sourceTypeEnum,
  name: z.string().min(2).max(120),
  items: z.array(faqItemSchema).optional(),
  markdown_blob: z.string().optional(),
  /** Só para source_type "catalog": planilha CSV (nome,preco,sku,categoria,variantes,estoque). */
  csv_blob: z.string().optional(),
  source_metadata: z.record(z.string(), z.unknown()).optional().default({}),
});

// ---------------------------------------------------------------------------
// GET — list knowledge sources
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
    .select(
      "id, agent_id, organization_id, source_type, name, status, last_index_status, last_index_error, last_indexed_at, chunks_count, is_active, source_metadata, ingested_at, created_at, updated_at",
    )
    .eq("organization_id", activeOrg.orgId)
    .order("created_at", { ascending: false });

  if (error) {
    console.error("[ai-knowledge-sources] GET list failed:", error.message);
    return fail("internal_error", "Erro ao listar fontes de conhecimento.", 500, { requestId });
  }

  // `ok()` já embrulha em `{ data }`. Com `{ data: data ?? [] }` o corpo saía
  // `{ data: { data: [...] } }` e o hook fazia `.filter` sobre o envelope —
  // TypeError, lista de fontes só aparecia pelo SSR e nunca atualizava.
  return ok(data ?? [], { requestId });
}

// ---------------------------------------------------------------------------
// POST — create knowledge source
// ---------------------------------------------------------------------------

export async function POST(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();

  const authz = await requireRole("manager", { requestId, resource: "ai_knowledge" });
  if (!authz.ok) return authz.response;
  const { org: activeOrg } = authz;

  // Parse + validate body.
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

  // Validate agent_id belongs to org (using user-scoped client — RLS enforces tenant).
  const supabase = await createClient();
  const { data: agent, error: agentErr } = await supabase
    .from("ai_agents")
    .select("id")
    .eq("id", input.agent_id)
    .eq("organization_id", activeOrg.orgId)
    .maybeSingle();

  if (agentErr) {
    console.error("[ai-knowledge-sources] agent lookup failed:", agentErr.message);
    return fail("internal_error", "Erro ao validar agent_id.", 500, { requestId });
  }
  if (!agent) {
    return fail("not_found", "Agent não encontrado nesta organização.", 404, { requestId });
  }

  // Itens de conteúdo: valem para 'faq', 'policy' E 'catalog'. Antes só 'faq'
  // era tratado, e uma política enviada com markdown_blob era ACEITA e
  // descartada em silêncio — a fonte nascia vazia, sem erro, e o indexador
  // depois a marcava como falha sem que ninguém entendesse por quê. Os três
  // tipos guardam pergunta/resposta na mesma tabela.
  let faqItems: Array<{ question: string; answer: string; tags: string[]; locale: string }> = [];
  let catalogRowErrors: Array<{ row: number; reason: string }> = [];

  if (input.source_type === "catalog" && input.csv_blob) {
    // Erro é POR LINHA: uma planilha de 200 produtos com um preço mal digitado
    // não pode perder as outras 199 (quem importa isso não é dev). Só falha a
    // fonte inteira se NENHUMA linha deu certo.
    const parsed = parseCatalogCsv(input.csv_blob, "MZN");
    catalogRowErrors = parsed.errors;
    faqItems = parsed.items;
    if (faqItems.length === 0) {
      return fail("invalid_request", "Nenhuma linha válida na planilha.", 400, {
        requestId,
        details: { row_errors: catalogRowErrors },
      });
    }
  } else if (
    input.source_type === "faq" ||
    input.source_type === "policy" ||
    input.source_type === "catalog"
  ) {
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
          "markdown_blob não contém itens FAQ válidos. Use seções ## Pergunta: / ## Resposta:.",
          400,
          { requestId },
        );
      }
    }
  }

  // Insert ai_knowledge_sources — use admin client (service role) with explicit
  // organization_id filter (RLS bypass path, org resolved from JWT above).
  const admin = createAdminClient();

  const { data: ks, error: ksErr } = await admin
    .from("ai_knowledge_sources")
    .insert({
      organization_id: activeOrg.orgId,
      agent_id: input.agent_id,
      source_type: input.source_type,
      name: input.name,
      status: "ready",
      source_metadata: input.source_metadata ?? {},
      ingested_at: new Date().toISOString(),
    })
    .select("id")
    .single();

  if (ksErr || !ks) {
    console.error("[ai-knowledge-sources] insert knowledge source failed:", ksErr?.message);
    return fail("internal_error", "Erro ao criar fonte de conhecimento.", 500, { requestId });
  }

  const ksId: string = (ks as { id: string }).id;

  // Insert FAQ items if present.
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
      console.error("[ai-knowledge-sources] insert faq items failed:", itemsErr.message);
      // Best-effort: source was created; log error but don't roll back.
      console.warn(
        "[ai-knowledge-sources] knowledge source created but FAQ items failed — ks id:",
        ksId,
      );
    } else {
      itemsCount = rows.length;
    }
  }

  // Emit knowledge_source.updated event (fire-and-forget via DB RPC).
  const { error: emitErr } = await admin.rpc("emit_event" as never, {
    p_event_type: "knowledge_source.updated",
    p_entity_kind: "ai_knowledge_source",
    p_entity_id: ksId,
    p_payload: {
      knowledge_source_id: ksId,
      agent_id: input.agent_id,
      source_type: input.source_type,
    },
    p_organization_id: activeOrg.orgId,
  } as never);

  if (emitErr) {
    console.warn("[ai-knowledge-sources] emit_event failed (non-blocking):", emitErr.message);
  }

  return ok(
    {
      id: ksId,
      items_count: itemsCount,
      ...(catalogRowErrors.length > 0 ? { row_errors: catalogRowErrors } : {}),
    },
    { status: 201, requestId },
  );
}
