import type { SupabaseClient } from "@supabase/supabase-js";
import { roleAtLeast, type AuthUser, type Role } from "@/lib/auth/types";
import { verificarIntencaoDeContratacao, VALIDADE_DA_INTENCAO_MS } from "./intencao-assinada";
export { VALIDADE_DA_INTENCAO_MS } from "./intencao-assinada";

export const CAMINHO_DA_CONTRATACAO = "/cobranca/contratar";

/** Mesma autoridade financeira de requireRole(admin); LGPD tem régua própria. */
export function podeContinuarContratacao(
  user: Pick<AuthUser, "is_platform_admin" | "platform_admin_scope" | "support">, role: Role,
): boolean {
  return !user.support && (roleAtLeast(role, "admin") || (user.is_platform_admin && user.platform_admin_scope === "full"));
}

/** Primeiro pagamento não é inadimplência. O bloqueio de acesso continua no banco. */
export function primeiroPagamentoPendente(a: {
  pagamento_inicial_pendente: boolean;
  periodo_pago_desde: string | null;
  estado: string;
} | null): boolean {
  return a !== null && a.pagamento_inicial_pendente && a.periodo_pago_desde === null && a.estado !== "ativa";
}

/**
 * Prova ASSINADA emitida pela action de signup em auditoria append-only.
 * Query, user_metadata ou INSERT de audit sem HMAC não autorizam criação. O POST ainda exige admin/MFA/org e usa
 * a reserva/idempotência nativa. Nada aqui chama o gateway ou libera acesso.
 */
export async function lerIntencaoDeContratacao(
  db: SupabaseClient, userId: string, orgId: string, agora = Date.now(),
): Promise<{ id: string; planoId: string } | null> {
  const [org, assinatura] = await Promise.all([
    db.from("organizations").select("created_by, created_at, status, suspended_kind").eq("id", orgId).maybeSingle(),
    db.from("cobranca_assinaturas").select("plano_id, estado, pagamento_inicial_pendente, periodo_pago_desde")
      .eq("organization_id", orgId).maybeSingle(),
  ]);
  if (org.error || assinatura.error) throw new Error("contratacao: leitura indisponível");
  const a = assinatura.data;
  if (!org.data || org.data.created_by !== userId || org.data.status !== "suspended" ||
      org.data.suspended_kind !== "cobranca" || !a || !primeiroPagamentoPendente(a) || a.estado === "cancelada") return null;

  const checked = await lerIntencaoDoCadastro(db, userId, a.plano_id, agora);
  // O UUID da empresa é escolhido pelo servidor no cadastro e assinado antes
  // de confirmar o e-mail. Outra empresa da mesma pessoa não herda o aceite.
  if (!checked || checked.organization_id !== orgId) return null;
  const emitida = checked.emitida_em;
  const criada = Date.parse(org.data.created_at);
  if (!Number.isFinite(criada) || criada < emitida - 5 * 60_000) return null;
  return { id: checked.nonce, planoId: checked.plano_id };
}

/** Provisionamento lê a intenção assinada, nunca um UUID de user_metadata. */
export async function lerIntencaoDoCadastro(
  db: SupabaseClient, userId: string, planoId: string, agora = Date.now(),
) {
  const { data, error } = await db.from("api_audit_log")
    .select("id, metadata, created_at")
    .eq("actor_user_id", userId).eq("action", "auth.signup_requested")
    .eq("metadata->contratacao->>plano_id", planoId)
    .eq("metadata->contratacao->>versao", "1")
    .gte("created_at", new Date(agora - VALIDADE_DA_INTENCAO_MS).toISOString())
    .order("created_at", { ascending: false }).limit(1).maybeSingle();
  if (error) throw new Error("contratacao: intenção indisponível");
  return verificarIntencaoDeContratacao(data?.metadata?.contratacao, userId, planoId, agora);
}
