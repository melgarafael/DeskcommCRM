import { type NextRequest } from "next/server";
import { normalizarModoDeOrcamento } from "@/lib/agent-engine/edge/llm/orcamento";
import { requirePlatformAdmin } from "@/lib/auth/requirePlatformAdmin";
import { createAdminClient } from "@/lib/supabase/admin";
import { ok, fail } from "@/lib/api/wrappers";

export type AlertSeverity = "critical" | "warning" | "info";
export type AlertKind =
  | "waha_ban"
  | "lgpd_at_risk"
  | "ai_budget"
  | "tenant_pending_overflow";

export interface AlertItem {
  id: string;
  severity: AlertSeverity;
  kind: AlertKind;
  tenant_id: string;
  tenant_name: string;
  message: string;
  link: string;
  created_at: string;
}

export interface DashboardKPIs {
  tenants_active: number;
  conv_pending_10min: number;
  waha_ban_alerts: number;
  lgpd_at_risk: number;
  ai_budget_warnings: number;
  alerts: AlertItem[];
}

// GET /api/v1/admin/dashboard/kpis
// Requires platform admin gate (MFA-enforced).
// Uses service-role client intentionally — cross-tenant read for super-admin.
export async function GET(_req: NextRequest) {
  try {
    await requirePlatformAdmin();
  } catch {
    // requirePlatformAdmin redirects; if it throws, it's unexpected
    return fail("forbidden", "Platform admin required", 403);
  }

  const admin = createAdminClient();

  // ── KPI counts in parallel ────────────────────────────────────────────────
  const [
    tenantsRes,
    convPendingRes,
    wahaBanRes,
    lgpdRiskRes,
  ] = await Promise.all([
    admin
      .from("organizations")
      .select("*", { count: "exact", head: true })
      .eq("status", "active"),

    admin
      .from("conversations")
      .select("*", { count: "exact", head: true })
      .eq("status", "pending")
      .lt("last_inbound_at", new Date(Date.now() - 10 * 60 * 1000).toISOString()),

    admin
      .from("channel_sessions")
      .select("*", { count: "exact", head: true })
      .or(
        `status.in.(ban_suspected,disconnected_unexpected),and(status.eq.disconnected,updated_at.gt.${new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()})`,
      ),

    admin
      .from("lgpd_requests")
      .select("*", { count: "exact", head: true })
      .not("status", "in", "(completed,failed)")
      .lt("due_at", new Date(Date.now() + 5 * 24 * 60 * 60 * 1000).toISOString()),
  ]);

  // O KPI de orçamento saiu daqui e passou a ser contado a partir das MESMAS
  // linhas que alimentam os alertas, mais abaixo. O que havia antes: um
  // `admin.rpc("fn_admin_ai_budget_warning_count")` para uma função que NÃO
  // EXISTE (grep global: um hit, a própria chamada). O `error` era descartado,
  // `data` vinha `null`, `typeof null === "object"` caía no fallback — e o
  // fallback era um `count` de `ai_budgets` com `.gte("current_month_consumed_cents", 0)`,
  // filtro sempre verdadeiro porque a coluna é `numeric NOT NULL DEFAULT 0`.
  // O cartão renderizava O TOTAL DE ORGANIZAÇÕES sob o subtítulo "tenants com
  // uso ≥80%", e ninguém tinha como perceber: o número era plausível.

  // ── Alerts: top 20, union from 4 sources ─────────────────────────────────
  const cutoff24h = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const cutoff5d = new Date(Date.now() + 5 * 24 * 60 * 60 * 1000).toISOString();

  const [
    wahaAlertsRes,
    lgpdAlertsRes,
    aiBudgetAlertsRes,
    overflowAlertsRes,
  ] = await Promise.all([
    // WAHA ban alerts with org name
    admin
      .from("channel_sessions")
      .select(`
        id,
        status,
        status_reason,
        organization_id,
        updated_at,
        organizations!inner(display_name)
      `)
      .or(
        `status.in.(ban_suspected,disconnected_unexpected),and(status.eq.disconnected,updated_at.gt.${cutoff24h})`,
      )
      .order("updated_at", { ascending: false })
      .limit(20),

    // LGPD at risk with org name
    admin
      .from("lgpd_requests")
      .select(`
        id,
        status,
        due_at,
        organization_id,
        created_at,
        organizations!inner(display_name)
      `)
      .not("status", "in", "(completed,failed)")
      .lt("due_at", cutoff5d)
      .order("due_at", { ascending: true })
      .limit(20),

    // Orçamentos de IA — UMA leitura serve o KPI e os alertas.
    //
    // Sem `order("updated_at")`: aquela coluna é reescrita pelo gatilho de
    // consumo a cada linha de `llm_calls` e por todo backfill do baseline, ou
    // seja, é o carimbo da última chamada de IA — não do orçamento ter mudado
    // nem de ele ter cruzado o limiar. Ordenar por ela trazia "quem usou IA por
    // último", e cortava em 20 antes de saber quem estava perto do teto. A
    // ordenação certa é por percentual, e ela acontece depois de calcular.
    //
    // `.gt("monthly_limit_cents", 0)` é um filtro DE VERDADE (o anterior,
    // `.gte(..., 0)`, era sempre verdadeiro): sem teto não há percentual.
    admin
      .from("ai_budgets")
      .select(`
        organization_id,
        monthly_limit_cents,
        current_month_consumed_cents,
        enforcement_mode,
        organizations!inner(display_name)
      `)
      .gt("monthly_limit_cents", 0)
      .limit(2000),

    // Tenant pending overflow: conversations pending count per org > 50
    // Use a raw query via rpc or aggregate in JS
    admin
      .from("conversations")
      .select("organization_id, organizations!inner(display_name)")
      .eq("status", "pending")
      .limit(2000),
  ]);

  const alerts: AlertItem[] = [];
  const now = Date.now();

  // WAHA alerts
  for (const row of wahaAlertsRes.data ?? []) {
    const org = (row as { organizations?: { display_name?: string } }).organizations;
    alerts.push({
      id: `waha-${row.id}`,
      severity: row.status === "ban_suspected" ? "critical" : "warning",
      kind: "waha_ban",
      tenant_id: row.organization_id,
      tenant_name: (org as { display_name?: string })?.display_name ?? row.organization_id,
      message:
        row.status === "ban_suspected"
          ? "Sessão WAHA com suspeita de banimento"
          : `Sessão desconectada inesperadamente${row.status_reason ? `: ${row.status_reason}` : ""}`,
      link: `/admin/tenants/${row.organization_id}/health`,
      created_at: row.updated_at,
    });
  }

  // LGPD alerts
  for (const row of lgpdAlertsRes.data ?? []) {
    const org = (row as { organizations?: { display_name?: string } }).organizations;
    const isOverdue = new Date(row.due_at).getTime() < now;
    alerts.push({
      id: `lgpd-${row.id}`,
      severity: isOverdue ? "critical" : "warning",
      kind: "lgpd_at_risk",
      tenant_id: row.organization_id,
      tenant_name: (org as { display_name?: string })?.display_name ?? row.organization_id,
      message: isOverdue
        ? `Requisição LGPD vencida em ${new Date(row.due_at).toLocaleDateString("pt-PT")}`
        : `Prazo LGPD expira em ${new Date(row.due_at).toLocaleDateString("pt-PT")}`,
      link: "/admin/lgpd",
      created_at: row.created_at,
    });
  }

  // AI budget alerts
  //
  // O KPI conta USO; o ALERTA exige ação, e por isso pula
  // `enforcement_mode = 'off'`. A diferença entre os dois números não é
  // inconsistência: um teto que ninguém aplica é um número maior que outro
  // número — chamar isso de alerta treina o operador a ignorar a cor exatamente
  // onde ela precisa ser crível.
  //
  // ⚠️ DIVERGÊNCIA DECLARADA — ESTE NÚMERO NÃO É O DO MÊS, E NÃO É O QUE DECIDE.
  //
  // Ele vem de `ai_budgets.current_month_consumed_cents`, o contador
  // materializado pelo gatilho `fn_update_budget_consumption`, que soma
  // `NEW.cost_cents` SEM OLHAR A DATA e nunca zera (o único recomputo é o
  // apêndice da 0140, que só roda no `install.sh`/`update.sh`). Na prática é
  // gasto ACUMULADO desde a instalação. Quem decide se a IA para é
  // `fn_gasto_de_ia_do_mes` — a régua única, usada pelo gate, pelo card do
  // cliente e pelo painel de saúde por tenant
  // (`app/api/v1/admin/tenants/[id]/health/route.ts`). Consequência conferível:
  // um tenant pode ler 240% AQUI e 30% na própria tela de saúde, e o de aqui é
  // o errado.
  //
  // Por que não a régua: ela é `fn_gasto_de_ia_do_mes(uuid)`, uma org por
  // chamada — N round-trips numa rota que já faz oito consultas. A alternativa
  // barata (um `group by organization_id` sobre `llm_calls` inline) seria uma
  // SEGUNDA RÉGUA, exatamente o que `tests/unit/orcamento-uma-regua-de-gasto.test.ts`
  // existe para impedir. O conserto certo é uma variante em lote da própria
  // régua (`fn_gasto_de_ia_do_mes_em_lote(uuid[])`), e é item próprio.
  //
  // Enquanto isso, DUAS MITIGAÇÕES, ambas abaixo: o rótulo diz "acumulado" (não
  // "este mês"), e a severidade NUNCA chega a `critical` a partir deste número —
  // um alarme vermelho dizendo "a IA deste tenant parou" sobre um contador que
  // não zera é o alarme não-crível que o vizinho de `aiOverallStatus` diz querer
  // evitar.
  const perto = (aiBudgetAlertsRes.data ?? [])
    .map((row) => {
      const org = (row as { organizations?: { display_name?: string } }).organizations;
      const limit = Number(row.monthly_limit_cents ?? 0);
      return {
        organization_id: row.organization_id,
        nome: (org as { display_name?: string })?.display_name ?? row.organization_id,
        modo: normalizarModoDeOrcamento(
          (row as { enforcement_mode?: string | null }).enforcement_mode ?? null,
        ),
        pct: limit > 0 ? Number(row.current_month_consumed_cents ?? 0) / limit : 0,
      };
    })
    .filter((r) => r.pct >= 0.8);

  const aiBudgetWarnings = perto.length;

  for (const row of perto
    .filter((r) => r.modo !== "off")
    .sort((a, b) => b.pct - a.pct)
    .slice(0, 20)) {
    alerts.push({
      id: `budget-${row.organization_id}`,
      // SEMPRE `warning`, nunca `critical`. O percentual vem do contador
      // acumulado (ver acima), então "passou de 100%" aqui não prova que a IA
      // parou — o tenant pode estar com o gasto do MÊS bem abaixo do teto. Um
      // vermelho que às vezes mente treina o operador a ignorar o vermelho.
      severity: "warning",
      kind: "ai_budget",
      tenant_id: row.organization_id,
      tenant_name: row.nome,
      message:
        row.modo === "bloquear"
          ? `Budget IA ${Math.round(row.pct * 100)}% do teto (gasto acumulado) — este tenant escolheu parar a IA no limite`
          : `Budget IA ${Math.round(row.pct * 100)}% do teto (gasto acumulado)`,
      // Leva à saúde DO TENANT, e não a `/admin/usage`: é a única tela de admin
      // que lê a régua real (`fn_gasto_de_ia_do_mes`). Quem clicar por causa
      // deste alerta chega no número que decide, não em outro acumulado.
      link: `/admin/tenants/${row.organization_id}/health`,
      // Estado DERIVADO na hora, como o alerta de overflow logo abaixo: não há
      // instante em que ele "nasceu" gravado em lugar nenhum, e `updated_at` da
      // linha é o carimbo da última chamada de IA, não deste cruzamento.
      created_at: new Date().toISOString(),
    });
  }

  // Tenant pending overflow: count per org
  const orgPendingCount: Record<string, { count: number; name: string }> = {};
  for (const row of overflowAlertsRes.data ?? []) {
    const org = (row as { organizations?: { display_name?: string } }).organizations;
    const name = (org as { display_name?: string })?.display_name ?? row.organization_id;
    if (!orgPendingCount[row.organization_id]) {
      orgPendingCount[row.organization_id] = { count: 0, name };
    }
    orgPendingCount[row.organization_id]!.count++;
  }
  for (const [orgId, { count, name }] of Object.entries(orgPendingCount)) {
    if (count > 50) {
      alerts.push({
        id: `overflow-${orgId}`,
        severity: "warning",
        kind: "tenant_pending_overflow",
        tenant_id: orgId,
        tenant_name: name,
        message: `${count} conversas pendentes sem atendimento`,
        link: `/admin/tenants/${orgId}/health`,
        created_at: new Date().toISOString(),
      });
    }
  }

  // Sort: critical first, then by created_at desc
  alerts.sort((a, b) => {
    if (a.severity === b.severity) {
      return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
    }
    return a.severity === "critical" ? -1 : 1;
  });

  const kpis: DashboardKPIs = {
    tenants_active: tenantsRes.count ?? 0,
    conv_pending_10min: convPendingRes.count ?? 0,
    waha_ban_alerts: wahaBanRes.count ?? 0,
    lgpd_at_risk: lgpdRiskRes.count ?? 0,
    ai_budget_warnings: aiBudgetWarnings,
    alerts: alerts.slice(0, 20),
  };

  return ok(kpis);
}
