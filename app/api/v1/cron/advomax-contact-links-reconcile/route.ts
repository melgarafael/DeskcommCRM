/** POST /api/v1/cron/advomax-contact-links-reconcile — confirma vínculos pending. */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { audit } from "@/lib/audit";
import { fail, ok } from "@/lib/api/wrappers";
import { advomaxFileCode } from "@/lib/crm/document-intake";
import { env } from "@/lib/env";
import { createAdminClient } from "@/lib/supabase/admin";
import { buscarPessoasAdvomax, PEOPLE_PAGE_SIZE, sincronizarClientesAdvomax } from "@/lib/advomax/people-sync";
import { type GateAcessoCrm, type MotivoBloqueioAcessoCrm, verificarAcessoCrmDaOrganizacao } from "@/lib/advomax/licenca";

export const dynamic = "force-dynamic";

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 50;
const MAX_ORGANIZATIONS = 25;

type PendingLink = {
  id: string;
  organization_id: string;
  pessoa_codigo: number;
  created_by: string | null;
  created_by_email: string | null;
};

type SyncOrganization = {
  id: string;
  status: string;
  advomax_empresa_codigo: number | null;
  created_by: string | null;
  settings: unknown;
};

type GateForOrganization = (organizationId: string, email: string | null | undefined, advomaxEmpresaCodigo: number | null | undefined) => Promise<GateAcessoCrm>;

function novoMapaDeBloqueios(): Record<MotivoBloqueioAcessoCrm, number> {
  return {
    bridge_not_configured: 0,
    organization_unmapped: 0,
    organization_inactive: 0,
    license_inactive: 0,
    license_unavailable: 0,
    identity_missing: 0,
  };
}

export async function GET(req: NextRequest): Promise<Response> { return run(req); }
export async function POST(req: NextRequest): Promise<Response> { return run(req); }

async function run(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  if (!validCronSecret(req)) return fail("forbidden", "Cron secret missing or invalid.", 403, { requestId });
  if (!env.ADVOMAX_API_URL.trim() || !env.ADVOMAX_CRM_INTEGRATION_KEY.trim()) {
    return ok({ processed: 0, linked: 0, unchanged: 0, failed: 0, skipped: 1, blocked: 0, skipped_reasons: { ...novoMapaDeBloqueios(), bridge_not_configured: 1 } }, { requestId });
  }

  const parsedLimit = Number.parseInt(req.nextUrl.searchParams.get("limit") ?? "", 10);
  const limit = Number.isFinite(parsedLimit) && parsedLimit > 0 ? Math.min(parsedLimit, MAX_LIMIT) : DEFAULT_LIMIT;
  const admin = createAdminClient();
  const gateCache = new Map<string, Promise<GateAcessoCrm>>();
  const gateForOrganization: GateForOrganization = (organizationId, email, advomaxEmpresaCodigo) => {
    const cached = gateCache.get(organizationId);
    if (cached) return cached;
    const gate = verificarAcessoCrmDaOrganizacao(email, organizationId, advomaxEmpresaCodigo);
    gateCache.set(organizationId, gate);
    return gate;
  };
  const peopleSync = await sincronizarOrganizacoes(admin, requestId, gateForOrganization);
  const { data, error } = await admin.from("advomax_contact_links" as never)
    .select("id,organization_id,pessoa_codigo,created_by,created_by_email")
    .eq("status", "pending")
    .order("updated_at", { ascending: true })
    .limit(limit);
  if (error) return fail("internal_error", "Não foi possível ler os vínculos pendentes.", 500, { requestId });

  const stats = { processed: 0, linked: 0, skipped_identity: 0, unchanged: 0, failed: 0, skipped: 0, blocked: 0, skipped_reasons: novoMapaDeBloqueios() };
  const organizationIds = [...new Set(((data ?? []) as unknown as PendingLink[]).map((row) => row.organization_id))];
  const organizations = organizationIds.length
    ? await admin.from("organizations" as never).select("id,status,advomax_empresa_codigo").in("id", organizationIds)
    : { data: [], error: null };
  if (organizations.error) return fail("internal_error", "Não foi possível validar as organizações dos vínculos.", 500, { requestId });
  const organizationById = new Map((organizations.data ?? []).map((org) => {
    const row = org as { id: string; status?: string; advomax_empresa_codigo?: number | null };
    return [row.id, row];
  }));
  for (const row of (data ?? []) as unknown as PendingLink[]) {
    stats.processed++;
    const organization = organizationById.get(row.organization_id);
    if (!organization || organization.status !== "active") {
      stats.blocked++;
      stats.skipped_reasons[organization ? "organization_inactive" : "organization_unmapped"]++;
      continue;
    }
    if (!Number.isSafeInteger(organization.advomax_empresa_codigo) || (organization.advomax_empresa_codigo as number) <= 0) {
      stats.blocked++;
      stats.skipped_reasons.organization_unmapped++;
      continue;
    }
    const email = row.created_by_email?.trim();
    if (!email) { stats.skipped_identity++; stats.skipped++; stats.skipped_reasons.identity_missing++; continue; }
    const gate = await gateForOrganization(row.organization_id, email, organization.advomax_empresa_codigo);
    if (!gate.ok) { stats.skipped++; stats.skipped_reasons[gate.reason]++; continue; }

    const base = env.ADVOMAX_API_URL.replace(/\/$/, "");
    const response = await fetch(`${base}/integracoes/crm/pessoas/${row.pessoa_codigo}/resumo`, {
      headers: {
        "X-CRM-Integration-Key": env.ADVOMAX_CRM_INTEGRATION_KEY,
        "X-CRM-User-Email": email,
        "X-CRM-Organization-Id": row.organization_id,
      },
      signal: AbortSignal.timeout(15_000),
    }).catch(() => null);
    if (!response?.ok) { stats.failed++; continue; }

    const body = await response.json().catch(() => null);
    const codigo = advomaxFileCode(body);
    if (codigo !== row.pessoa_codigo) { stats.failed++; continue; }

    const { data: updated, error: updateError } = await admin.from("advomax_contact_links" as never)
      .update({ status: "linked", last_synced_at: new Date().toISOString() } as never)
      .eq("id", row.id).eq("organization_id", row.organization_id).eq("status", "pending")
      .select("id").maybeSingle();
    if (updateError) { stats.failed++; continue; }
    if (!updated) {
      stats.unchanged++;
    } else {
      stats.linked++;
      await audit({
        action: "contact.advomax_link_reconciled",
        actorUserId: row.created_by,
        organizationId: row.organization_id,
        resourceType: "advomax_contact_link",
        resourceId: row.id,
        requestId,
        metadata: { pessoa_codigo: row.pessoa_codigo },
      });
    }
  }
  return ok({ ...stats, people_sync: peopleSync }, { requestId });
}

async function sincronizarOrganizacoes(admin: ReturnType<typeof createAdminClient>, requestId: string, gateForOrganization: GateForOrganization) {
  const result = { organizations: 0, pages: 0, updated: 0, created: 0, linked: 0, conflicts: 0, skipped_identity: 0, skipped: 0, blocked: 0, skipped_reasons: novoMapaDeBloqueios(), failed: 0 };
  const { data, error } = await admin.from("organizations" as never)
    .select("id,status,created_by,settings,advomax_empresa_codigo")
    .eq("status", "active")
    // Mapeadas primeiro: uma instalação com muitos tenants standalone não pode
    // consumir o limite e deixar a sincronização licenciada esperando.
    .order("advomax_empresa_codigo", { ascending: false, nullsFirst: false })
    .limit(MAX_ORGANIZATIONS);
  if (error) return { ...result, failed: 1 };

  for (const org of (data ?? []) as unknown as (SyncOrganization & { advomax_empresa_codigo: number | null })[]) {
    result.organizations++;
    if (!Number.isSafeInteger(org.advomax_empresa_codigo) || (org.advomax_empresa_codigo as number) <= 0) {
      result.blocked++;
      result.skipped_reasons.organization_unmapped++;
      continue;
    }
    const email = await emailDaOrganizacao(admin, org);
    if (!email) {
      result.skipped_identity++;
      result.skipped++;
      result.skipped_reasons.identity_missing++;
      continue;
    }
    const gate = await gateForOrganization(org.id, email, org.advomax_empresa_codigo);
    if (!gate.ok) { result.skipped++; result.skipped_reasons[gate.reason]++; continue; }
    const offset = offsetDaConfiguracao(org.settings);
    const pessoas = await buscarPessoasAdvomax(email, org.id, offset);
    if (!pessoas) { result.failed++; continue; }
    const sync = await sincronizarClientesAdvomax(admin, org.id, org.created_by, pessoas);
    if ("error" in sync) { result.failed++; continue; }
    result.pages++;
    result.updated += sync.atualizados;
    result.created += sync.criados;
    result.linked += sync.vinculados;
    result.conflicts += sync.conflitos;
    const nextOffset = pessoas.length === PEOPLE_PAGE_SIZE ? offset + pessoas.length : 0;
    const { error: cursorError } = await admin.from("organizations" as never)
      .update({ settings: comOffsetAtualizado(org.settings, nextOffset) } as never)
      .eq("id", org.id);
    if (cursorError) { result.failed++; continue; }
    await audit({
      action: "contact.advomax_sync_completed",
      organizationId: org.id,
      actorUserId: org.created_by,
      resourceType: "advomax_contact_sync",
      requestId,
      metadata: { ...sync, offset, next_offset: nextOffset },
    });
  }
  return result;
}

async function emailDaOrganizacao(admin: ReturnType<typeof createAdminClient>, org: SyncOrganization): Promise<string | null> {
  if (org.created_by && admin.auth?.admin?.getUserById) {
    const { data } = await admin.auth.admin.getUserById(org.created_by);
    const email = data.user?.email?.trim();
    if (email) return email;
  }
  const { data } = await admin.from("advomax_contact_links" as never)
    .select("created_by_email").eq("organization_id", org.id)
    .not("created_by_email", "is", null).limit(1).maybeSingle();
  return (data as { created_by_email?: string | null } | null)?.created_by_email?.trim() || null;
}

export function offsetDaConfiguracao(settings: unknown): number {
  if (!settings || typeof settings !== "object") return 0;
  const value = (settings as { advomax_people_sync_offset?: unknown }).advomax_people_sync_offset;
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= 100_000 ? value : 0;
}

export function comOffsetAtualizado(settings: unknown, offset: number): Record<string, unknown> {
  const base = settings && typeof settings === "object" && !Array.isArray(settings) ? settings as Record<string, unknown> : {};
  return { ...base, advomax_people_sync_offset: offset };
}

function validCronSecret(req: NextRequest): boolean {
  const auth = req.headers.get("authorization") ?? "";
  const provided = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
  return Boolean(provided && [env.INTERNAL_CRON_SECRET, env.INTERNAL_SECRET].some((secret) => secret && secret === provided));
}
