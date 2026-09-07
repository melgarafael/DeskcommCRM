/**
 * GET /api/v1/ai/agents/:id/runs (manager+) — as execuções DESTE agente.
 *
 * ## Por que esta rota mudou de tabela
 *
 * Ela lia `ai_agent_runs`, e a aba "Execuções" da tela do agente dizia
 * **"Nenhuma execução ainda"** enquanto o agente respondia no WhatsApp. Medido
 * na VPS de produção em 2026-08-30: `ai_agent_runs` com **0 linhas**, e
 * `llm_calls` com **130** de `purpose='agent_turn'` na mesma organização, a
 * última do próprio dia.
 *
 * `ai_agent_runs` só tem dois escritores no repo, e nenhum é o motor de
 * produção: o dispatcher legado (`lib/ai/dispatcher/index.ts`, sem chamador — o
 * cron `app/api/v1/cron/agent-dispatcher` devolve `{ skipped: true,
 * deprecated: true }`) e o runner legado. O motor que responde de verdade é o
 * `lib/agent-engine`, e ele registra em `llm_calls`.
 *
 * Uma tela que promete um registro que motor nenhum escreve é pior que uma tela
 * ausente: ela responde "não aconteceu nada" a quem está investigando
 * justamente por que nada aconteceu.
 *
 * ## O que muda para quem lê
 *
 * O SHAPE de saída é o mesmo (`AgentRunRow`) — a tabela, o drawer e o hook não
 * mudam. O que muda é a fonte, e com ela três campos que `llm_calls` não tem:
 * `agent_version_id`, `steps_count` e `tool_calls` saem `null`. Preferi `null`
 * a inventar: `null` a tela já sabe desenhar ("—"), e um zero fabricado em
 * "Steps" afirmaria que o turno não usou ferramenta nenhuma.
 *
 * ## O corte histórico, dito por escrito
 *
 * `llm_calls.agent_id` existia com FK e **nunca era escrita** (0 de 130 linhas
 * medidas). O conserto está em `lib/agent-engine/edge/llm/run-model-call.ts`,
 * e ele só vale dali para a frente: execuções anteriores ao deploy ficam com
 * `agent_id` nulo e **não aparecem aqui**. Não há como backfillar com
 * honestidade — o agente do turno não é derivável do que ficou gravado. Quem
 * precisa do histórico completo da organização usa `/app/ai/runs`, que lista
 * `llm_calls` sem filtrar por agente.
 *
 * Cursor pagination opaco base64 (created_at + id), como as demais rotas.
 * Filtro opcional ?status=.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";

import { ok, fail } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { createClient } from "@/lib/supabase/server";
import { runsListQuerySchema } from "@/lib/ai/agents/validation";
import { traduzir } from "@/lib/i18n/dicionario";

export const dynamic = "force-dynamic";

const UUID_RX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const CALL_COLUMNS =
  "id, organization_id, agent_id, contact_id, purpose, status, error_code, error_message, " +
  "input_tokens, output_tokens, cost_cents, latency_ms, created_at";

/**
 * O vocabulário de `llm_calls.status` ('ok' | 'erro') traduzido para o que a
 * tela desenha (`STATUS_VARIANT` em RunsTable: pending/running/completed/failed).
 * Sem esta tradução o badge cairia no `?? "outline"` e mostraria a palavra crua
 * do banco para o usuário.
 */
const STATUS_DO_BANCO_PARA_A_TELA: Record<string, string> = {
  ok: "completed",
  erro: "failed",
};
/** A tradução inversa, para o filtro `?status=` continuar valendo. */
const STATUS_DA_TELA_PARA_O_BANCO: Record<string, string> = {
  completed: "ok",
  failed: "erro",
};

interface LlmCallRow {
  id: string;
  organization_id: string;
  agent_id: string | null;
  contact_id: string | null;
  purpose: string | null;
  status: string | null;
  error_code: string | null;
  error_message: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cost_cents: number | null;
  latency_ms: number | null;
  created_at: string;
}

/**
 * `llm_calls` → o shape que a tela já consome. Exportada para o teste medir o
 * mapeamento sem precisar de banco (`tests/unit/aba-de-execucoes-le-o-motor-vivo`).
 */
export function paraLinhaDeExecucao(c: LlmCallRow): Record<string, unknown> {
  return {
    id: c.id,
    organization_id: c.organization_id,
    agent_id: c.agent_id,
    // `llm_calls` não guarda a VERSÃO do agente. Null e não "" — a tela
    // distingue ausência de vazio, e "" seria afirmar uma versão sem nome.
    agent_version_id: null,
    conversation_id: null,
    contact_id: c.contact_id,
    channel_session_id: null,
    inbound_message_id: null,
    outbound_message_id: null,
    status: STATUS_DO_BANCO_PARA_A_TELA[c.status ?? ""] ?? (c.status ?? "completed"),
    abort_reason: null,
    error_code: c.error_code,
    error_message: c.error_message,
    tokens_in: c.input_tokens,
    tokens_out: c.output_tokens,
    cost_cents: c.cost_cents,
    latency_ms: c.latency_ms,
    // Nenhum dos três existe em `llm_calls`. Ver o cabeçalho: null é honesto,
    // zero seria uma afirmação falsa sobre o turno.
    steps_count: null,
    tool_calls: null,
    is_dry_run: false,
    started_at: c.created_at,
    completed_at: c.created_at,
    created_at: c.created_at,
  };
}

type Ctx = { params: Promise<{ id: string }> };

interface CursorPayload {
  started_at: string;
  id: string;
}

function encodeCursor(p: CursorPayload): string {
  return Buffer.from(JSON.stringify(p), "utf8").toString("base64url");
}

function decodeCursor(raw: string): CursorPayload | null {
  try {
    const json = Buffer.from(raw, "base64url").toString("utf8");
    const p = JSON.parse(json) as CursorPayload;
    if (typeof p.id !== "string" || typeof p.started_at !== "string") return null;
    return p;
  } catch {
    return null;
  }
}

export async function GET(req: NextRequest, ctx: Ctx): Promise<Response> {
  const requestId = randomUUID();
  const { id } = await ctx.params;
  if (!UUID_RX.test(id)) return fail("invalid_request", "id inválido.", 400, { requestId });

  const authz = await requireRole("manager", { requestId, resource: "ai_agents" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const { org: activeOrg } = authz;

  const sp = req.nextUrl.searchParams;
  const parsed = runsListQuerySchema.safeParse({
    cursor: sp.get("cursor") ?? undefined,
    limit: sp.get("limit") ?? undefined,
    status: sp.get("status") ?? undefined,
  });
  if (!parsed.success) {
    return fail("validation_failed", t("Query inválida."), 422, {
      requestId,
      details: parsed.error.flatten(),
    });
  }
  const q = parsed.data;

  const supabase = await createClient();
  let query = supabase
    .from("llm_calls")
    .select(CALL_COLUMNS)
    // `organization_id` explícito mesmo com RLS: é a convenção do repo e o que
    // sobrevive a alguém trocar o client por um admin um dia.
    .eq("organization_id", activeOrg.orgId)
    .eq("agent_id", id)
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(q.limit + 1);

  if (q.status) {
    query = query.eq("status", STATUS_DA_TELA_PARA_O_BANCO[q.status] ?? q.status);
  }

  if (q.cursor) {
    const c = decodeCursor(q.cursor);
    if (!c) return fail("invalid_request", t("cursor inválido."), 400, { requestId });
    // Tuple-aware seek: created_at < c.started_at OR (=, id < c.id).
    query = query.or(
      `created_at.lt.${c.started_at},and(created_at.eq.${c.started_at},id.lt.${c.id})`,
    );
  }

  const { data, error } = await query;
  if (error) return fail("internal_error", t("Erro ao listar execuções."), 500, { requestId });

  const rows = ((data ?? []) as unknown as LlmCallRow[]).map(paraLinhaDeExecucao);
  const hasMore = rows.length > q.limit;
  const slice = hasMore ? rows.slice(0, q.limit) : rows;
  const last = slice[slice.length - 1];
  const nextCursor =
    hasMore && last
      ? encodeCursor({ started_at: last.started_at as string, id: last.id as string })
      : null;

  return ok(slice, {
    requestId,
    meta: { cursor: nextCursor, has_more: hasMore },
  });
}
