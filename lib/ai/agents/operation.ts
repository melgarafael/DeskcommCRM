import type { Queryable } from "@/lib/agent-engine/queue/queue";
import type { SupabaseClient } from "@supabase/supabase-js";
import { StaleServiceBoundaryError } from "@/lib/atendimento/fronteira";
export interface AgentOperationContext {
  organizationId: string;
  agentId: string;
  versionId: string;
  revision: string;
}
export function mesmaOperacao(
  a: AgentOperationContext | null | undefined,
  b: AgentOperationContext | null | undefined,
): boolean {
  return (
    !!a &&
    !!b &&
    a.organizationId === b.organizationId &&
    a.agentId === b.agentId &&
    a.versionId === b.versionId &&
    a.revision === b.revision
  );
}
function assert(
  row:
    | {
        published_version_id: string | null;
        operation_revision: number | string;
        operation_mode: string;
        paused_at: string | null;
        archived_at: string | null;
      }
    | undefined
    | null,
  c: AgentOperationContext,
) {
  if (
    !row ||
    row.published_version_id !== c.versionId ||
    String(row.operation_revision) !== c.revision ||
    row.operation_mode !== "automatic" ||
    row.paused_at ||
    row.archived_at
  )
    throw new StaleServiceBoundaryError();
}
export async function assertAgentOperationPg(db: Queryable, c: AgentOperationContext) {
  const { rows } = await db.query<NonNullable<Parameters<typeof assert>[0]>>(
    "select published_version_id,operation_revision::text,operation_mode,paused_at,archived_at from ai_agents where organization_id=$1 and id=$2",
    [c.organizationId, c.agentId],
  );
  assert(rows[0], c);
}
/**
 * As colunas que `trg_reply_agent_revision` conta para somar `operation_revision`,
 * MENOS `paused_at`. Pausar e despausar soma 2 sem mudar a operação; esta
 * impressão separa esse caso de uma mudança real. Coluna nova no trigger entra
 * aqui também (vigiado em tests/invariants/catalogo-operacao-persistida-real).
 */
export const COLUNAS_DA_OPERACAO_SEM_PAUSA = [
  "operation_mode",
  "published_version_id",
  "archived_at",
  "config",
  "active_kb_version_id",
] as const;
const IMPRESSAO_SEM_PAUSA_SQL = `md5(row(${COLUNAS_DA_OPERACAO_SEM_PAUSA.map((c) => `a.${c}`).join(",")})::text)`;

/** `assertAgentOperationPg` + a impressão da operação, na MESMA leitura. */
export async function assertAgentOperationComImpressaoPg(db: Queryable, c: AgentOperationContext): Promise<string> {
  const { rows } = await db.query<NonNullable<Parameters<typeof assert>[0]> & { impressao: string }>(
    `select a.published_version_id,a.operation_revision::text,a.operation_mode,a.paused_at,a.archived_at,
            ${IMPRESSAO_SEM_PAUSA_SQL} as impressao
       from ai_agents a where a.organization_id=$1 and a.id=$2`,
    [c.organizationId, c.agentId],
  );
  assert(rows[0], c);
  return rows[0]!.impressao;
}

/**
 * Para retomar um plano congelado depois de uma pausa: devolve `c` com a revisão
 * vigente SÓ quando o agente está despausado e nada além de `paused_at` mudou
 * desde a `impressao` gravada. Em qualquer outro caso devolve `c` intacta, e a
 * conferência seguinte a recusa como sempre. Não muda `operation_revision` para
 * nenhum outro consumidor.
 */
export async function operacaoDepoisDaPausa(
  db: Queryable,
  c: AgentOperationContext,
  impressao: string | undefined,
): Promise<AgentOperationContext> {
  if (!impressao) return c;
  const { rows } = await db.query<{ revision: string; paused_at: string | null; impressao: string }>(
    `select a.operation_revision::text as revision,a.paused_at,${IMPRESSAO_SEM_PAUSA_SQL} as impressao
       from ai_agents a where a.organization_id=$1 and a.id=$2`,
    [c.organizationId, c.agentId],
  );
  const r = rows[0];
  if (!r || r.revision === c.revision || r.paused_at || r.impressao !== impressao) return c;
  return { ...c, revision: r.revision };
}
export async function assertAgentOperationSupabase(db: SupabaseClient, c: AgentOperationContext) {
  const { data, error } = await db
    .from("ai_agents")
    .select("published_version_id,operation_revision,operation_mode,paused_at,archived_at")
    .eq("organization_id", c.organizationId)
    .eq("id", c.agentId)
    .maybeSingle();
  if (error) throw error;
  assert(data, c);
}
