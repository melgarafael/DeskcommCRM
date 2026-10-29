import type { Database, Json } from "@/lib/database.types";
import { ApiErrorCodes } from "@/lib/api/errors";
import { VALID_TOOL_IDS } from "@/lib/mcp/tools/catalog";
import { scrubMessage } from "@/lib/sentry/scrub";

export const LIMITE_MAXIMO = 200;

/** Literal para o PostgREST inferir a projeção sem cast de tabela desconhecida. */
export const COLUNAS_DO_TRACO =
  "id, job_id, preview_run_id, conversation_id, contact_id, agent_id, agent_version_id, is_dry_run, status, abort_reason, error_code, provider, model, messages_sent, historico_mensagens, tokens_in, tokens_out, cost_cents, latency_ms, skills, ferramentas, ferramentas_truncadas, kb_sources, created_at";

type LinhaDoTraco = Omit<
  Database["public"]["Tables"]["agent_turn_traces"]["Row"],
  "organization_id" | "updated_at" | "error_message"
>;
type Registro = { [key: string]: Json | undefined };

const CODIGOS = new Set<string>([
  ...Object.values(ApiErrorCodes),
  "erro",
  "Error",
  "TypeError",
  "RangeError",
  "SyntaxError",
  "ReferenceError",
  "URIError",
  "EvalError",
  "AggregateError",
  "AbortError",
  "TimeoutError",
  /**
   * O turno ABORTADO grava o `name` do erro que o interrompeu
   * (`lib/agent-engine/agent/inbound-turn.ts`, o `catch` que marca `status =
   * 'aborted'`, e `JobSettledError.name`). Sem este literal, o recibo de TODO
   * turno adiado — cap de envio, janela horária, veto de before-send, handoff —
   * saía como `internal_error`: o leitor apagava justamente a resposta de "por
   * que este turno não falou", que é a pergunta da issue #2869. É literal
   * fechado, não texto livre: continua valendo a regra de que o banco não dita
   * o vocabulário do recibo.
   */
  "job_settled",
  "JobSettledError",
]);
const MOTIVOS_DE_ABORTO = new Set([
  "handoff_tool",
  "token_budget_exceeded",
  "cost_budget_exceeded",
  "max_steps_reached",
  "sentinel:requested_human",
]);
// Nomes nativos de AGENT_TOOL_DEFS; MCP vem do catálogo canônico sem handlers.
// Nome externo/desconhecido não é texto livre que este leitor possa devolver.
const FERRAMENTAS = new Set([
  ...VALID_TOOL_IDS,
  "get_lead_context",
  "send_message",
  "update_lead_state",
  "schedule_followup",
  "save_lead_note",
  "get_lead_note",
  "search_knowledge",
  "request_human_handoff",
  "read_skill_reference",
  "open_human_case",
  "provide_case_update",
  "send_template",
]);
const ESTADOS = new Set(["ok", "falhou", "bloqueada"]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function registros(valor: Json): Registro[] {
  return Array.isArray(valor)
    ? valor.filter(
        (item): item is Registro =>
          item !== null && typeof item === "object" && !Array.isArray(item),
      )
    : [];
}

function codigo(valor: unknown): string | null {
  return valor === null || valor === undefined || valor === ""
    ? null
    : typeof valor === "string" && CODIGOS.has(valor)
      ? valor
      : "internal_error";
}

function numero(valor: unknown): number | null {
  return typeof valor === "number" && Number.isFinite(valor) ? valor : null;
}

function uuid(valor: unknown): string | null {
  return typeof valor === "string" && UUID.test(valor) ? valor : null;
}

/** Identificadores configurados não são mensagens; rejeita prosa, PII e chaves. */
function identificador(valor: unknown): string | null {
  if (typeof valor !== "string" || !/^[a-z0-9][a-z0-9._:/-]{0,149}$/i.test(valor)) return null;
  if (/^(?:sk-|AIza|apikey_|github_pat_|gh[pousr]_)/i.test(valor)) return null;
  return scrubMessage(valor) === valor ? valor : null;
}

/** Projeta cada campo: nem o objeto da linha nem seus JSONs são espalhados. */
export function reciboDoTraco(linha: LinhaDoTraco) {
  return {
    id: linha.id,
    job_id: linha.job_id,
    preview_run_id: identificador(linha.preview_run_id),
    conversation_id: linha.conversation_id,
    contact_id: linha.contact_id,
    agent_id: linha.agent_id,
    agent_version_id: linha.agent_version_id,
    is_dry_run: linha.is_dry_run,
    status: linha.status,
    abort_reason:
      linha.abort_reason !== null && MOTIVOS_DE_ABORTO.has(linha.abort_reason)
        ? linha.abort_reason
        : null,
    error_code: codigo(linha.error_code),
    provider: identificador(linha.provider),
    model: identificador(linha.model),
    messages_sent: numero(linha.messages_sent),
    historico_mensagens: numero(linha.historico_mensagens),
    tokens_in: numero(linha.tokens_in),
    tokens_out: numero(linha.tokens_out),
    cost_cents: numero(linha.cost_cents),
    latency_ms: numero(linha.latency_ms),
    skills: registros(linha.skills).map((skill) => ({ versao_id: uuid(skill.versao_id) })),
    ferramentas: registros(linha.ferramentas).map((ferramenta) => ({
      nome:
        typeof ferramenta.nome === "string" && FERRAMENTAS.has(ferramenta.nome)
          ? ferramenta.nome
          : null,
      estado:
        typeof ferramenta.estado === "string" && ESTADOS.has(ferramenta.estado)
          ? ferramenta.estado
          : null,
      erro: codigo(ferramenta.erro),
      duracao_ms: numero(ferramenta.duracao_ms),
    })),
    ferramentas_truncadas: linha.ferramentas_truncadas,
    kb_sources: registros(linha.kb_sources).map((fonte) => ({
      id: uuid(fonte.id),
      versao: uuid(fonte.versao),
      hash:
        typeof fonte.hash === "string" && /^[0-9a-f]{64}$/i.test(fonte.hash) ? fonte.hash : null,
      ligada: typeof fonte.ligada === "boolean" ? fonte.ligada : null,
    })),
    created_at: linha.created_at,
  };
}
