import { redirect } from "next/navigation";

import { createClient } from "@/lib/supabase/server";
import { MfaForm } from "@/components/auth/MfaForm";
import { normalizarIdioma } from "@/lib/i18n/idiomas";
import { traduzir } from "@/lib/i18n/dicionario";
import { FachadaCentrada } from "@/components/auth/FachadaCentrada";

export const metadata = { title: "Verificação em duas etapas" };

export default async function MfaChallengePage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  const { next } = await searchParams;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { data: factorsData } = await supabase.auth.mfa.listFactors();
  const hasVerified = !!factorsData?.totp?.some((f) => f.status === "verified");
  if (!hasVerified) redirect("/app/inbox");

  const idioma = normalizarIdioma(
    (user.user_metadata?.locale as string | undefined) ?? null,
  );
  const t = (texto: string) => traduzir(texto, idioma);

  return (
    <FachadaCentrada>
      <div className="space-y-6">
        <div className="space-y-1.5 text-center">
          <h1 className="text-2xl font-semibold tracking-tight">{t("Verificação em duas etapas")}</h1>
          <p className="text-sm text-muted-foreground">
            {t("Digite o código de 6 dígitos do seu autenticador.")}
          </p>
        </div>
        <MfaForm next={next} />
      </div>
    </FachadaCentrada>
  );
}
