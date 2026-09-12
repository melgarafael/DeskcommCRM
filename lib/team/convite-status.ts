/**
 * A regra de STATUS de um convite de time, isolada e SEM dependência de
 * servidor — para o client (`TeamInvitesClient`) e os testes importarem sem
 * arrastar `issueInvite`/`resend`/`audit` para o bundle.
 *
 * Status é derivado, nunca coluna (doutrina DIRC: Calcular): `revoked_at` e
 * `accepted_at` são fatos, `expires_at` é o relógio.
 */
export type StatusConvite = "pendente" | "aceito" | "expirado" | "revogado";

export interface CamposDeStatus {
  accepted_at: string | null;
  revoked_at: string | null;
  expires_at: string;
}

export function statusConvite(row: CamposDeStatus, now: number = Date.now()): StatusConvite {
  if (row.revoked_at) return "revogado";
  if (row.accepted_at) return "aceito";
  if (Date.parse(row.expires_at) <= now) return "expirado";
  return "pendente";
}

/** Revogar e reenviar só fazem sentido enquanto o convite está em aberto. */
export function conviteEstaEmAberto(row: CamposDeStatus, now?: number): boolean {
  const s = statusConvite(row, now);
  return s === "pendente" || s === "expirado";
}
