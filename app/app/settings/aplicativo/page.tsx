import { requireAuth } from "@/lib/auth/server";
import { traduzir } from "@/lib/i18n/dicionario";
import { AplicativoNoCelular } from "./_client";

export const dynamic = "force-dynamic";

/**
 * Instalar o sistema no celular (ADR-0006, fase F1).
 *
 * O servidor não sabe em que aparelho, navegador ou endereço a pessoa está —
 * tudo o que decide o passo a passo é lido no cliente, depois de montar.
 */
export default async function AplicativoPage() {
  const user = await requireAuth();
  const t = (texto: string) => traduzir(texto, user.idioma);
  return (
    <div className="flex h-full flex-col gap-6 p-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">{t("App no celular")}</h1>
        <p className="text-sm text-muted-foreground">
          {t("Instale o sistema na tela de início do celular e receba os avisos.")}
        </p>
      </header>
      <AplicativoNoCelular />
    </div>
  );
}
