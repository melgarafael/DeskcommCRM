import type { AuthUser } from "@/lib/auth/types";

/**
 * "Esta pessoa entrou com a senha que quem administra definiu" — o sinal que
 * obriga a troca no primeiro acesso (#3876).
 *
 * ─── Por que o sinal mora no VÍNCULO e não no auth ────────────────────────
 *
 * `auth.users.user_metadata` é escrita pelo PRÓPRIO usuário (o `updateUser` do
 * GoTrue, com o token da própria sessão). Um gate apoiado nela seria desarmado
 * pela pessoa obrigada a trocar a senha, sem nem precisar de tela: uma chamada
 * ao GoTrue com o token da sessão apaga a marca. A coluna
 * `user_organizations.senha_provisoria` (migration 9380) só é escrita com
 * service-role — o app não tem caminho de escrita para ela.
 *
 * ─── Por que a OBRIGAÇÃO é da pessoa, e não de um vínculo só ──────────────
 *
 * A marca é gravada no vínculo onde a conta nasceu, mas o gate vale para a
 * SESSÃO inteira enquanto qualquer vínculo estiver marcado. Quem criou a conta
 * conhece a senha provisória: se a obrigação fosse por vínculo, a pessoa (ou
 * quem soubesse a senha) aceitaria um convite de OUTRA empresa ainda com a
 * senha provisória, e nessa empresa entraria livre — com uma senha que outra
 * pessoa conhece. A troca (`trocarSenhaProvisoria`) já apaga a marca de todos
 * os vínculos de uma vez, então a regra é a mesma nos dois lados.
 */

/** O código que o cliente usa para reconhecer a recusa e levar à tela de troca. */
export const CODIGO_SENHA_PROVISORIA = "password_change_required";

/** A frase que acompanha a recusa (traduzida por quem chama). */
export const MENSAGEM_SENHA_PROVISORIA =
  "Sua senha foi definida por quem administra a empresa. Troque-a para continuar.";

/**
 * A pessoa deve trocar a senha ANTES de usar o produto?
 *
 * Sessão de acompanhamento (`support`) nunca é gated: quem está ali é o suporte
 * da instalação, não o membro obrigado a trocar a senha — e o vínculo lido é o
 * do usuário acompanhado, o que daria à pessoa errada a tela de troca.
 */
export function senhaProvisoriaPendente(
  user: Pick<AuthUser, "support" | "organizations">,
): boolean {
  return organizacoesComSenhaProvisoria(user).length > 0;
}

/** Qualquer organização ativa com a marca — o que a tela de troca consulta. */
export function organizacoesComSenhaProvisoria(
  user: Pick<AuthUser, "support" | "organizations">,
): string[] {
  if (user.support) return [];
  return (user.organizations ?? [])
    .filter((o) => o.senha_provisoria === true)
    .map((o) => o.organization_id);
}
