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
 * `user_organizations.senha_provisoria` (migration 9227) só é escrita com
 * service-role — o app não tem caminho de escrita para ela.
 *
 * ─── Por que no vínculo, e não "no usuário" ───────────────────────────────
 *
 * Quem definiu a senha foi o admin de UMA empresa. A mesma pessoa pode ser
 * membro de outra organização por convite (fluxo que continua valendo) e ali
 * não deve nada a ninguém. O vínculo é a granularidade certa: a obrigação vale
 * onde o admin criou a conta.
 */

/** O código que o cliente usa para reconhecer a recusa e levar à tela de troca. */
export const CODIGO_SENHA_PROVISORIA = "password_change_required";

/** A frase que acompanha a recusa (traduzida por quem chama). */
export const MENSAGEM_SENHA_PROVISORIA =
  "Sua senha foi definida por quem administra a empresa. Troque-a para continuar.";

/**
 * A pessoa deve trocar a senha ANTES de usar esta organização?
 *
 * Sessão de acompanhamento (`support`) nunca é gated: quem está ali é o suporte
 * da instalação, não o membro obrigado a trocar a senha — e o vínculo lido é o
 * do usuário acompanhado, o que daria à pessoa errada a tela de troca.
 */
export function senhaProvisoriaPendente(
  user: Pick<AuthUser, "support" | "organizations">,
  organizationId: string,
): boolean {
  if (user.support) return false;
  // `organizations` é opcional no tipo e chega ausente em sessão sem vínculo
  // (e em qualquer mock de usuário). Ler `.some` direto aqui derrubava o layout
  // inteiro — 10 testes alheios caíram por causa disso no CI do #4120.
  return (user.organizations ?? []).some(
    (o) => o.organization_id === organizationId && o.senha_provisoria === true,
  );
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
