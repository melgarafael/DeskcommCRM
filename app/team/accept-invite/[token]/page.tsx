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
import { createClient } from "@/lib/supabase/server";
import { acceptInviteAction } from "@/app/actions/team/acceptInvite";

export const dynamic = "force-dynamic";

interface PageProps {
  params: Promise<{ token: string }>;
}

export default async function AcceptInvitePage({ params }: PageProps) {
  const { token } = await params;
  const payload = verifyInviteToken(token);

  if (!payload) {
    return (
      <Shell>
        <h1 className="text-xl font-semibold">Convite inválido ou expirado</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Este link não é válido ou já passou da janela de 24h. Peça um novo convite ao admin do tenant.
        </p>
      </Shell>
    );
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    const next = encodeURIComponent(`/team/accept-invite/${token}`);
    return (
      <Shell>
        <h1 className="text-xl font-semibold">Você foi convidado</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Para aceitar o convite como <strong>{payload.role}</strong>, faça login com o email{" "}
          <strong>{payload.email}</strong>.
        </p>
        <Link
          href={`/login?next=${next}`}
          className="mt-4 inline-block rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground"
        >
          Fazer login
        </Link>
      </Shell>
    );
  }

  const userEmail = (user.email ?? "").trim().toLowerCase();
  if (userEmail !== payload.email.trim().toLowerCase()) {
    return (
      <Shell>
        <h1 className="text-xl font-semibold">Email não corresponde</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Você está logado como <strong>{user.email}</strong>, mas o convite foi enviado para{" "}
          <strong>{payload.email}</strong>. Saia e faça login com o email correto.
        </p>
        <form action="/api/auth/signout" method="post" className="mt-4">
          <button
            type="submit"
            className="rounded-md border px-4 py-2 text-sm font-medium hover:bg-accent"
          >
            Sair
          </button>
        </form>
      </Shell>
    );
  }

  async function accept() {
    "use server";
    await acceptInviteAction(token);
  }

  return (
    <Shell>
      <h1 className="text-xl font-semibold">Aceitar convite</h1>
      <p className="mt-2 text-sm text-muted-foreground">
        Você foi convidado para entrar como <strong>{payload.role}</strong>. Confirme abaixo para
        ativar seu acesso.
      </p>
      <form action={accept} className="mt-4">
        <button
          type="submit"
          className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground"
        >
          Aceitar convite
        </button>
      </form>
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
