/**
 * Core handlers para /api/v1/conversations.
 *
 * Reusados pelo Route Handler REST e por MCP tools (S-13.03/04).
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { ApiError } from "@/lib/api/types";
import type { Actor, HandlerCtx } from "@/lib/api/handlers/types";
import { audit } from "@/lib/audit";
import { CONVERSATION_TERMINAL_STATUSES } from "@/lib/schemas";
import type {
  ListConversationsQuery,
  PatchConversationInput,
} from "@/lib/schemas";
import type { Conversation } from "@/lib/types/messaging";

/**
 * Prepara o termo digitado para viajar dentro de um `or=` do PostgREST.
 *
 * Exportada para ser testável: o defeito que ela impede é de SINTAXE, e sintaxe
 * se verifica sem subir banco. O comportamento contra o PostgREST de verdade
 * está em `tests/e2e/`.
 */
export function termoSeguroParaOr(bruto: string): string {
  return bruto
    .trim()
    // curingas do `ilike` (Postgres)
    .replace(/[%_]/g, (m) => `\\${m}`)
    // gramática do `or=` (PostgREST) — viram o próprio curinga
    .replace(/[,()]/g, "*");
}

type SB = SupabaseClient;

/**
 * Quantos contatos a busca do Inbox casa antes de cortar.
 *
 * Não é um número estético: os ids viajam DENTRO da querystring do PostgREST
 * (`contact_id.in.(<uuid>,<uuid>,…)`), e requisição GET tem teto no gateway.
 */
const TETO_DE_CONTATOS_NA_BUSCA = 120;

/**
 * O orçamento de bytes que a lista de ids pode ocupar na URL.
 *
 * O muro real é 8.192 B na linha de requisição (Kong e nginx, ambos no default),
 * e a URL leva mais coisa além dos ids: caminho, `select` com todas as
 * `SELECT_COLS`, o filtro de organização, o `order`, o `limit` e o próprio
 * `ilike` do termo. Medido neste arquivo, com 1 id a URL já tem 892 B — então o
 * que sobra para os ids é o resto, e 5.000 B deixa folga confortável para o
 * termo de busca crescer sem que ninguém precise voltar aqui.
 *
 * Cortar por BYTES e não por quantidade é o que faz esta guarda sobreviver a
 * uma coluna nova em `SELECT_COLS` ou a um formato de id diferente.
 */
const ORCAMENTO_DE_IDS_NA_URL = 5_000;

/**
 * Corta a lista de ids no que cabe no orçamento da URL.
 *
 * Devolver menos contatos torna a busca INCOMPLETA — o que é ruim — mas devolver
 * todos torna a tela QUEBRADA, com `414` virando `500` na cara do operador. Entre
 * uma lista pobre e uma tela que não abre, a lista pobre ganha; e a diferença
 * aparece porque a busca por conteúdo (`last_message_preview`) continua rodando
 * ao lado, sem depender desta lista.
 */
function idsQueCabemNaURL(ids: string[]): string[] {
  const cabem: string[] = [];
  let bytes = 0;
  for (const id of ids) {
    // +1 pela vírgula que separa; o último sobra do lado seguro.
    const custo = id.length + 1;
    if (bytes + custo > ORCAMENTO_DE_IDS_NA_URL) break;
    cabem.push(id);
    bytes += custo;
  }
  return cabem;
}

const SELECT_COLS = `
  id, organization_id, contact_id, channel_session_id, channel, status,
  status_changed_at, assigned_to_user_id, assigned_to_user_name, assignee_kind, assigned_at, last_inbound_at,
  last_outbound_at, last_message_at, last_message_preview,
  unread_count_for_assignee, is_group, group_chat_id, tags, metadata,
  snooze_until, created_at, updated_at,
  bot_silenced_until, last_handoff_at,
  comando_da_conversa,
  contacts:contact_id (id, display_name, name, phone_number, is_anonymized, tags, is_blocked, avatar_storage_path, force_human),
  channel_sessions:channel_session_id (phone_number, display_name, provider)
`;

interface CursorPayload {
  sort: string | null;
  id: string;
}

function encodeCursor(p: CursorPayload): string {
  return Buffer.from(JSON.stringify(p), "utf8").toString("base64url");
}
function decodeCursor(raw: string): CursorPayload | null {
  try {
    const json = Buffer.from(raw, "base64url").toString("utf8");
    const parsed = JSON.parse(json) as CursorPayload & { last_message_at?: string | null };
    if (typeof parsed.id !== "string") return null;
    // `last_message_at` é o nome legado do campo de ordenação (cursores em voo
    // durante deploy); `sort` é o genérico atual (default OU fila).
    const sort = parsed.sort ?? parsed.last_message_at ?? null;
    return { sort, id: parsed.id };
  } catch {
    return null;
  }
}

function actorAuditPayload(actor: Actor): {
  actorUserId: string | null;
  metadataActor: Record<string, unknown>;
} {
  if (actor.type === "user") {
    return { actorUserId: actor.id, metadataActor: { actor_type: "user" } };
  }
  return {
    actorUserId: null,
    metadataActor: {
      actor_type: actor.type,
      actor_id: actor.id,
      ...(actor.type === "ai_agent" && actor.api_token_id
        ? { actor_api_token_id: actor.api_token_id }
        : {}),
    },
  };
}

// ---------------------------------------------------------------------------
// list
// ---------------------------------------------------------------------------

export interface ListConversationsResult {
  conversations: Conversation[];
  cursor: string | null;
  has_more: boolean;
}

export async function listConversationsHandler(
  supabase: SB,
  ctx: HandlerCtx,
  q: ListConversationsQuery,
): Promise<ListConversationsResult> {
  // Fila (assigned_to=unassigned): ordena por TEMPO DE ESPERA — quem espera há
  // mais tempo primeiro. `last_inbound_at` = última mensagem do cliente = "há
  // quanto tempo aguarda resposta" (não `created_at`, que pode ser uma conversa
  // antiga reaberta). Demais visões: por atividade recente (last_message_at desc).
  // A Fila deixou de se identificar por `assigned_to=unassigned` — ela agora pede
  // `comando`. Sem esta linha o `isQueue` ficaria PARA SEMPRE falso na aba Fila e
  // a ordenação por tempo de espera sumiria **sem nenhum sintoma na tela**: a
  // lista continuaria populada, só que ordenada por atividade recente, e quem
  // espera desde ontem afundaria embaixo de quem escreveu agora.
  const isQueue = q.comando?.includes("aguardando") ?? q.assigned_to === "unassigned";
  const sortCol = isQueue ? "last_inbound_at" : "last_message_at";
  const asc = isQueue;

  let query = supabase
    .from("conversations")
    .select(SELECT_COLS)
    .eq("organization_id", ctx.organization_id)
    .order(sortCol, { ascending: asc, nullsFirst: false })
    .order("id", { ascending: asc })
    .limit(q.limit + 1);

  // `.in` e não `.eq`: o filtro agora chega como LISTA (um valor vira lista de um,
  // e o SQL resultante é equivalente). É o que deixa a aba Fila pedir os dois
  // estados de espera numa consulta só, em vez de filtrar em memória o que a
  // página já truncou.
  if (q.status && q.status.length > 0) query = query.in("status", q.status);
  // O filtro de QUEM MANDA (migration 0203). Vai no banco, e não em memória, para
  // o cursor de paginação continuar valendo: filtrar depois de paginar devolveria
  // páginas curtas e um "carregar mais" que às vezes não traz nada.
  if (q.comando && q.comando.length > 0) {
    query = query.in("comando_da_conversa", q.comando);
  }
  // Depois do `status` de propósito: pedir um status terminal E `exclude_finished`
  // é contradição, e a resposta certa para uma contradição é lista vazia — não
  // um dos dois lados escolhido em silêncio.
  if (q.exclude_finished) {
    query = query.not("status", "in", `(${CONVERSATION_TERMINAL_STATUSES.join(",")})`);
  }
  if (q.channel_session_id) query = query.eq("channel_session_id", q.channel_session_id);
  if (q.tag) query = query.contains("tags", [q.tag]); // tags @> array[tag] (GIN)

  if (q.assigned_to === "me") {
    if (ctx.actor.type !== "user") {
      throw new ApiError(
        400,
        "invalid_request",
        undefined,
        ctx.requestId,
        '"assigned_to=me" requer ator humano.',
      );
    }
    query = query.eq("assigned_to_user_id", ctx.actor.id);
  } else if (q.assigned_to === "unassigned") {
    query = query.is("assigned_to_user_id", null);
  } else if (q.assigned_to) {
    query = query.eq("assigned_to_user_id", q.assigned_to);
  }

  if (q.search) {
    // ─── O TERMO NÃO PODE QUEBRAR A SINTAXE DO `.or()` ────────────────────
    //
    // Dois escapes diferentes, para dois parsers diferentes, e eles NÃO se
    // substituem:
    //
    //   `%` e `_` são curingas do `ilike` (Postgres) — escapados com `\`.
    //   `,` `(` `)` são a GRAMÁTICA do `or=` (PostgREST) — e para eles o
    //   PostgREST não oferece escape nenhum dentro de um valor sem aspas.
    //
    // Medido contra o PostgREST v14.10 do stack local deste repo, buscando um
    // contato que existe:
    //
    //   or=(display_name.ilike.*DIAG, 178*,…)   → HTTP 400 PGRST100
    //                                             "failed to parse logic tree"
    //   or=(display_name.ilike.*DIAG* 178*,…)   → 200, 3 resultados
    //
    // Ou seja: um cliente cadastrado como "Sobrenome, Nome" — que é como meia
    // agenda de CRM é digitada — DERRUBA a busca do Inbox, não devolve lista
    // vazia. E a vírgula não precisa estar no banco: basta o atendente digitá-la.
    //
    // AS DUAS SAÍDAS ÓBVIAS FORAM MEDIDAS E AS DUAS FALHAM:
    //
    //   aspas duplas no valor .... `ilike."*IAG*"` → 0 resultados contra
    //                              `ilike.*IAG*` → 3. Dentro das aspas o `*`
    //                              deixa de ser curinga; consertaria a sintaxe
    //                              e mataria a busca.
    //   barra invertida .......... `ilike.*I\,AG*` → HTTP 400. O PostgREST não
    //                              tem escape para a vírgula fora de aspas.
    //
    // O que sobra, e é o que está aqui: trocar o metacaractere pelo PRÓPRIO
    // curinga. "Silva, João" vira `*Silva* João*`, que casa "Silva, João" no
    // banco — o `%` cobre a vírgula. A busca fica ligeiramente mais larga, e
    // essa direção é a certa: o custo é achar um vizinho a mais; o custo do
    // outro lado é a tela em branco com 400.
    //
    // O controle que impede o degenerado está no teste: termo inexistente
    // continua devolvendo ZERO. Sem ele, "troque tudo por `*`" passaria.
    const s = termoSeguroParaOr(q.search);

    // ─── A BUSCA ALCANÇA O CONTATO, NÃO SÓ A ÚLTIMA MENSAGEM ──────────────
    //
    // Aqui havia só o `ilike` em `last_message_preview`. Para um atendente,
    // achar a conversa pelo NOME do cliente é o caso mais comum — bem mais que
    // lembrar um trecho literal de mensagem —, e com milhares de contatos
    // importados a única saída era rolar a lista. (issue #341)
    //
    // Dois passos, e não um `!inner` no embed do contato: transformar o embed
    // em inner mudaria a semântica da LISTA inteira (conversa sem contato
    // sumiria da caixa). A consulta curta abaixo devolve ids e o predicado os
    // soma ao casamento por conteúdo, que continua valendo.
    const somenteDigitos = s.replace(/\D/g, "");
    // 4 dígitos é o piso: "12" casaria metade da base e devolveria a lista
    // inteira embaralhada — pior que não achar, porque PARECE que funcionou.
    const pareceTelefone = somenteDigitos.length >= 4;

    const camposDoContato = [
      `display_name.ilike.*${s}*`,
      `name.ilike.*${s}*`,
      ...(pareceTelefone ? [`phone_number.ilike.*${somenteDigitos}*`] : []),
    ].join(",");

    const { data: contatos } = await supabase
      .from("contacts")
      .select("id")
      // Service role bypassa RLS: o filtro de organização é manual e obrigatório.
      .eq("organization_id", ctx.organization_id)
      // Anonimizar é direito do titular. Voltar a encontrá-lo pelo nome antigo
      // criaria um vazamento onde não havia.
      .eq("is_anonymized", false)
      .or(camposDoContato)
      // Teto obrigatório: a lista de ids viaja na URL do PostgREST, e uma busca
      // por "a" sem limite estoura a requisição.
      //
      // ⚠️ 200 ERA ACIMA DO MURO, e o comentário acima descrevia o perigo certo
      // com o número errado. Medido com o `postgrest-js` real e as `SELECT_COLS`
      // deste arquivo:
      //
      //     ids=  1 →   892 B      ids=186 →  8.098 B
      //     ids=100 → 4.753 B      ids=200 →  8.653 B   ← acima de 8.192
      //
      // Kong 2.8.1 — o gateway que a Supabase põe na frente do PostgREST, e o
      // mesmo que o stack local deste repo sobe — devolve `414 URI too long` a
      // partir de ~187 ids. E o `error` desta consulta vira `500 internal_error`
      // no handler, então o Inbox PARA: buscar "ana" ou "silva" numa base de
      // milhares de contatos devolvia a tela quebrada, não uma lista pobre.
      //
      // O teto agora é de BYTES, não de linhas, porque é byte que estoura. O
      // número de ids que cabe é consequência, e continua certo se as colunas
      // ou o formato do id mudarem.
      .limit(TETO_DE_CONTATOS_NA_BUSCA);

    const ids = idsQueCabemNaURL(
      (contatos ?? []).map((c) => (c as { id: string }).id),
    );
    if (ids.length > 0) {
      query = query.or(
        `last_message_preview.ilike.*${s}*,contact_id.in.(${ids.join(",")})`,
      );
    } else {
      // Sem ids casados, um `contact_id.in.()` vazio é SQL inválido no
      // PostgREST — a busca por conteúdo segue sozinha, como antes.
      query = query.ilike("last_message_preview", `%${s}%`);
    }
  }

  if (q.cursor) {
    const c = decodeCursor(q.cursor);
    if (!c) {
      throw new ApiError(400, "invalid_cursor", undefined, ctx.requestId, "Cursor inválido.");
    }
    const op = asc ? "gt" : "lt";
    if (c.sort) {
      query = query.or(
        `${sortCol}.${op}.${c.sort},and(${sortCol}.eq.${c.sort},id.${op}.${c.id})`,
      );
    } else {
      // Página já na região de sort NULL (nulls last): pagina só por id.
      query = query.is(sortCol, null);
      query = asc ? query.gt("id", c.id) : query.lt("id", c.id);
    }
  }

  const { data, error } = await query;
  if (error) {
    throw new ApiError(500, "internal_error", undefined, ctx.requestId, error.message);
  }

  const rows = (data ?? []) as unknown as Conversation[];
  const hasMore = rows.length > q.limit;
  const page = hasMore ? rows.slice(0, q.limit) : rows;
  const last = page[page.length - 1];
  const cursor =
    hasMore && last
      ? encodeCursor({ sort: (last[sortCol] as string | null) ?? null, id: last.id })
      : null;

  return { conversations: page, cursor, has_more: hasMore };
}

// ---------------------------------------------------------------------------
// get
// ---------------------------------------------------------------------------

export async function getConversationHandler(
  supabase: SB,
  ctx: HandlerCtx,
  conversationId: string,
): Promise<Conversation> {
  const { data, error } = await supabase
    .from("conversations")
    .select(SELECT_COLS)
    .eq("id", conversationId)
    .eq("organization_id", ctx.organization_id)
    .maybeSingle();

  if (error) {
    throw new ApiError(500, "internal_error", undefined, ctx.requestId, error.message);
  }
  if (!data) {
    throw new ApiError(404, "not_found", undefined, ctx.requestId, "Conversa não encontrada.");
  }
  return data as unknown as Conversation;
}

// ---------------------------------------------------------------------------
// update status (claim/close/release)
// ---------------------------------------------------------------------------

export async function patchConversationHandler(
  supabase: SB,
  ctx: HandlerCtx,
  conversationId: string,
  input: PatchConversationInput,
): Promise<Conversation> {
  const now = new Date().toISOString();
  const update: Record<string, unknown> = {};

  /**
   * O ATALHO `status='claimed'` PASSA PELA RPC, e não escreve o dono aqui.
   *
   * Ele gravava `assigned_to_user_id` direto na tabela, e isso deixava TRÊS
   * coisas para trás em relação ao `POST /claim`: nenhum evento em
   * `conversation_assignment_events` (a auditoria de troca de dono simplesmente
   * não existia por este caminho), `assignee_kind` intocado — o que viola a
   * constraint `conversations_assignee_kind_coherence` quando a linha já tinha
   * `assignee_kind='ai'` — e, desde a 0173, o silêncio do automático não sendo
   * ligado, produzindo uma conversa com dono humano e o robô ainda respondendo.
   *
   * É a API pública versionada, alcançável por qualquer bearer agent+: dois
   * caminhos de assumir com efeitos diferentes é o defeito, não a conveniência.
   */
  const assumirPelaRpc =
    input.status === "claimed" && ctx.actor.type === "user" ? ctx.actor.id : null;

  if (assumirPelaRpc !== null) {
    const { error: erroRpc } = await supabase.rpc("fn_conversation_assign", {
      p_organization_id: ctx.organization_id,
      p_conversation_id: conversationId,
      p_to_user_id: assumirPelaRpc,
      p_reason: "claim",
      p_expected_assignee: null,
      // Sem lock otimista: este atalho nunca teve um, e passar a exigi-lo faria
      // um cliente da API que hoje funciona começar a receber 409.
      p_enforce_expected: false,
    });
    if (erroRpc) {
      throw new ApiError(500, "internal_error", undefined, ctx.requestId, erroRpc.message);
    }
  }

  if (input.status !== undefined) {
    update.status = input.status;
    update.status_changed_at = now;
  }
  if (input.tags !== undefined) {
    update.tags = input.tags;
  }

  const { data, error } = await supabase
    .from("conversations")
    .update(update)
    .eq("id", conversationId)
    .eq("organization_id", ctx.organization_id)
    .select(SELECT_COLS)
    .maybeSingle();

  if (error) {
    throw new ApiError(500, "internal_error", undefined, ctx.requestId, error.message);
  }
  if (!data) {
    throw new ApiError(404, "not_found", undefined, ctx.requestId, "Conversa não encontrada.");
  }

  const conv = data as unknown as Conversation;

  // MESMA REGRA DO `POST /close`, senão existem dois jeitos de fechar com efeitos
  // opostos sobre a trava do automático. Condicionado a `last_handoff_at is null`
  // pelo mesmo motivo de lá: fechar encerra o EPISÓDIO, não desfaz uma escalação.
  const virouTerminal =
    input.status !== undefined &&
    (CONVERSATION_TERMINAL_STATUSES as readonly string[]).includes(input.status);
  if (virouTerminal) {
    await supabase
      .from("conversations")
      .update({ bot_silenced_until: null })
      .eq("id", conversationId)
      .eq("organization_id", ctx.organization_id)
      .is("last_handoff_at", null);
  }
  const a = actorAuditPayload(ctx.actor);

  if (input.status !== undefined) {
    const action =
      input.status === "claimed"
        ? "conversation.claimed"
        : input.status === "closed"
          ? "conversation.closed"
          : "conversation.released";
    await audit({
      action,
      actorUserId: a.actorUserId,
      organizationId: conv.organization_id,
      resourceType: "conversation",
      resourceId: conv.id,
      requestId: ctx.requestId,
      metadata: { ...a.metadataActor, status: input.status },
    });
  }
  if (input.tags !== undefined) {
    await audit({
      action: "conversation.tags_changed",
      actorUserId: a.actorUserId,
      organizationId: conv.organization_id,
      resourceType: "conversation",
      resourceId: conv.id,
      requestId: ctx.requestId,
      metadata: { ...a.metadataActor, tags: input.tags },
    });
  }

  return conv;
}

// ---------------------------------------------------------------------------
// mark read
// ---------------------------------------------------------------------------

export async function markConversationReadHandler(
  supabase: SB,
  ctx: HandlerCtx,
  conversationId: string,
): Promise<Conversation> {
  const { data, error } = await supabase
    .from("conversations")
    .update({ unread_count_for_assignee: 0 })
    .eq("id", conversationId)
    .eq("organization_id", ctx.organization_id)
    .select(SELECT_COLS)
    .maybeSingle();

  if (error) {
    throw new ApiError(500, "internal_error", undefined, ctx.requestId, error.message);
  }
  if (!data) {
    throw new ApiError(404, "not_found", undefined, ctx.requestId, "Conversa não encontrada.");
  }
  return data as unknown as Conversation;
}
