import { redirect } from "next/navigation";

import { requireAuth, resolveActiveOrg } from "@/lib/auth/server";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * A saída do beco: quem confirmou o e-mail e ficou sem organização termina o
 * primeiro acesso aqui. Ver `app/actions/auth/recoverOrganization.ts` para o
 * defeito inteiro.
 *
 * FORA de `app/app/**`, como `/login` e `/team/accept-invite` — por isso não
 * entra em `lib/navigation/registry.ts` nem na allowlist de
 * `tests/unit/navegacao-completude.test.ts`, cujo escopo é a navegação do
 * tenant. As portas são os três desvios que levam até aqui: os dois de
 * `app/onboarding/` e o estado vazio do Inbox.
 */
export const dynamic = "force-dynamic";

export default async function GetStartedPage() {
  const user = await requireAuth();
  const activeOrg = await resolveActiveOrg(user);
  // Quem já tem organização não passa por aqui: sem isto, a tela viraria um
  // "abra outra empresa" alcançável por quem digitasse a URL.
  if (activeOrg) redirect("/app/inbox");

  const admin = createAdminClient();
  const { data: request } = await admin.from("registration_requests").select("id")
    .eq("user_id", user.id).eq("status", "pending").limit(1).maybeSingle();
  if (request) redirect("/cadastro/aguardando");
  redirect("/login?error=acesso_sem_empresa");
}
