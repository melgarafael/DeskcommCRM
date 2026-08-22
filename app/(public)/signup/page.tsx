import Link from "next/link";

import { SignupForm } from "@/components/auth/SignupForm";
import { branding } from "@/lib/branding";
import { verifyInviteToken } from "@/lib/auth/invite-token";

export const metadata = { title: "Criar conta" };

/**
 * Aceita `?invite=<token>`: é o caminho de quem foi convidado e ainda não tem
 * conta. Sem isso, essa pessoa criava uma conta comum, e o provisionamento —
 * sem encontrar vínculo nenhum — abria uma organização e a tornava admin dela.
 *
 * O token só é lido aqui para MONTAR a tela (esconder o nome da empresa, travar
 * o e-mail). Quem decide o que ele vale é o servidor, duas vezes: ao criar a
 * conta e ao confirmar o e-mail.
 */
export default async function SignupPage({
  searchParams,
}: {
  searchParams: Promise<{ invite?: string; plan?: string }>;
}) {
  const { invite, plan } = await searchParams;
  const payload = invite ? verifyInviteToken(invite) : null;
  const convite = invite && payload ? { token: invite, email: payload.email } : undefined;
  const conviteExpirado = Boolean(invite) && !payload;

  return (
    <div className="space-y-6">
      <div className="space-y-1.5 text-center">
        <h1 className="text-2xl font-semibold tracking-tight">Criar conta</h1>
        <p className="text-sm text-muted-foreground">
          {convite
            ? "Crie sua senha para entrar na empresa que te convidou"
            : `Comece a usar o ${branding().name} em minutos`}
        </p>
      </div>

      {conviteExpirado && (
        <p
          role="alert"
          className="rounded-md border border-amber-300/60 bg-amber-50 px-4 py-3 text-sm dark:border-amber-500/30 dark:bg-amber-950/20"
        >
          Esse convite expirou ou não é mais válido. Peça um novo a quem te convidou — criar uma
          conta agora abriria uma empresa nova, e não é isso que você quer.
        </p>
      )}

      <SignupForm convite={convite} planId={!convite ? plan : undefined} />

      <p className="text-center text-sm text-muted-foreground">
        Já tem conta?{" "}
        <Link href="/login" className="font-medium text-foreground underline underline-offset-4">
          Entrar
        </Link>
      </p>
    </div>
  );
}
