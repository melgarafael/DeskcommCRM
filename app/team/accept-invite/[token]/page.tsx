/**
 * /team/accept-invite/[token] — public route (added to PUBLIC_PATHS).
 *
 * Behavior matrix:
 *  - Invalid/expired token         → render error
 *  - Unauthenticated user          → render CTA → /login?next=...
 *  - Authenticated, email mismatch → render mismatch + sign-out CTA
 *  - Authenticated, email match    → form posts to Server Action which inserts
 *                                    membership and redirects to /app/inbox
 */
import Link from "next/link";

import { verifyInviteToken } from "@/lib/auth/invite-token";
import { authRateLimited, AUTH_LIMITS } from "@/lib/auth/rate-limit";
import { createClient } from "@/lib/supabase/server";
import { AcceptInviteForm } from "./AcceptInviteForm";
import { normalizarIdioma } from "@/lib/i18n/idiomas";
import { traduzir } from "@/lib/i18n/dicionario";

export const dynamic = "force-dynamic";

interface PageProps {
  params: Promise<{ token: string }>;
}

export default async function AcceptInvitePage({ params }: PageProps) {
  const { token } = await params;

  // Rota pública, fora da árvore de `app/app/layout.tsx` — sem `IdiomaProvider`,
  // então resolve o idioma direto, como `admin/forbidden/page.tsx`. Buscado
  // ANTES do teto de tentativas e da validação do token porque toda ramificação
  // abaixo (inclusive as de erro) precisa do mesmo idioma — quem ainda não tem
  // conta cai no ramo sem `user` e cai no idioma padrão.
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  const idioma = normalizarIdioma(
    (user?.user_metadata?.locale as string | undefined) ?? null,
  );
  const t = (texto: string) => traduzir(texto, idioma);

  // O gargalo de enumeração é AQUI, não no aceite: a rota é pública e cada
  // GET testa um token. Sem teto, varrer o espaço de tokens sai de graça
  // (issue #64). Barrar antes de verificar mantém a resposta indistinguível
  // entre token válido e inválido para quem está varrendo.
  if (await authRateLimited("invite_accept", null, AUTH_LIMITS.invite_accept)) {
    return (
      <Shell>
        <h1 className="text-xl font-semibold">{t("Muitas tentativas")}</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          {t("Aguarde alguns minutos e abra o link do convite de novo.")}
        </p>
      </Shell>
    );
  }

  const payload = verifyInviteToken(token);

  if (!payload) {
    return (
      <Shell>
        <h1 className="text-xl font-semibold">{t("Convite inválido ou expirado")}</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          {t(
            "Este link não é válido ou já passou da janela de 24h. Peça um novo convite ao admin do tenant.",
          )}
        </p>
      </Shell>
    );
  }

  if (!user) {
    const next = encodeURIComponent(`/team/accept-invite/${token}`);
    return (
      <Shell>
        <h1 className="text-xl font-semibold">{t("Você foi convidado")}</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          {t("Para aceitar o convite como")} <strong>{payload.role}</strong>,{" "}
          {t("faça login com o email")} <strong>{payload.email}</strong>.
        </p>
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <Link
            href={`/login?next=${next}`}
            className="inline-block rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground"
          >
            {t("Fazer login")}
          </Link>
          {/*
            O caminho que faltava. Quem é convidado e ainda NÃO tem conta só
            tinha "Fazer login" — então criava conta pelo caminho comum, e o
            provisionamento, sem achar vínculo, abria uma empresa e o tornava
            admin dela. O token viaja no link para que a conta nova já nasça
            amarrada a este convite.
          */}
          <Link
            href={`/signup?invite=${encodeURIComponent(token)}`}
            className="text-sm underline underline-offset-4"
          >
            {t("Ainda não tenho conta")}
          </Link>
        </div>
      </Shell>
    );
  }

  const userEmail = (user.email ?? "").trim().toLowerCase();
  if (userEmail !== payload.email.trim().toLowerCase()) {
    return (
      <Shell>
        <h1 className="text-xl font-semibold">{t("Email não corresponde")}</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          {t("Você está logado como")} <strong>{user.email}</strong>,{" "}
          {t("mas o convite foi enviado para")} <strong>{payload.email}</strong>.{" "}
          {t("Saia e faça login com o email correto.")}
        </p>
        <form action="/api/auth/signout" method="post" className="mt-4">
          <button
            type="submit"
            className="rounded-md border px-4 py-2 text-sm font-medium hover:bg-accent"
          >
            {t("Sair")}
          </button>
        </form>
      </Shell>
    );
  }

  return (
    <Shell>
      <h1 className="text-xl font-semibold">{t("Aceitar convite")}</h1>
      <p className="mt-2 text-sm text-muted-foreground">
        {t("Você foi convidado para entrar como")} <strong>{payload.role}</strong>.{" "}
        {t("Confirme abaixo para ativar seu acesso.")}
      </p>
      <AcceptInviteForm token={token} label={t("Aceitar convite")} pendingLabel={t("Confirmando…")} failureLabel={t("Não foi possível aceitar este convite. Ele pode ter vencido ou seu acesso foi revogado. Peça um novo link ao administrador.")} />
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen items-center justify-center p-6">
      <div className="w-full max-w-md rounded-lg border bg-card p-8 shadow-sm">{children}</div>
    </div>
  );
}
