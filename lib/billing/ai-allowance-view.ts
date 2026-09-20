import type pg from "pg";

export interface AiAllowanceView {
  status: "ready" | "review" | "inactive" | "unconfirmed";
  budget: number;
  used: number;
  reserved: number;
  remaining: number;
  rate: number;
  periodStart: string | null;
  periodEnd: string | null;
}
interface Row {
  status: string;
  current_period_start: Date | string | null;
  current_period_end: Date | string | null;
  budget: string | number | null;
  rate: string | number | null;
  used: string | number;
  reserved: string | number;
  unknown_count: string | number;
}
/** The display uses the same period and reservations as the transaction functions. */
export function allowanceView(row: Row, now = Date.now()): AiAllowanceView {
  const start = row.current_period_start ? new Date(row.current_period_start).getTime() : NaN;
  const end = row.current_period_end ? new Date(row.current_period_end).getTime() : NaN;
  const budget = Number(row.budget);
  const rate = Number(row.rate);
  const used = Number(row.used);
  const reserved = Number(row.reserved);
  const unknown = Number(row.unknown_count);
  if (
    ![budget, rate, used, reserved, unknown].every(Number.isFinite) ||
    budget <= 0 ||
    rate <= 0 ||
    used < 0 ||
    reserved < 0 ||
    unknown < 0
  )
    throw new Error("Invalid AI allowance snapshot");
  const confirmed = Number.isFinite(start) && Number.isFinite(end) && start < end;
  const active = ["active", "trialing"].includes(row.status) && start <= now && end > now;
  return {
    status: !confirmed ? "unconfirmed" : !active ? "inactive" : unknown > 0 ? "review" : "ready",
    budget,
    rate,
    used,
    reserved,
    remaining: Math.max(0, budget - used - reserved),
    periodStart: confirmed ? new Date(start).toISOString() : null,
    periodEnd: confirmed ? new Date(end).toISOString() : null,
  };
}
export async function readAiAllowance(db: Pick<pg.Pool, "query">, organizationId: string) {
  const { rows } = await db.query<Row>(
    `select s.status,s.current_period_start,s.current_period_end,
       coalesce(p.budget_brl_cents,l.ai_credit_cents) as budget,
       coalesce(p.usd_to_brl_rate,l.ai_usd_to_brl_rate) as rate,
       coalesce(a.used,0) as used,coalesce(a.reserved,0) as reserved,
       coalesce(a.unknown_count,0) as unknown_count
     from org_subscriptions s
     left join subscription_plan_limits l on l.plan_id=s.plan_id
     left join subscription_ai_periods p on p.organization_id=s.organization_id
       and p.provider_subscription_id=s.provider_subscription_id
       and p.period_start=s.current_period_start
     left join lateral (
       select sum(charged_brl_cents) filter(where status='settled') as used,
              sum(reserved_brl_cents) filter(where status<>'settled') as reserved,
              count(*) filter(where status='unknown') as unknown_count
       from subscription_ai_reservations
       where organization_id=s.organization_id and period_id=p.id
     ) a on true
     where s.organization_id=$1 and s.provider_subscription_id is not null`,
    [organizationId],
  );
  return rows[0] ? allowanceView(rows[0]) : null;
}
