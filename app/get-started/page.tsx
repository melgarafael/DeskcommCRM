import { redirect } from "next/navigation";

import { requireAuth, resolveActiveOrg } from "@/lib/auth/server";
import { createClient } from "@/lib/supabase/server";
import { branding } from "@/lib/branding";
import { RecoverOrganizationForm } from "@/components/auth/RecoverOrganizationForm";
import { traduzir } from "@/lib/i18n/dicionario";
import { IdiomaProvider } from "@/lib/i18n/IdiomaProvider";

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

  // O nome da empresa que a pessoa digitou no cadastro mora no `user_metadata`,
  // que `AuthUser` não carrega — e alargar `AuthUser` por causa de uma tela de
  // exceção sairia mais caro que esta leitura, que só acontece aqui. Vale para
  // quem chega pelo cadastro com confirmação de e-mail desligada: o campo já
  // vem preenchido em vez de pedir de novo o que ela acabou de informar.
  const supabase = await createClient();
  const {
    data: { user: authUser },
  } = await supabase.auth.getUser();
  const nomeSugerido = (authUser?.user_metadata?.org_name as string | undefined) ?? undefined;

  // Fora da árvore de `app/app/layout.tsx`, como as telas públicas: o idioma
  // vem do próprio usuário, e o formulário precisa do provider para o `useT()`.
  const t = (texto: string) => traduzir(texto, user.idioma);

  return (
    <IdiomaProvider locale={user.locale}>
      <main className="bg-muted/40 flex min-h-screen items-center justify-center px-4 py-10">
        <div className="w-full max-w-md space-y-6 rounded-lg border bg-background p-6 shadow-sm">
          <div className="space-y-2">
            <p className="text-xs uppercase tracking-wider text-muted-foreground">
              {branding().name}
            </p>
            <h1 className="text-2xl font-semibold tracking-tight">
              {t("Configure sua organização")}
            </h1>
            <p className="text-sm leading-relaxed text-muted-foreground">
              {t(
                "Sua conta foi confirmada, mas a organização inicial ainda não foi criada. Informe o nome da sua empresa para concluir o primeiro acesso e abrir o onboarding do CRM.",
              )}
            </p>
          </div>
          <RecoverOrganizationForm nomeSugerido={nomeSugerido} />
          <p className="text-xs leading-relaxed text-muted-foreground">
            {t(
              "Se você recebeu um convite, não crie uma organização nova. Use o link do convite ou peça ao administrador para reenviá-lo.",
            )}
          </p>
        </div>
      </main>
    </IdiomaProvider>
  );
}
