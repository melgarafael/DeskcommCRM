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
 * produção: a prévia `versions/[vid]/test` (o único vivo, só com
 * `is_dry_run=true`) e o runner legado (`runAgent`, em
 * `lib/ai/runtime/agent.ts`), sem chamador desde que perdeu a rota interna e o
 * dispatcher — o cron `app/api/v1/cron/agent-dispatcher` devolve
 * `{ skipped: true, deprecated: true }`. O motor que responde de verdade é o
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
import { logger } from "@/lib/logger";
import { createClient } from "@/lib/supabase/server";
import { runsListQuerySchema } from "@/lib/ai/agents/validation";
import { traduzir } from "@/lib/i18n/dicionario";

export const dynamic = "force-dynamic";

const UUID_RX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const CALL_COLUMNS =
  "id, organization_id, agent_id, contact_id, purpose, status, error_code, error_message, " +
  "input_tokens, output_tokens, cost_cents, latency_ms, created_at, preview_run_id";

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
  /**
   * O run de prévia que causou esta chamada (#4426) — `null` em toda execução
   * real. É por ele que a linha do teste encontra a pergunta e a resposta.
   */
  preview_run_id: string | null;
}

/** O texto que o run de PRÉVIA guarda (#4426): a pergunta e a resposta do teste. */
export interface TextoDoTeste {
  input_text: string | null;
  output_text: string | null;
}

type ClienteDeSessao = Awaited<ReturnType<typeof createClient>>;

/**
 * Busca, para as linhas de TESTE desta página, o texto gravado no run de prévia.
 *
 * ─── Por que uma segunda consulta, e por que por `id` ──────────────────────
 *
 * A aba lê `llm_calls` — é o motor que responde de verdade —, e o texto mora em
 * `ai_agent_runs` (o único escritor vivo dela é a prévia). O elo é
 * `llm_calls.preview_run_id`, então a busca é `in (ids)` sobre a PK: UMA
 * consulta por página, indexada, e não um `select` por linha.
 *
 * Filtrar por organização aqui seria o reflexo errado: `id` já é único, o valor
 * veio de uma linha que a RLS do chamador liberou, e a policy de
 * `ai_agent_runs` decide o resto. Um filtro por organização A MAIS não protegeria
 * nada e daria a impressão de que a proteção mora nesta consulta.
 *
 * Falhar aqui NÃO derruba a lista: a aba continua com custo, tokens e status, e
 * a linha do teste volta sem texto — o estado de antes do conserto. O aviso vai
 * para o log, porque um texto que some em silêncio é o defeito que esta issue
 * descreve.
 */
async function textosDoTeste(
  supabase: ClienteDeSessao,
  chamadas: readonly LlmCallRow[],
  requestId: string,
): Promise<Map<string, TextoDoTeste>> {
  const mapa = new Map<string, TextoDoTeste>();
  const ids = Array.from(
    new Set(
      chamadas
        .filter((c) => c.purpose === "agent_preview" && c.contact_id === null)
        .map((c) => c.preview_run_id)
        .filter((id): id is string => typeof id === "string" && id !== ""),
    ),
  );
  if (ids.length === 0) return mapa;

  const { data, error } = await supabase
    .from("ai_agent_runs")
    .select("id, input_text, output_text")
    .in("id", ids);

  if (error) {
    logger.warn("[ai.runs] texto do teste não lido (a lista segue sem ele)", {
      request_id: requestId,
      runs: ids.length,
      error: error.message,
    });
    return mapa;
  }

  for (const linha of (data ?? []) as Array<{ id: string } & TextoDoTeste>) {
    mapa.set(linha.id, { input_text: linha.input_text, output_text: linha.output_text });
  }
  return mapa;
}

/**
 * `llm_calls` → o shape que a tela já consome. Exportada para o teste medir o
 * mapeamento sem precisar de banco (`tests/unit/aba-de-execucoes-le-o-motor-vivo`).
 */
export function paraLinhaDeExecucao(
  c: LlmCallRow,
  texto: TextoDoTeste | null = null,
): Record<string, unknown> {
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
    // `agent_preview` NÃO quer dizer teste: o rascunho do modo assistido
    // (`reply-drafts.ts`, `kind: "assisted"`) grava o mesmo purpose sobre conversa
    // real com contato real. O que separa o ensaio é o contato: o sandbox roda com
    // `contactId: null` (`TurnPreview.contactId` — "null means a scenario"), e é
    // isso que chega a `llm_calls.contact_id`. Versão e run do teste não estão em
    // `llm_calls`.
    is_dry_run: c.purpose === "agent_preview" && c.contact_id === null,
    // #4426: o texto do teste, quando a linha é de teste. `null` em toda
    // execução real — e não `""`, que a tela desenharia como caixa vazia.
    input_text: texto?.input_text ?? null,
    output_text: texto?.output_text ?? null,
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

  const chamadas = (data ?? []) as unknown as LlmCallRow[];
  // #4426: as linhas de TESTE levam a pergunta e a resposta; as reais ficam sem
  // texto (o mapa só tem as prévias desta página).
  const textos = await textosDoTeste(supabase, chamadas, requestId);
  const rows = chamadas.map((c) =>
    paraLinhaDeExecucao(c, (c.preview_run_id && textos.get(c.preview_run_id)) || null),
  );
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
