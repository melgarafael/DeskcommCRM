/** GET/POST /api/v1/cron/crm-document-intake — retries CRM → Advomax uploads. */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { audit } from "@/lib/audit";
import { fail, ok } from "@/lib/api/wrappers";
import { createAdminClient } from "@/lib/supabase/admin";
import { env } from "@/lib/env";
import { advomaxFileCode } from "@/lib/crm/document-intake";

export const dynamic = "force-dynamic";
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;
const MAX_ATTEMPTS = 5;

type IntakeRow = {
  id: string; organization_id: string; message_id: string; pessoa_codigo: number;
  filename: string; mime_type: string; media_storage_path: string; descricao: string | null;
  attempts: number; requested_by: string | null; requested_by_email: string | null;
};

export async function GET(req: NextRequest): Promise<Response> { return run(req); }
export async function POST(req: NextRequest): Promise<Response> { return run(req); }

async function run(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  if (!validCronSecret(req)) return fail("forbidden", "Cron secret missing or invalid.", 403, { requestId });
  if (!env.ADVOMAX_API_URL.trim() || !env.ADVOMAX_CRM_INTEGRATION_KEY.trim()) {
    return ok({ processed: 0, skipped: "bridge_not_configured" }, { requestId });
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
  const stats = { recovered: recoveredRows?.length ?? 0, claimed: 0, uploaded: 0, retried: 0, failed: 0 };
  for (const candidate of (pending ?? []) as unknown as IntakeRow[]) {
    const { data: claimed } = await admin.from("crm_document_intake" as never).update({
      status: "processing", attempts: candidate.attempts + 1, claimed_at: now, claimed_by: `cron:${requestId}`,
    } as never).eq("id", candidate.id).eq("status", "pending").select("*").maybeSingle();
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
  const { error } = await admin.from("crm_document_intake" as never).update({
    status: "uploaded", advomax_file_id: codigo, failure_reason: null, claimed_at: null, claimed_by: null,
  } as never).eq("id", row.id).eq("status", "processing");
  if (error) return registrarFalha(admin, row, requestId, "Documento arquivado, mas o recibo não foi atualizado.");
  await audit({ action: "document_intake.uploaded", actorUserId: row.requested_by, organizationId: row.organization_id, resourceType: "crm_document_intake", resourceId: row.id, requestId, metadata: { worker: true } });
  return { ok: true };
}

async function registrarFalha(admin: ReturnType<typeof createAdminClient>, row: IntakeRow, requestId: string, motivo: string): Promise<{ ok: false; terminal: boolean }> {
  const terminal = row.attempts >= MAX_ATTEMPTS;
  await admin.from("crm_document_intake" as never).update({
    status: terminal ? "failed" : "pending",
    next_attempt_at: new Date(Date.now() + Math.min(60, 2 ** row.attempts) * 60_000).toISOString(),
    failure_reason: motivo, claimed_at: null, claimed_by: null,
  } as never).eq("id", row.id).eq("status", "processing");
  await audit({ action: terminal ? "document_intake.failed" : "document_intake.retrying", actorUserId: row.requested_by, organizationId: row.organization_id, resourceType: "crm_document_intake", resourceId: row.id, requestId, metadata: { worker: true, retry: !terminal, reason: motivo } });
  return { ok: false, terminal };
}

function validCronSecret(req: NextRequest): boolean {
  const auth = req.headers.get("authorization") ?? "";
  const provided = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
  return Boolean(provided && [env.INTERNAL_CRON_SECRET, env.INTERNAL_SECRET].some((secret) => secret && secret === provided));
}
