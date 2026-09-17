import { type NextRequest } from "next/server";
import { z } from "zod";
import { requirePlatformAdmin } from "@/lib/auth/requirePlatformAdmin";
import { createAdminClient } from "@/lib/supabase/admin";
import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { randomUUID } from "node:crypto";

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const querySchema = z.object({
  range: z.enum(["7d", "30d", "90d"]).default("30d"),
  tenant_id: z.string().uuid().optional(),
});

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface UsageTenantRow {
  organization_id: string;
  tenant_name: string;
  tenant_slug: string;
  messages_count: number;
  ai_invocations_count: number;
  ai_tokens_total: number;
  ai_cost_cents: number;
  conversations_count: number;
  /**
   * Nome do agente publicado nesta organização — o de maior prioridade, quando
   * há mais de um. `null` significa nenhum agente publicado, e é o sinal que o
   * operador procura na carteira: cliente cujo agente não está no ar.
   */
  agent_name: string | null;
}

export interface DailyPoint {
  date: string;
  count: number;
}

export interface DailyCostPoint {
  date: string;
  cents: number;
}

export interface DailyTokensPoint {
  date: string;
  tokens: number;
}

export interface UsageSeries {
  messages: DailyPoint[];
  ai_cost: DailyCostPoint[];
  ai_tokens: DailyTokensPoint[];
}

export interface UsageData {
  range: "7d" | "30d" | "90d";
  tenants: UsageTenantRow[];
  series: UsageSeries;
}

// ---------------------------------------------------------------------------
// GET /api/v1/admin/usage
// ---------------------------------------------------------------------------

export async function GET(req: NextRequest) {
  const requestId = randomUUID();

  let adminCtx: Awaited<ReturnType<typeof requirePlatformAdmin>>;
  try {
    adminCtx = await requirePlatformAdmin();
  } catch {
    return fail("forbidden", "Platform admin required", 403, { requestId });
  }

  const parsed = querySchema.safeParse(Object.fromEntries(req.nextUrl.searchParams.entries()));
  if (!parsed.success) {
    return fail("validation_error", "Invalid query params", 400, {
      requestId,
      details: parsed.error.flatten(),
    });
  }

  const { range, tenant_id } = parsed.data;
  const rangeMap: Record<string, number> = { "7d": 7, "30d": 30, "90d": 90 };
  const days = rangeMap[range] ?? 30;

  const admin = createAdminClient();

  // -------------------------------------------------------------------------
  // Per-tenant aggregates
  // -------------------------------------------------------------------------

  // Fetch organizations first (need name/slug)
  let orgsQuery = admin.from("organizations").select("id, display_name, slug");
  if (tenant_id) {
    orgsQuery = orgsQuery.eq("id", tenant_id);
  }
  const { data: orgs, error: orgsError } = await orgsQuery;
  if (orgsError) {
    return fail("db_error", "Failed to fetch organizations", 500, { requestId });
  }

  const orgMap = new Map(
    (orgs ?? []).map((o: { id: string; display_name: string; slug: string }) => [
      o.id,
      { display_name: o.display_name, slug: o.slug },
    ]),
  );

  const orgIds = (orgs ?? []).map((o: { id: string }) => o.id);

  // Compute start date
  const startDate = new Date();
  startDate.setDate(startDate.getDate() - days);
  const startIso = startDate.toISOString();

  // ---- messages count per org ----
  const messagesCountMap = new Map<string, number>();
  if (orgIds.length > 0) {
    const { data: msgRows, error: msgErr } = await admin
      .from("messages")
      .select("organization_id")
      .in("organization_id", orgIds)
      .gte("created_at", startIso);
    if (!msgErr && msgRows) {
      for (const row of msgRows) {
        const oid = row.organization_id as string;
        messagesCountMap.set(oid, (messagesCountMap.get(oid) ?? 0) + 1);
      }
    }
  }

  // ---- conversations count per org ----
  const convsCountMap = new Map<string, number>();
  if (orgIds.length > 0) {
    const { data: convRows, error: convErr } = await admin
      .from("conversations")
      .select("organization_id")
      .in("organization_id", orgIds)
      .gte("created_at", startIso);
    if (!convErr && convRows) {
      for (const row of convRows) {
        const oid = row.organization_id as string;
        convsCountMap.set(oid, (convsCountMap.get(oid) ?? 0) + 1);
      }
    }
  }

  // ---- consumo de IA por org: `llm_calls`, a tabela única (migration 0130) ----
  //
  // Lia `ai_invocations`, e a 0130 deixou essa tabela SEM NENHUM ESCRITOR:
  // `lib/ai/log-invocation.ts` passou a gravar em `llm_calls`. O painel de
  // plataforma continuaria somando o histórico congelado e, passados os 30 dias
  // da janela, mostraria ZERO consumo para todo tenant com o dinheiro saindo —
  // exatamente o sintoma que a 0130 existe para matar, reintroduzido na tela do
  // outro lado. `tests/unit/telemetria-tem-um-leitor-so.test.ts` guarda isto.
  const aiInvCountMap = new Map<string, number>();
  const aiTokensMap = new Map<string, number>();
  const aiCostMap = new Map<string, number>();

  if (orgIds.length > 0) {
    const { data: aiRows, error: aiErr } = await admin
      .from("llm_calls")
      .select("organization_id, input_tokens, output_tokens, cost_cents")
      .in("organization_id", orgIds)
      .gte("created_at", startIso);
    if (!aiErr && aiRows) {
      for (const row of aiRows) {
        const oid = row.organization_id as string;
        aiInvCountMap.set(oid, (aiInvCountMap.get(oid) ?? 0) + 1);
        aiTokensMap.set(
          oid,
          (aiTokensMap.get(oid) ?? 0) +
            ((row.input_tokens as number) ?? 0) +
            ((row.output_tokens as number) ?? 0),
        );
        aiCostMap.set(oid, (aiCostMap.get(oid) ?? 0) + ((row.cost_cents as number) ?? 0));
      }
    }
  }

  // ---- agente publicado por organização ----
  //
  // Uma linha por organização basta para a carteira: o agente de MAIOR
  // prioridade entre os publicados. A lista completa vive na aba Agente do
  // cliente — aqui a pergunta é só "este cliente está atendendo?".
  const agentNamePorOrg: Record<string, string> = {};
  if (orgIds.length > 0) {
    const { data: agentRows, error: agentErr } = await admin
      .from("ai_agents")
      .select("organization_id, name, priority")
      .in("organization_id", orgIds)
      .is("archived_at", null)
      .not("published_version_id", "is", null)
      .order("priority", { ascending: false });
    if (!agentErr && agentRows) {
      for (const row of agentRows) {
        const oid = row.organization_id as string;
        if (!agentNamePorOrg[oid]) agentNamePorOrg[oid] = row.name as string;
      }
    }
  }

  // Build tenant rows
  const tenants: UsageTenantRow[] = (orgs ?? [])
    .map((org: { id: string }) => {
      const meta = orgMap.get(org.id) ?? { display_name: org.id, slug: "" };
      return {
        organization_id: org.id,
        tenant_name: meta.display_name,
        tenant_slug: meta.slug,
        messages_count: messagesCountMap.get(org.id) ?? 0,
        ai_invocations_count: aiInvCountMap.get(org.id) ?? 0,
        ai_tokens_total: aiTokensMap.get(org.id) ?? 0,
        ai_cost_cents: aiCostMap.get(org.id) ?? 0,
        conversations_count: convsCountMap.get(org.id) ?? 0,
        agent_name: agentNamePorOrg[org.id] ?? null,
      };
    })
    .sort(
      (a: UsageTenantRow, b: UsageTenantRow) =>
        b.ai_cost_cents - a.ai_cost_cents || b.messages_count - a.messages_count,
    );

  // -------------------------------------------------------------------------
  // Daily series
  // -------------------------------------------------------------------------

  // Build date labels for last N days
  const dateLabels: string[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    dateLabels.push(d.toISOString().slice(0, 10));
  }

  // messages per day
  const msgDayMap = new Map<string, number>();
  if (orgIds.length > 0) {
    const filterOrgIds = tenant_id ? [tenant_id] : orgIds;
    const { data: msgDays, error: msgDayErr } = await admin
      .from("messages")
      .select("created_at")
      .in("organization_id", filterOrgIds)
      .gte("created_at", startIso);
    if (!msgDayErr && msgDays) {
      for (const row of msgDays) {
        const day = (row.created_at as string).slice(0, 10);
        msgDayMap.set(day, (msgDayMap.get(day) ?? 0) + 1);
      }
    }
  }

  // ai cost + tokens per day
  const aiCostDayMap = new Map<string, number>();
  const aiTokensDayMap = new Map<string, number>();
  if (orgIds.length > 0) {
    const filterOrgIds = tenant_id ? [tenant_id] : orgIds;
    // `llm_calls`, pelo mesmo motivo do bloco acima (migration 0130).
    const { data: aiDays, error: aiDayErr } = await admin
      .from("llm_calls")
      .select("created_at, input_tokens, output_tokens, cost_cents")
      .in("organization_id", filterOrgIds)
      .gte("created_at", startIso);
    if (!aiDayErr && aiDays) {
      for (const row of aiDays) {
        const day = (row.created_at as string).slice(0, 10);
        aiCostDayMap.set(day, (aiCostDayMap.get(day) ?? 0) + ((row.cost_cents as number) ?? 0));
        aiTokensDayMap.set(
          day,
          (aiTokensDayMap.get(day) ?? 0) +
            ((row.input_tokens as number) ?? 0) +
            ((row.output_tokens as number) ?? 0),
        );
      }
    }
  }

  const series: UsageSeries = {
    messages: dateLabels.map((date) => ({
      date,
      count: msgDayMap.get(date) ?? 0,
    })),
    ai_cost: dateLabels.map((date) => ({
      date,
      cents: aiCostDayMap.get(date) ?? 0,
    })),
    ai_tokens: dateLabels.map((date) => ({
      date,
      tokens: aiTokensDayMap.get(date) ?? 0,
    })),
  };

  // -------------------------------------------------------------------------
  // Audit
  // -------------------------------------------------------------------------

  void audit({
    action: "platform_admin.usage_viewed",
    actorUserId: adminCtx.user.id,
    actingAsPlatformAdmin: true,
    metadata: { range, tenant_id: tenant_id ?? null },
    requestId,
  });

  return ok<UsageData>({ range, tenants, series }, { requestId });
}
