import Link from "next/link";

import { Button } from "@/components/ui/button";
import { createClient } from "@/lib/supabase/server";
import { idiomaDoVisitante } from "@/lib/i18n/idiomaAnonimo";
import { traduzir } from "@/lib/i18n/dicionario";

export const metadata = { title: "Confirmar acesso" };

/**
 * Parada dos links de e-mail (recuperação, convite, confirmação de cadastro).
 *
 * `/auth/confirm` não gasta mais o `token_hash` no GET: verificadores de link
 * (Safe Links do Hotmail/Outlook, gateways de e-mail corporativos) abrem o link
 * na entrega e ficavam com o token de uso único antes da pessoa. Esta tela só
 * devolve o token num formulário; quem o gasta é o POST do botão, que nenhum
 * verificador aperta. Sem JavaScript de propósito: o botão funciona em qualquer
 * navegador, inclusive o embutido do app de e-mail.
 */
export default async function ContinuarPage({
  searchParams,
}: {
  searchParams: Promise<{ token_hash?: string; type?: string }>;
}) {
  const { token_hash: tokenHash, type } = await searchParams;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  const idioma = await idiomaDoVisitante((user?.user_metadata?.locale as string | undefined) ?? null);
  const t = (texto: string) => traduzir(texto, idioma);

  if (!tokenHash || !type) {
    return (
      <div className="space-y-6 text-center">
        <h1 className="text-2xl font-semibold tracking-tight">{t("Link inválido ou incompleto")}</h1>
        <p className="text-sm text-muted-foreground">{t("Peça um novo link para continuar.")}</p>
        <Link href="/login/forgot" className="text-sm font-medium text-foreground underline underline-offset-4">
          {t("Recuperar senha")}
        </Link>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="space-y-1.5 text-center">
        <h1 className="text-2xl font-semibold tracking-tight">{t("Confirmar acesso")}</h1>
        <p className="text-sm text-muted-foreground">
          {t("Para sua segurança, confirme que foi você quem abriu este link.")}
        </p>
      </div>
      <form method="post" action="/auth/confirm">
        <input type="hidden" name="token_hash" value={tokenHash} />
        <input type="hidden" name="type" value={type} />
        <Button type="submit" className="w-full">
          {t("Continuar")}
        </Button>
      </form>
    </div>
  );
}
