import { redirect } from "next/navigation";
import { requireAuth, resolveActiveOrg } from "@/lib/auth/server";
import { ROLE_RANK } from "@/lib/auth/types";
import { traduzir } from "@/lib/i18n/dicionario";
import { WebhooksClient } from "./_components/WebhooksClient";

export const dynamic = "force-dynamic";

export default async function WebhooksPage() {
  const user = await requireAuth();
  const activeOrg = await resolveActiveOrg(user);
  const canManage = !!activeOrg && ROLE_RANK[activeOrg.role] >= ROLE_RANK.manager;
  if (!canManage) redirect("/app/inbox");
  const idioma = user.idioma;

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
        <h1 className="text-2xl font-semibold tracking-tight">Webhooks</h1>
        <p className="text-sm text-muted-foreground">
          {traduzir(
            "Receba contatos de fora (landing pages, formulários) e crie automações que agem sozinhas.",
            idioma,
          )}
        </p>
      </header>
      <WebhooksClient />
    </div>
  );
}
