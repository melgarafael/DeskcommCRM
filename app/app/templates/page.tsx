import { redirect } from "next/navigation";
import { requireAuth, resolveActiveOrg } from "@/lib/auth/server";
import { traduzir } from "@/lib/i18n/dicionario";
import { ROLE_RANK } from "@/lib/auth/types";
import { TemplatesClient } from "./_components/TemplatesClient";

export const dynamic = "force-dynamic";

export default async function TemplatesPage() {
  const user = await requireAuth();
  const activeOrg = await resolveActiveOrg(user);
  if (!activeOrg) redirect("/app/inbox");
  const canShare = ROLE_RANK[activeOrg.role] >= ROLE_RANK.manager;
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
        {/* "Respostas rápidas", não "Templates": estes são scripts do atendente,
            consumidos pelo composer do inbox. O nome "Templates" pertence aos da
            Meta (HSM), em Canais, onde é o termo técnico correto. Duas telas com
            o mesmo nome e propósitos opostos confundiam. A URL não muda. */}
        <h1 className="text-2xl font-semibold tracking-tight">{t("Respostas rápidas")}</h1>
        <p className="text-sm text-muted-foreground">
          {t("Scripts salvos para responder mais rápido; pessoais ou compartilhados com a equipe.")}
        </p>
      </header>
      <TemplatesClient canShare={canShare} currentUserId={user.id} />
    </div>
  );
}
