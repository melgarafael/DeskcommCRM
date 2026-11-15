import { redirect } from "next/navigation";

import { requireAuth, resolveActiveOrg } from "@/lib/auth/server";
import { ROLE_RANK } from "@/lib/auth/types";
import { traduzir } from "@/lib/i18n/dicionario";
import { CriarUsuarioForm } from "./_components/CriarUsuarioForm";

export const dynamic = "force-dynamic";

/**
 * `/app/team/novo` — criar a pessoa SEM convite (#3876).
 *
 * Espelha `/app/team/invite` (mesmo guard de admin, mesma casca) porque são as
 * duas portas de entrada de gente na equipe: uma manda um e-mail, a outra cria
 * a conta aqui com a senha que quem administra digitar.
 */
export default async function TeamNovoUsuarioPage() {
  const user = await requireAuth();
  const activeOrg = await resolveActiveOrg(user);
  if (!activeOrg || ROLE_RANK[activeOrg.role] < ROLE_RANK.admin) {
    redirect("/403");
  }
  const idioma = user.idioma;
  const t = (texto: string) => traduzir(texto, idioma);

  return (
    <div className="flex h-full flex-col gap-6 p-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">{t("Criar usuário com senha")}</h1>
        <p className="text-sm text-muted-foreground">
          {t(
            "A conta já nasce pronta: você define a senha e a pessoa entra com ela. No primeiro acesso ela precisa escolher uma senha própria. Nenhum e-mail é enviado.",
          )}
        </p>
      </header>
      <CriarUsuarioForm />
    </div>
  );
}
