/** GET/POST /api/v1/cron/crm-document-intake — retries CRM → Advomax uploads. */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { audit } from "@/lib/audit";
import { fail, ok } from "@/lib/api/wrappers";
import { createAdminClient } from "@/lib/supabase/admin";
import { env } from "@/lib/env";
import { advomaxFileCode, DOCUMENT_INTAKE_MAX_ATTEMPTS } from "@/lib/crm/document-intake";
import { type GateAcessoCrm, type MotivoBloqueioAcessoCrm, verificarAcessoCrmDaOrganizacao } from "@/lib/advomax/licenca";

export const dynamic = "force-dynamic";
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;

type IntakeRow = {
  id: string; organization_id: string; message_id: string; pessoa_codigo: number;
  filename: string; mime_type: string; media_storage_path: string; descricao: string | null;
  attempts: number; requested_by: string | null; requested_by_email: string | null;
};

type OrganizationRow = { id: string; status: string; advomax_empresa_codigo: number | null };

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
    return ok({ processed: 0, claimed: 0, uploaded: 0, retried: 0, failed: 0, skipped: 1, blocked: 0, skipped_reasons: { ...novoMapaDeBloqueios(), bridge_not_configured: 1 } }, { requestId });
  }
  const rawLimit = Number.parseInt(req.nextUrl.searchParams.get("limit") ?? "", 10);
  const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, MAX_LIMIT) : DEFAULT_LIMIT;
  const admin = createAdminClient();
  const now = new Date().toISOString();
  const { data: pending, error } = await admin.from("crm_document_intake" as never)
    .select("*").eq("status", "pending").lte("next_attempt_at", now)
    .order("next_attempt_at", { ascending: true }).limit(limit);
  if (error) return fail("internal_error", "Não foi possível ler a fila de documentos.", 500, { requestId });

  const staleAt = new Date(Date.now() - 15 * 60_000).toISOString();
  const { data: recoveredRows } = await admin.from("crm_document_intake" as never)
    .update({ status: "pending", next_attempt_at: now, claimed_at: null, claimed_by: null } as never)
    .eq("status", "processing").lt("claimed_at", staleAt).select("id");
  const stats = { recovered: recoveredRows?.length ?? 0, claimed: 0, uploaded: 0, retried: 0, failed: 0, skipped: 0, blocked: 0, skipped_reasons: novoMapaDeBloqueios() };
  const organizationIds = [...new Set(((pending ?? []) as unknown as IntakeRow[]).map((row) => row.organization_id))];
  const organizations = organizationIds.length
    ? await admin.from("organizations" as never).select("id,status,advomax_empresa_codigo").in("id", organizationIds)
    : { data: [], error: null };
  if (organizations.error) return fail("internal_error", "Não foi possível validar as organizações da fila.", 500, { requestId });
  const organizationById = new Map((organizations.data ?? []).map((organization) => {
    const row = organization as OrganizationRow;
    return [row.id, row];
  }));
  const gateCache = new Map<string, Promise<GateAcessoCrm>>();
  for (const candidate of (pending ?? []) as unknown as IntakeRow[]) {
    const organization = organizationById.get(candidate.organization_id);
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
    const email = candidate.requested_by_email?.trim();
    if (!email) {
      stats.skipped++;
      stats.skipped_reasons.identity_missing++;
      continue;
    }
    let gate = gateCache.get(candidate.organization_id);
    if (!gate) {
      gate = verificarAcessoCrmDaOrganizacao(email, candidate.organization_id, organization.advomax_empresa_codigo);
      gateCache.set(candidate.organization_id, gate);
    }
    const acesso = await gate;
    if (!acesso.ok) {
      stats.skipped++;
      stats.skipped_reasons[acesso.reason]++;
      continue;
    }
    const { data: claimed } = await admin.from("crm_document_intake" as never).update({
      status: "processing", attempts: candidate.attempts + 1, claimed_at: now, claimed_by: `cron:${requestId}`,
    } as never).eq("id", candidate.id).eq("organization_id", candidate.organization_id).eq("status", "pending").select("*").maybeSingle();
    if (!claimed) continue;
    stats.claimed++;
    const row = claimed as unknown as IntakeRow;
    const result = await enviar(row, admin, requestId);
    if (result.ok) { stats.uploaded++; continue; }
    if (result.terminal) stats.failed++; else stats.retried++;
  }
  return ok(stats, { requestId });
}

async function enviar(row: IntakeRow, admin: ReturnType<typeof createAdminClient>, requestId: string): Promise<{ ok: true } | { ok: false; terminal: boolean }> {
  if (!row.requested_by_email?.trim()) {
    return registrarFalha(admin, row, requestId, "Identidade do atendente não disponível para este retry.");
  }
  const { data: blob, error: downloadError } = await admin.storage.from("whatsapp-media").download(row.media_storage_path);
  if (downloadError || !blob) return registrarFalha(admin, row, requestId, "Mídia não disponível no Storage.");
  const form = new FormData();
  form.append("file", new File([blob], row.filename, { type: row.mime_type }));
  if (row.descricao) form.append("descricao", row.descricao);
  const base = env.ADVOMAX_API_URL.replace(/\/$/, "");
  const response = await fetch(`${base}/integracoes/crm/pessoas/${row.pessoa_codigo}/documentos`, {
    method: "POST",
    headers: {
      "X-CRM-Integration-Key": env.ADVOMAX_CRM_INTEGRATION_KEY,
      "X-CRM-User-Email": row.requested_by_email.trim(),
      "X-CRM-Organization-Id": row.organization_id,
      "X-CRM-Message-Id": row.message_id,
    },
    body: form,
    signal: AbortSignal.timeout(60_000),
  }).catch(() => null);
  if (!response?.ok) return registrarFalha(admin, row, requestId, "Advomax não confirmou o arquivamento.");
  const body = await response.json().catch(() => ({}));
  const codigo = advomaxFileCode(body);
  if (codigo === null) {
    return registrarFalha(admin, row, requestId, "Advomax devolveu um recibo de arquivo inválido.");
  }
  const { data: updated, error } = await admin.from("crm_document_intake" as never).update({
    status: "uploaded", advomax_file_id: codigo, failure_reason: null, claimed_at: null, claimed_by: null,
  } as never).eq("id", row.id).eq("organization_id", row.organization_id).eq("status", "processing").eq("claimed_by", `cron:${requestId}`).select("id").maybeSingle();
  if (error || !updated) return registrarFalha(admin, row, requestId, "Documento arquivado, mas o recibo não foi atualizado.");
  if (updated) {
    await audit({ action: "document_intake.uploaded", actorUserId: row.requested_by, organizationId: row.organization_id, resourceType: "crm_document_intake", resourceId: row.id, requestId, metadata: { worker: true } });
  }
  return { ok: true };
}

async function registrarFalha(admin: ReturnType<typeof createAdminClient>, row: IntakeRow, requestId: string, motivo: string): Promise<{ ok: false; terminal: boolean }> {
  const terminal = row.attempts >= DOCUMENT_INTAKE_MAX_ATTEMPTS;
  const { error: updateError } = await admin.from("crm_document_intake" as never).update({
    status: terminal ? "failed" : "pending",
    next_attempt_at: new Date(Date.now() + Math.min(60, 2 ** row.attempts) * 60_000).toISOString(),
    failure_reason: motivo, claimed_at: null, claimed_by: null,
  } as never).eq("id", row.id).eq("organization_id", row.organization_id).eq("status", "processing").eq("claimed_by", `cron:${requestId}`);
  if (!updateError || terminal) {
    await audit({ action: terminal ? "document_intake.failed" : "document_intake.retrying", actorUserId: row.requested_by, organizationId: row.organization_id, resourceType: "crm_document_intake", resourceId: row.id, requestId, metadata: { worker: true, retry: !terminal, reason: motivo } });
  }
  return { ok: false, terminal };
}

function validCronSecret(req: NextRequest): boolean {
  const auth = req.headers.get("authorization") ?? "";
  const provided = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
  return Boolean(provided && [env.INTERNAL_CRON_SECRET, env.INTERNAL_SECRET].some((secret) => secret && secret === provided));
}
