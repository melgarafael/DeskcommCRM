import { type NextRequest } from "next/server";
import { requirePlatformAdmin } from "@/lib/auth/requirePlatformAdmin";
import { createAdminClient } from "@/lib/supabase/admin";
import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import {
  normalizarModoDeOrcamento,
  type ModoDeOrcamento,
} from "@/lib/agent-engine/edge/llm/orcamento";
import { logger } from "@/lib/logger";
import { randomUUID } from "node:crypto";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type HealthStatus = "ok" | "warning" | "critical";

export interface WahaSession {
  id: string;
  waha_session_name: string | null;
  status: string | null;
  last_status_change_at: string | null;
  updated_at: string | null;
}

export interface TenantHealthResponse {
  waha: {
    sessions: WahaSession[];
    overall_status: HealthStatus;
  };
  ai: {
    /** Centavo de DÓLAR — `llm_calls.cost_cents` vem de `pricing.ts`, em USD. */
    consumed_cents: number;
    budget_cents: number | null;
    percent_used: number | null;
    /**
     * O teto vincula esta organização? `off` = não — o número acima é
     * informação, não limite. Sem isto a tela do operador mostrava "100% do
     * orçamento" para quem nunca ligou proteção nenhuma.
     */
    enforcement_mode: ModoDeOrcamento;
    status: HealthStatus;
  };
  audit: {
    last_at: string | null;
    lag_seconds: number | null;
    status: HealthStatus;
  };
}

// ---------------------------------------------------------------------------
// Status computation
// ---------------------------------------------------------------------------

function wahaOverallStatus(sessions: WahaSession[]): HealthStatus {
  if (sessions.length === 0) return "warning";
  // `channel_sessions_status_check` só admite STARTING/SCAN_QR_CODE/WORKING/
  // STOPPED/FAILED. Comparar com "CONNECTED" (que não existe) era um ramo morto.
  const hasWorking = sessions.some((s) => s.status === "WORKING");
  const hasFailed = sessions.some(
    (s) => s.status === "FAILED" || s.status === "STOPPED",
  );
  if (hasFailed && !hasWorking) return "critical";
  if (!hasWorking) return "warning";
  return "ok";
}

/**
 * A saúde do gasto de IA depende do MODO, não só do percentual.
 *
 * `enforcement_mode = 'off'` significa que o teto desta organização não é
 * aplicado por ninguém: passar de 100% dele não para nada, não capa atendimento
 * e não é incidente — é só um número maior que outro número. Pintar isso de
 * `critical` treinaria o operador a ignorar a cor exatamente onde ela precisa
 * ser crível. Os valores continuam visíveis na tela; o que muda é o alarme.
 */
function aiOverallStatus(
  percentUsed: number | null,
  modo: ModoDeOrcamento,
): HealthStatus {
  if (percentUsed === null || modo === "off") return "ok";
  // Só quem escolheu PARAR chega a `critical`: em `avisar`, cruzar o teto custa
  // dinheiro mas não interrompe atendimento nenhum.
  if (percentUsed >= 100) return modo === "bloquear" ? "critical" : "warning";
  if (percentUsed >= 80) return "warning";
  return "ok";
}

function auditOverallStatus(lagSeconds: number | null): HealthStatus {
  if (lagSeconds === null) return "warning";
  if (lagSeconds > 600) return "critical"; // > 10 min
  if (lagSeconds > 120) return "warning";  // > 2 min
  return "ok";
}

// ---------------------------------------------------------------------------
// GET /api/v1/admin/tenants/[id]/health
// ---------------------------------------------------------------------------

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const requestId = randomUUID();
  const { id } = await params;

  let adminCtx: Awaited<ReturnType<typeof requirePlatformAdmin>>;
  try {
    adminCtx = await requirePlatformAdmin();
  } catch {
    return fail("forbidden", "Platform admin required", 403, { requestId });
  }

  const admin = createAdminClient();

  // 4 parallel queries — service-role, intentional cross-tenant reads.
  // organization_id is resolved from path (trusted), never from body.
  const [wahaRes, aiRes, gastoRes, auditRes] = await Promise.all([
    admin
      .from("channel_sessions")
      // `last_qr_at` não existe em channel_sessions; o equivalente real é
      // `last_status_change_at` (quando a sessão mudou de estado pela última
      // vez — inclusive ao entrar em SCAN_QR_CODE).
      .select("id, waha_session_name, status, last_status_change_at, updated_at")
      .eq("organization_id", id),

    admin
      .from("ai_budgets")
      .select("current_month_consumed_cents, monthly_limit_cents, enforcement_mode")
      .eq("organization_id", id),

    // A régua ÚNICA de gasto (migration 0159) — a MESMA que o gate consulta
    // antes de recusar uma chamada. A coluna materializada continua sendo lida
    // logo abaixo, mas só como rede: ela soma `NEW.cost_cents` sem olhar a data
    // e nunca zera, então numa instalação que não atualiza há meses ela mostra
    // gasto acumulado sob o rótulo "do mês".
    admin.rpc("fn_gasto_de_ia_do_mes", { p_org: id }),

    admin
      .from("api_audit_log")
      .select("created_at")
      .eq("organization_id", id)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
  ]);

  // --- WAHA ---
  const sessions = (wahaRes.data ?? []) as WahaSession[];
  const wahaStatus = wahaOverallStatus(sessions);

  // --- AI Budget ---
  type AiBudgetRow = {
    current_month_consumed_cents: number | null;
    monthly_limit_cents: number | null;
    enforcement_mode: string | null;
  };
  const aiRows = (aiRes.data ?? []) as AiBudgetRow[];
  const gastoDaRegua = gastoRes.error ? null : Number(gastoRes.data ?? 0);
  if (gastoRes.error) {
    logger.warn("admin-health: gasto de IA veio da coluna materializada, não da régua", {
      organization_id: id,
      request_id: requestId,
      causa: gastoRes.error.message,
    });
  }
  const consumedCents =
    gastoDaRegua !== null && Number.isFinite(gastoDaRegua)
      ? gastoDaRegua
      : aiRows.reduce((acc, r) => acc + (r.current_month_consumed_cents ?? 0), 0);
  const firstAiRow = aiRows[0];
  const budgetCents = firstAiRow ? (firstAiRow.monthly_limit_cents ?? null) : null;
  const enforcementMode = normalizarModoDeOrcamento(firstAiRow?.enforcement_mode ?? null);
  const percentUsed =
    budgetCents && budgetCents > 0
      ? Math.round((consumedCents / budgetCents) * 100)
      : null;
  const aiStatus = aiOverallStatus(percentUsed, enforcementMode);

  // --- Audit lag ---
  const lastAuditAt = auditRes.data?.created_at ?? null;
  const lagSeconds = lastAuditAt
    ? Math.round((Date.now() - new Date(lastAuditAt).getTime()) / 1000)
    : null;
  const auditStatus = auditOverallStatus(lagSeconds);

  const health: TenantHealthResponse = {
    waha: { sessions, overall_status: wahaStatus },
    ai: {
      consumed_cents: consumedCents,
      budget_cents: budgetCents,
      percent_used: percentUsed,
      enforcement_mode: enforcementMode,
      status: aiStatus,
    },
    audit: {
      last_at: lastAuditAt,
      lag_seconds: lagSeconds,
      status: auditStatus,
    },
  };

  // Audit lightweight — fire-and-forget
  void audit({
    action: "platform_admin.tenant_health_viewed",
    actorUserId: adminCtx.user.id,
    actingAsPlatformAdmin: true,
    bypassedRls: true,
    organizationId: id,
    resourceType: "organization",
    resourceId: id,
    requestId,
  });

  return ok(health, { requestId });
}
