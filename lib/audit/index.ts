/**
 * Append-only audit log writer. Fire-and-forget — failure must NEVER block the
 * primary mutation. Errors are surfaced via console.error (Sentry breadcrumb in prod).
 *
 * Schema source: docs/specs/01-spec-platform-base.md §2.5
 *   columns: organization_id, actor_user_id, actor_api_token_id,
 *            acting_as_platform_admin, actor_ip, actor_user_agent,
 *            action, resource_type, resource_id, request_id,
 *            bypassed_rls, metadata, created_at
 */
import { createHash } from "node:crypto";

import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { env } from "@/lib/env";
import type { AuditAction } from "./actions";

export function isServiceRoleConfigured(): boolean {
  const key = env.SUPABASE_SERVICE_ROLE_KEY.trim();
  // NUNCA infira validade pelo comprimento. O Supabase emitia só JWT (200+
  // caracteres) — daí o `length > 50` original — e passou a emitir também a
  // chave curta `sb_secret_...` (~41 caracteres), que esse corte rejeitava
  // mesmo sendo uma chave real e funcional. O comprimento nunca foi a
  // resposta certa, era um proxy frágil para "isso parece um JWT" que quebra
  // toda vez que o formato do terceiro muda. A pergunta real é só "tem
  // chave de verdade?": ausência (string vazia) ou placeholder explícito são
  // os únicos "não". Erra para o lado de "tenho a chave" — tentar e falhar
  // alto é melhor que degradar em silêncio (que foi o efeito real do bug:
  // login/convite/atribuição em massa falhando ou perdendo dado sem
  // explicação, com a chave real configurada).
  return key.length > 0 && !key.startsWith("PLACEHOLDER");
}

interface AuditEntry {
  action: AuditAction;
  actorUserId?: string | null;
  actorApiTokenId?: string | null;
  /** Somente identidade de state OAuth assinado e validado; nunca input bruto. */
  actorAuthSessionId?: string | null;
  organizationId?: string | null;
  resourceType?: string | null;
  resourceId?: string | null;
  metadata?: Record<string, unknown>;
  requestId?: string | null;
  ip?: string | null;
  userAgent?: string | null;
  bypassedRls?: boolean;
  actingAsPlatformAdmin?: boolean;
}

export async function audit(entry: AuditEntry): Promise<void> {
  try {
    // Prefer service-role admin (bypasses RLS, works for unauthenticated audit
    // events like login_failed). Fall back to user-scoped client when service
    // role is missing in dev — RLS policy `audit_log_insert_tenant_member` has
    // null qual so authenticated users can insert their own audit rows.
    const client = isServiceRoleConfigured() ? createAdminClient() : await createClient();
    let supportMetadata: Record<string, unknown> = {};
    try {
      if (entry.actorUserId && entry.actorAuthSessionId && entry.organizationId && !entry.actorApiTokenId) {
        // Callback SameSite=Strict não traz cookie. O state já autenticou ator/sessão;
        // a cerca do callback já revalidou a autorização antes do efeito.
        const { data: support } = await createAdminClient().from("platform_support_sessions")
          .select("id, access_mode, auth_session_id, ended_at")
          .eq("actor_user_id", entry.actorUserId).eq("auth_session_id", entry.actorAuthSessionId)
          .eq("organization_id", entry.organizationId).order("created_at", { ascending: false }).limit(1).maybeSingle();
        if (support && !support.ended_at) supportMetadata = {
          support_session_id: support.id, support_access_mode: support.access_mode,
          support_auth_session_id: support.auth_session_id,
        };
      } else if (entry.actorUserId && !entry.actorApiTokenId) {
        const db = await createClient();
        const { data: { user } } = await db.auth.getUser();
        if (user?.id === entry.actorUserId) {
          const { readSupportContext } = await import("@/lib/impersonate/support");
          const support = await readSupportContext(db);
          if (support && support.organization_id === entry.organizationId) supportMetadata = {
            support_session_id: support.id, support_access_mode: support.access_mode,
            support_auth_session_id: support.auth_session_id,
          };
        }
      }
    } catch { /* Audit principal segue, inclusive sem request (workers). */ }
    const { error } = await client.from("api_audit_log").insert({
      action: entry.action,
      actor_user_id: entry.actorUserId ?? null,
      actor_api_token_id: entry.actorApiTokenId ?? null,
      organization_id: entry.organizationId ?? null,
      resource_type: entry.resourceType ?? null,
      resource_id: entry.resourceId ?? null,
      metadata: { ...entry.metadata, ...supportMetadata },
      request_id: entry.requestId ?? null,
      actor_ip: entry.ip ?? null,
      actor_user_agent: entry.userAgent ?? null,
      bypassed_rls: entry.bypassedRls ?? false,
      acting_as_platform_admin: !!supportMetadata.support_session_id || (entry.actingAsPlatformAdmin ?? false),
    });
    if (error) {
      reportAuditFailure(error.message, entry);
    }
  } catch (err) {
    reportAuditFailure(err instanceof Error ? err.message : String(err), entry);
  }
}

/**
 * Falha de audit não bloqueia a mutação (por doutrina), mas TEM que ser
 * barulhenta em algum lugar — senão a trilha de auditoria pode parar inteira
 * sem ninguém perceber. Foi exatamente o que aconteceu: TODA chamada de
 * ferramenta MCP falhava ao auditar ("invalid input syntax for type uuid") e o
 * único sinal era um console.error dentro do contêiner.
 */
function reportAuditFailure(message: string, entry: AuditEntry): void {
  console.error("[audit] insert error", message, { action: entry.action });
  void import("@sentry/nextjs")
    .then((Sentry) => {
      Sentry.captureException(new Error(`[audit] write failed: ${message}`), {
        level: "error",
        tags: { subsystem: "audit", audit_action: entry.action },
        extra: { resource_type: entry.resourceType, organization_id: entry.organizationId },
      });
    })
    .catch(() => {
      /* sem Sentry configurado: o console.error acima é o que resta */
    });
}

/**
 * Stable sha256 hex of normalized email. Used in audit metadata to correlate
 * failed logins without storing PII plaintext.
 */
export function hashEmail(email: string): string {
  return createHash("sha256").update(email.trim().toLowerCase()).digest("hex");
}
