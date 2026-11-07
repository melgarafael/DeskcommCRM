import { redirect } from "next/navigation";

import { TrocaSenhaProvisoriaForm } from "@/components/auth/TrocaSenhaProvisoriaForm";
import { createClient } from "@/lib/supabase/server";
import { idiomaDoVisitante } from "@/lib/i18n/idiomaAnonimo";
import { traduzir } from "@/lib/i18n/dicionario";
import { tituloDaTelaPublica } from "@/lib/i18n/titulo-da-tela-publica";

/**
 * `/trocar-senha` — a única tela que a pessoa criada sem convite pode ver antes
 * de escolher a própria senha (#3876).
 *
 * Mora FORA de `/app` de propósito: o layout de `/app` é quem manda para cá
 * enquanto `senha_provisoria` for `true`, e uma tela dentro dele redirecionaria
 * para si mesma.
 *
 * Sem sessão não há o que trocar — a tela é para quem ACABOU de entrar, e quem
 * não entrou volta ao login como em qualquer página autenticada.
 */
export const dynamic = "force-dynamic";

export const generateMetadata = () => tituloDaTelaPublica((t) => t("Trocar senha"));

export default async function TrocarSenhaPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const idioma = await idiomaDoVisitante(
    (user.user_metadata?.locale as string | undefined) ?? null,
  );
  const t = (texto: string) => traduzir(texto, idioma);

  return (
    <div className="space-y-6">
      <div className="space-y-1.5 text-center">
        <h1 className="text-2xl font-semibold tracking-tight">{t("Trocar senha")}</h1>
        <p className="text-sm text-muted-foreground">
          {t(
            "Sua senha foi definida por quem administra a empresa. Escolha uma senha só sua para continuar.",
          )}
        </p>
      </div>
      <TrocaSenhaProvisoriaForm />
    </div>
  );
}
