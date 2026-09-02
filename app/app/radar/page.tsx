import { redirect } from "next/navigation";

import { requireAuth, resolveActiveOrg } from "@/lib/auth/server";
import { traduzir } from "@/lib/i18n/dicionario";
import { RiskRadarList } from "./_components/RiskRadarList";

export const dynamic = "force-dynamic";

export default async function RadarPage() {
  const user = await requireAuth();
  const activeOrg = await resolveActiveOrg(user);
  if (!activeOrg) redirect("/app");
  // `t` local em vez do hook: esta página é componente de SERVIDOR, e lá o
  // idioma vem resolvido em `user.idioma` (a cadeia pessoa → organização →
  // padrão vive em `lib/auth/server.ts`), sem reler o `locale` cru.
  const idioma = user.idioma;
  const t = (texto: string) => traduzir(texto, idioma);

  return (
    /*
      Superficie clara — mesmo escopo das demais telas. `-m-6` cancela o respiro
      do `<main>` do AppShell para o Paper alcancar a borda, e o `p-6` que ja
      existia aqui o repoe.
    */
    <div
      data-superficie="clara"
      className="-m-6 flex min-h-[calc(100%+3rem)] flex-col gap-6 bg-bg p-6 text-text"
    >
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">{t("Radar de risco")}</h1>
        <p className="text-sm text-muted-foreground">
          {t(
            "Demandas abertas que esfriaram e precisam de você. Se o assistente já agendou um retorno, aparece como “em voo”; sem próximo passo, é risco de perder o cliente.",
          )}
        </p>
      </header>
      <RiskRadarList />
    </div>
  );
}
