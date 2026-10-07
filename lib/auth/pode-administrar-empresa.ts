import {
  ROLE_RANK,
  escreveComoPlatformAdmin,
  type ActiveOrg,
  type AuthUser,
} from "@/lib/auth/types";

/**
 * Resposta ÚNICA para "este usuário pode escrever nesta empresa?".
 *
 * Concentra o atalho de papel que as rotas /api/v1 resolvem em
 * `requireRole("admin", { allowPlatformAdmin })` (lib/auth/require-role.ts —
 * spec 13 §4, G2-01): o super-admin de plataforma com scope `full` (#1987,
 * `escreveComoPlatformAdmin`), fora da sessão de suporte, passa direto; caso
 * contrário o papel efetivo na org ativa tem de ser `admin`. Quem tem scope
 * `support_readonly` (ou nenhum) não escreve pelo atalho.
 *
 * Só o papel: o MFA e a org suspensa, que o `requireRole` também cobra, ficam
 * com quem chama (`mfaEmDivida`; `resolveActiveOrg` redireciona a org suspensa).
 *
 * As server actions de `app/actions/` reescreviam esta regra à mão com três
 * grafias (16 checagens em 15 arquivos). Este é o único lugar onde ela vive.
 *
 * O usuário de suporte não usa o atalho de plataforma de propósito: durante o
 * acompanhamento o escopo é a org do suporte, e quem decide é o papel efetivo
 * derivado em `resolveActiveOrg` (`full` → `admin`, `support_readonly` →
 * `viewer`) — o mesmo comportamento que as ações já tinham, pois a guarda
 * `supportWriteError` (lib/impersonate/support) barra a sessão `support_readonly`
 * antes do efeito.
 */
export function podeAdministrarEmpresa(
  authUser: Pick<AuthUser, "is_platform_admin" | "platform_admin_scope" | "support">,
  activeOrg: ActiveOrg,
): boolean {
  if (escreveComoPlatformAdmin(authUser) && !authUser.support) return true;
  return ROLE_RANK[activeOrg.role] >= ROLE_RANK.admin;
}
