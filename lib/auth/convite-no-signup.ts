/**
 * Quem acabou de confirmar o e-mail: alguém abrindo a própria empresa, ou
 * alguém que foi CONVIDADO para uma que já existe?
 *
 * O convite não tem linha em tabela nenhuma — é um token HMAC auto-contido. E o
 * aceite exige sessão. Então quem é convidado e ainda não tem conta precisa
 * criar uma, e nesse instante `ensureTenantForUser` não encontra vínculo algum
 * e faz o que faria com qualquer visitante novo: cria uma organização e o torna
 * ADMIN dela. A pessoa termina com uma empresa fantasma, um wizard de
 * onboarding que não é dela e o gate de MFA de administrador — e só depois, se
 * voltar ao link dentro das 24h, entra na empresa certa, ficando nas duas.
 *
 * Este módulo é o ponto onde essa bifurcação passa a existir. É uma função
 * PURA de propósito: a propriedade que ela carrega é de segurança, e precisa
 * ser testável sem banco, dentro do gate obrigatório.
 *
 * ⚠️ `user_metadata` é gravável pelo próprio usuário (`updateUser({data})` com a
 * anon key, do navegador). Nada que venha de lá é autoridade: quem manda é a
 * assinatura HMAC do token MAIS a comparação com o e-mail que o provedor de
 * auth acabou de confirmar. Sem essa comparação, qualquer um colaria num signup
 * próprio um token de convite alheio e entraria na organização da vítima.
 */
import { verifyInviteToken, type InvitePayload } from "@/lib/auth/invite-token";

export type DecisaoDeSignup =
  /** Foi convidado: NÃO provisionar organização; mandar para o aceite. */
  | { tipo: "convite"; token: string; payload: InvitePayload }
  /** Ninguém o convidou: caminho normal, ganha a própria organização. */
  | { tipo: "provisionar" }
  /** Havia convite e ele não vale. Não provisiona — ver abaixo. */
  | { tipo: "recusar"; motivo: "token_invalido" | "email_divergente" };

interface UsuarioConfirmado {
  email?: string | null;
  user_metadata?: Record<string, unknown> | null;
}

function normalizar(email: string | null | undefined): string {
  return (email ?? "").trim().toLowerCase();
}

export function decidirConviteDoSignup(
  user: UsuarioConfirmado,
  /**
   * Convite vindo de FORA do `user_metadata` — hoje, o que o `/auth/callback`
   * leu da URL na volta do Google.
   *
   * ⚠️ Não é mais confiável que o `user_metadata`: os dois chegam das mãos de
   * quem está entrando. O que autoriza é o que vem DEPOIS — a assinatura HMAC
   * do token e a comparação com o e-mail que o provedor de auth confirmou —, e
   * essas duas provas valem igual para as duas origens. É por isso que este
   * parâmetro pode existir sem afrouxar nada.
   */
  tokenDoConvite?: string | null,
): DecisaoDeSignup {
  const bruto = tokenDoConvite?.trim() || user.user_metadata?.["invite_token"];
  // Sem convite em jogo: o caminho de sempre, intocado.
  if (typeof bruto !== "string" || bruto.trim() === "") return { tipo: "provisionar" };

  const payload = verifyInviteToken(bruto);
  // FALHA FECHADA. Token expirado ou adulterado NÃO pode cair no provisionamento:
  // o convite dura 24h e o link de confirmação de e-mail tem prazo próprio, então
  // quem demora entre "criar conta" e "confirmar e-mail" reproduziria o defeito
  // original — agora com um conserto por cima dando a impressão de resolvido.
  if (!payload) return { tipo: "recusar", motivo: "token_invalido" };

  // A autoridade: o e-mail do convite tem de ser o e-mail que o provedor de auth
  // confirmou. Sem isto, o token de outra pessoa vira porta de entrada.
  if (normalizar(payload.email) !== normalizar(user.email)) {
    return { tipo: "recusar", motivo: "email_divergente" };
  }

  return { tipo: "convite", token: bruto, payload };
}
