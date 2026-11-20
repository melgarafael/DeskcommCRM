import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * PATCH  /api/v1/ai/knowledge/sources/[id]  — update knowledge source
 *                                            `{ status: 'active' }` tira do arquivo
 * DELETE /api/v1/ai/knowledge/sources/[id]  — soft-delete (status='archived')
 *
 * Auth: cookie session OU token de servidor (`resolveAuthDual`). Role >= manager required.
 * organization_id is ALWAYS resolved from the authenticated session or from the token row — never from body/path.
 */

import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";
import { z } from "zod";
import { ok, fail } from "@/lib/api/wrappers";
import { resolveAuthDual, tetoDeEscritaDoToken } from "@/lib/api/auth-dual";
import { audit } from "@/lib/audit";
import { createAdminClient } from "@/lib/supabase/admin";
import { canonizarTipoDeFonte } from "@/lib/ai/rag/tipos-de-fonte";
import { PATCH_DE_RESTAURO, STATUS_DO_MATERIAL_CONSULTAVEL } from "@/lib/ai/knowledge/estado-do-material";
import { traduzir } from "@/lib/i18n/dicionario";
import { IDIOMA_PADRAO } from "@/lib/i18n/idiomas";
import { caminhoDaOrganizacao } from "@/lib/ai/knowledge/caminho-do-arquivo";

export const dynamic = "force-dynamic";

// ---------------------------------------------------------------------------
// Zod schema for PATCH
// ---------------------------------------------------------------------------

const faqItemSchema = z.object({
  question: z.string().min(1),
  answer: z.string().min(1),
  tags: z.array(z.string()).optional().default([]),
  locale: z.string().optional().default("pt-BR"),
});

const patchSourceSchema = z.object({
  name: z.string().min(2).max(120).optional(),
  items: z.array(faqItemSchema).optional(),
  source_metadata: z.record(z.string(), z.unknown()).optional(),
  /**
   * "Tirar do arquivo". O único valor aceito é `active`: arquivar continua
   * sendo o DELETE, e um `status: "archived"` por PATCH seria uma segunda
   * porta para a mesma coisa, sem a auditoria nem a coerência de `is_active`
   * que o DELETE grava.
   */
  status: z.literal("active").optional(),
});

// ---------------------------------------------------------------------------
// GET — o material e o conteúdo que dá para editar
// ---------------------------------------------------------------------------
//
// Existe para o diálogo de edição não ter de adivinhar o que já está lá. Sem
// ele, "Editar conteúdo" abriria um campo vazio e salvar apagaria a FAQ inteira
// — o pior desfecho possível para um botão chamado "editar".

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const requestId = randomUUID();
  const { id: sourceId } = await params;

  const authz = await resolveAuthDual(req, {
    requestId,
    resource: "ai_knowledge",
    role: "manager",
    scope: "config:read",
    tokenRole: "admin",
  });
  if (!authz.ok) return authz.response;
  const teto = await tetoDeEscritaDoToken(authz, "ai_knowledge", requestId);
  if (teto) return teto;
  const supabase = authz.supabase;
  const activeOrg = { orgId: authz.organizationId };
  const { data: fonte, error } = await supabase
    .from("ai_knowledge_sources")
    .select(
      "id, agent_id, organization_id, source_type, name, status, last_index_status, " +
        "last_index_error, last_indexed_at, chunks_count, is_active, source_metadata, " +
        "active_kb_version_id, created_at, updated_at",
    )
    .eq("id", sourceId)
    .eq("organization_id", activeOrg.orgId)
    .maybeSingle();

  if (error) {
    console.error("[ai-knowledge-sources] GET falhou:", error.message);
    return fail("internal_error", "Erro ao ler o material.", 500, { requestId });
  }
  if (!fonte) {
    return fail("not_found", "Material não encontrado.", 404, { requestId });
  }

  const { data: itens } = await supabase
    .from("ai_faq_items")
    .select("question, answer, tags, locale, position")
    .eq("organization_id", activeOrg.orgId)
    .eq("knowledge_source_id", sourceId)
    .order("position", { ascending: true });

  return ok({ ...(fonte as unknown as Record<string, unknown>), items: itens ?? [] }, { requestId });
}

// ---------------------------------------------------------------------------
// PATCH
// ---------------------------------------------------------------------------

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const { id: sourceId } = await params;

  const authz = await resolveAuthDual(req, {
    requestId,
    resource: "ai_knowledge",
    role: "manager",
    scope: "config:write",
    tokenRole: "admin",
  });
  if (!authz.ok) return authz.response;
  const teto = await tetoDeEscritaDoToken(authz, "ai_knowledge", requestId);
  if (teto) return teto;
  const supabase = authz.supabase;
  const activeOrg = { orgId: authz.organizationId };
  // As recusas desta rota citam o material em conflito: o texto é traduzido
  // AQUI, com «{nome}» por preencher, para quem escolheu espanhol não receber
  // um 409 em português montado no servidor (#2559).
  const t = (texto: string) => traduzir(texto, authz.idioma ?? IDIOMA_PADRAO);

  // Parse + validate body.
  let rawBody: unknown;
  try {
    rawBody = await req.json();
  } catch {
    return fail("invalid_request", "Body JSON inválido.", 400, { requestId });
  }

  const parsed = patchSourceSchema.safeParse(rawBody);
  if (!parsed.success) {
    return fail("validation_failed", "Campos inválidos.", 422, {
      requestId,
      details: parsed.error.flatten(),
    });
  }

  const input = parsed.data;

  // Tirar do arquivo é uma ação só. Recusar o corpo misto ANTES de qualquer
  // escrita é o que separa esta rota do defeito que o PATCH de `items` já teve:
  // aplicar metade do pedido e responder 200 para a outra metade.
  if (input.status !== undefined) {
    const junto = (["name", "items", "source_metadata"] as const).filter(
      (campo) => input[campo] !== undefined,
    );
    if (junto.length > 0) {
      return fail(
        "unprocessable_entity",
        t(
          'Para tirar do arquivo, envie apenas { "status": "active" }. Nome e conteúdo se alteram depois, com o material já de volta.',
        ),
        422,
        { requestId },
      );
    }
  }

  // Verify the source exists and belongs to the org (o filtro explícito de organização
  // é quem protege: o cliente do token é admin, sem RLS).
  const { data: existing, error: fetchErr } = await supabase
    .from("ai_knowledge_sources")
    .select("id, source_type, agent_id, name, status, is_active")
    .eq("id", sourceId)
    .eq("organization_id", activeOrg.orgId)
    .maybeSingle();

  if (fetchErr) {
    console.error("[ai-knowledge-sources] PATCH fetch failed:", fetchErr.message);
    return fail("internal_error", "Erro ao verificar fonte.", 500, { requestId });
  }
  if (!existing) {
    return fail("not_found", "Fonte de conhecimento não encontrada.", 404, { requestId });
  }

  const ksRow = existing as {
    id: string;
    source_type: string;
    agent_id: string | null;
    name: string | null;
    status: string | null;
    is_active: boolean | null;
  };
  const tipo = canonizarTipoDeFonte(ksRow.source_type);

  // `items` SÓ tem efeito em `faq`. A conferência vem antes de QUALQUER escrita.
  //
  // A recusa anterior testava `!aceitaTextoColado(tipo)`, e `documento` aceita
  // texto colado — na CRIAÇÃO, onde o texto vira arquivo. No PATCH isso passava
  // pela recusa, não entrava no ramo do FAQ e terminava em `200 { id }`: quem
  // integra por API achava que tinha trocado o conteúdo e nada mudou. E a
  // recusa vinha DEPOIS do `update` de nome/metadata, então um 422 em
  // `{ name, items }` já tinha gravado o nome novo. Recusa alta, antes de tudo.
  if (input.items !== undefined && tipo !== "faq") {
    return fail(
      "unprocessable_entity",
      "Este material não é preenchido por texto colado — envie o arquivo ou aguarde a rotina que o alimenta.",
      422,
      { requestId },
    );
  }

  // `blob_path` do corpo só no formato que o upload grava, na pasta de quem
  // chama, pela sessão ou pelo token. Nenhuma tela manda este campo.
  const blobPathDoCorpo = input.source_metadata?.blob_path;
  if (
    blobPathDoCorpo !== undefined &&
    !caminhoDaOrganizacao(blobPathDoCorpo, authz.organizationId)
  ) {
    return fail("validation_failed", "Caminho do arquivo fora da organização.", 422, {
      requestId,
    });
  }

  // Build update payload (only provided fields).
  const updatePayload: Record<string, unknown> = {};
  if (input.name !== undefined) updatePayload.name = input.name;
  if (input.source_metadata !== undefined) updatePayload.source_metadata = input.source_metadata;

  const admin = createAdminClient();

  // ---------------------------------------------------------------------------
  // Tirar do arquivo — PATCH { status: 'active' }
  // ---------------------------------------------------------------------------
  //
  // Arquivar era um caminho só de ida: o DELETE grava `archived` + `is_active`
  // false e não havia rota de volta, então quem arquivava por engano recriava o
  // material à mão e perdia o histórico do que o agente já sabia.
  //
  // O estado de volta é `ready`, NÃO `active`. São dois vocabulários diferentes,
  // e trocá-los foi o defeito desta fatia na primeira tentativa:
  //
  //  * o pedido da API diz `status: "active"` — "está no acervo, não está
  //    arquivado", na língua de quem chama;
  //  * a COLUNA só aceita `ready | archived | building | failed`
  //    (`ai_knowledge_sources_status_check`). Gravar `active` viola o CHECK com
  //    23514 e a rota devolvia 500 — o material continuava arquivado;
  //  * e mesmo que o CHECK aceitasse, o motor de busca só enxerga a fonte com
  //    `s.is_active and s.status = 'ready'` (`fn_buscar_trechos_das_fontes`,
  //    0181). `active` na coluna = material na tela e invisível para o agente.
  //
  // `is_active` vai JUNTO, e não é detalhe de simetria: o rag-indexer pula a
  // fonte com `!is_active || status === 'archived'` (workers/rag-indexer.ts:707).
  // Voltar só o `status` deixaria o material na lista, na cara do operador, e
  // fora do que o agente consulta — pior que o arquivo, porque some sem aviso.
  // `tests/invariants/rag-acervo-da-organizacao.test.ts` prova os dois estados
  // contra um Postgres de verdade, pela própria função de busca.
  if (input.status === "active") {
    const nome = (ksRow.name ?? "").trim();

    // Já está no acervo: nada a escrever, nada a emitir, nada a auditar. Uma
    // trilha cheia de "restaurado" para o que nunca esteve arquivado esconde
    // exatamente o registro que se quer ler depois.
    if (ksRow.status !== "archived") {
      return ok({ id: sourceId, status: ksRow.status, restored: false }, { requestId });
    }

    const { error: restoreErr } = await admin
      .from("ai_knowledge_sources")
      .update({ ...PATCH_DE_RESTAURO })
      .eq("id", sourceId)
      .eq("organization_id", activeOrg.orgId);

    if (restoreErr) {
      // O nome é a identidade do material ATIVO. O índice único
      // `ai_knowledge_sources_nome_unico_por_org` — (organization_id,
      // lower(btrim(name))) WHERE is_active, da 0181 — recusa dois ativos
      // homônimos: quem arquivou "FAQ da loja" e criou outro com o mesmo nome
      // bate aqui ao voltar. Sem esta tradução o 23505 saía como 500 e a tela
      // dizia "erro inesperado" para um conflito que a pessoa resolve sozinha.
      if (restoreErr.code === "23505") {
        return fail(
          "knowledge_source_name_in_use",
          t(
            "Já existe um material ativo chamado «{nome}». Renomeie um dos dois antes de tirar este material do arquivo.",
          ).replace("{nome}", nome),
          409,
          { requestId },
        );
      }
      console.error("[ai-knowledge-sources] tirar do arquivo falhou:", restoreErr.message);
      return fail("internal_error", "Erro ao tirar o material do arquivo.", 500, { requestId });
    }

    // O worker só reindexa o que ele sabe que mudou. De volta ao acervo, o
    // índice daquele material pode estar velho (ou nunca ter existido): o evento
    // é o pedido de reindexação, igual ao que a criação e o reindex manual emitem.
    const { error: emitErr } = await admin.rpc("emit_event" as never, {
      p_event_type: "knowledge_source.updated",
      p_entity_kind: "ai_knowledge_source",
      p_entity_id: sourceId,
      p_payload: {
        knowledge_source_id: sourceId,
        agent_id: ksRow.agent_id,
        source_type: ksRow.source_type,
        triggered_by: "restored",
      },
      p_organization_id: activeOrg.orgId,
    } as never);

    if (emitErr) {
      console.warn("[ai-knowledge-sources] emit_event failed (non-blocking):", emitErr.message);
    }

    // De/para explícito: "quem tirou do arquivo" e "de onde para onde" é o que
    // a trilha precisa responder; o texto do material continua fora dela.
    void audit({
      action: "ai.knowledge_source_restored",
      actorUserId: authz.actor.type === "user" ? authz.actor.id : null,
      actorApiTokenId: authz.apiTokenId ?? null,
      organizationId: activeOrg.orgId,
      resourceType: "ai_knowledge_source",
      resourceId: sourceId,
      requestId,
      metadata: {
        source_type: ksRow.source_type,
        de: { status: "archived", is_active: false },
        para: { ...PATCH_DE_RESTAURO },
      },
    });

    return ok(
      { id: sourceId, status: STATUS_DO_MATERIAL_CONSULTAVEL, restored: true },
      { requestId },
    );
  }

  if (Object.keys(updatePayload).length > 0) {
    const { error: updateErr } = await admin
      .from("ai_knowledge_sources")
      .update(updatePayload)
      .eq("id", sourceId)
      .eq("organization_id", activeOrg.orgId);

    if (updateErr) {
      console.error("[ai-knowledge-sources] PATCH update failed:", updateErr.message);
      return fail("internal_error", "Erro ao atualizar fonte.", 500, { requestId });
    }
  }

  // Replace FAQ items if provided.
  let itemsCount: number | undefined;
  if (input.items !== undefined && tipo === "faq") {
    // Delete existing items.
    const { error: delErr } = await admin
      .from("ai_faq_items")
      .delete()
      .eq("knowledge_source_id", sourceId)
      .eq("organization_id", activeOrg.orgId);

    if (delErr) {
      console.error("[ai-knowledge-sources] PATCH delete items failed:", delErr.message);
      return fail("internal_error", "Erro ao remover itens antigos.", 500, { requestId });
    }

    if (input.items.length > 0) {
      const rows = input.items.map((item, idx) => ({
        organization_id: activeOrg.orgId,
        knowledge_source_id: sourceId,
        question: item.question,
        answer: item.answer,
        tags: item.tags,
        locale: item.locale,
        position: idx,
      }));

      const { error: insertErr } = await admin.from("ai_faq_items").insert(rows);

      if (insertErr) {
        console.error("[ai-knowledge-sources] PATCH insert items failed:", insertErr.message);
        return fail("internal_error", "Erro ao inserir novos itens FAQ.", 500, { requestId });
      }
      itemsCount = rows.length;
    } else {
      itemsCount = 0;
    }
  }

  // Emit knowledge_source.updated (fire-and-forget).
  const { error: emitErr } = await admin.rpc("emit_event" as never, {
    p_event_type: "knowledge_source.updated",
    p_entity_kind: "ai_knowledge_source",
    p_entity_id: sourceId,
    p_payload: {
      knowledge_source_id: sourceId,
      agent_id: ksRow.agent_id,
      source_type: ksRow.source_type,
    },
    p_organization_id: activeOrg.orgId,
  } as never);

  if (emitErr) {
    console.warn("[ai-knowledge-sources] emit_event failed (non-blocking):", emitErr.message);
  }

  // A trilha responde "quem mudou o que o agente diz aos clientes". Só ids,
  // nomes de campo e contagem — o texto do material nunca entra: a tabela é
  // append-only e a cascata da LGPD não a alcança.
  void audit({
    action: "ai.knowledge_source_updated",
    actorUserId: authz.actor.type === "user" ? authz.actor.id : null,
    actorApiTokenId: authz.apiTokenId ?? null,
    organizationId: activeOrg.orgId,
    resourceType: "ai_knowledge_source",
    resourceId: sourceId,
    requestId,
    metadata: {
      source_type: ksRow.source_type,
      campos: Object.keys(updatePayload),
      ...(itemsCount !== undefined ? { items_count: itemsCount } : {}),
    },
  });

  return ok(
    { id: sourceId, ...(itemsCount !== undefined ? { items_count: itemsCount } : {}) },
    { requestId },
  );
}

// ---------------------------------------------------------------------------
// DELETE — soft-delete (status='archived')
// ---------------------------------------------------------------------------

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const { id: sourceId } = await params;

  const authz = await resolveAuthDual(req, {
    requestId,
    resource: "ai_knowledge",
    role: "manager",
    scope: "config:write",
    tokenRole: "admin",
  });
  if (!authz.ok) return authz.response;
  const teto = await tetoDeEscritaDoToken(authz, "ai_knowledge", requestId);
  if (teto) return teto;
  const supabase = authz.supabase;
  const activeOrg = { orgId: authz.organizationId };

  // Verify ownership: filtro explícito de organização (o cliente do token é admin, sem RLS).
  const { data: existing, error: fetchErr } = await supabase
    .from("ai_knowledge_sources")
    .select("id")
    .eq("id", sourceId)
    .eq("organization_id", activeOrg.orgId)
    .maybeSingle();

  if (fetchErr) {
    console.error("[ai-knowledge-sources] DELETE fetch failed:", fetchErr.message);
    return fail("internal_error", "Erro ao verificar fonte.", 500, { requestId });
  }
  if (!existing) {
    return fail("not_found", "Fonte de conhecimento não encontrada.", 404, { requestId });
  }

  const admin = createAdminClient();
  // `is_active` JUNTO, e não só `status`.
  //
  // Nenhuma linha do repo jamais escreveu `is_active = false`. Enquanto existia
  // o índice único `(agent_id, source_type) WHERE is_active`, isso deixava o
  // "slot" ocupado por um material arquivado PARA SEMPRE: recriar devolvia 409 e
  // não havia caminho nenhum de volta. O índice saiu na 0181 e a incoerência
  // dos dois campos sairia junto — a constraint
  // `ai_knowledge_sources_arquivada_nao_e_ativa` agora recusa arquivar pela metade.
  const { error: archiveErr } = await admin
    .from("ai_knowledge_sources")
    .update({ status: "archived", is_active: false })
    .eq("id", sourceId)
    .eq("organization_id", activeOrg.orgId);

  if (archiveErr) {
    console.error("[ai-knowledge-sources] arquivar falhou:", archiveErr.message);
    return fail("internal_error", "Erro ao arquivar o material.", 500, { requestId });
  }

  // Arquivar tira o material do que o agente responde: "quem arquivou o FAQ de
  // trocas, e quando" só tem resposta aqui.
  void audit({
    action: "ai.knowledge_source_archived",
    actorUserId: authz.actor.type === "user" ? authz.actor.id : null,
    actorApiTokenId: authz.apiTokenId ?? null,
    organizationId: activeOrg.orgId,
    resourceType: "ai_knowledge_source",
    resourceId: sourceId,
    requestId,
  });

  return ok({ id: sourceId, status: "archived" }, { requestId });
}
