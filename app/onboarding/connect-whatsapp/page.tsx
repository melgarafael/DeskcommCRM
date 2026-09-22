import { requireAuth, resolveActiveOrg } from "@/lib/auth/server";
import { redirect } from "next/navigation";
import { metaPodeReceber } from "@/lib/channels/meta/webhook";
import { getWahaClient } from "@/lib/waha/client";
import { ConnectWhatsappClient } from "./_client";
import { traduzir } from "@/lib/i18n/dicionario";

export const dynamic = "force-dynamic";

export default async function ConnectWhatsappPage() {
  const user = await requireAuth();
  const activeOrg = await resolveActiveOrg(user);
  if (!activeOrg) redirect("/login");
  const idioma = user.idioma;

  const wahaConfigured = getWahaClient() !== null;

  // Receber pelo canal oficial exige DOIS segredos, não um — a regra e o porquê
  // moram em `lib/channels/meta/webhook.ts`, ao lado de quem os consome.
  const oficialPodeReceber = metaPodeReceber();
  // We don't try to start the session at SSR — client kicks off the call
  // (and shows graceful banner if WAHA is not reachable).

  return (
    <div className="space-y-6">
      <header>
        <h2 className="text-2xl font-medium text-text tracking-tight">{traduzir("Dê um telefone a ele", idioma)}</h2>
        <p className="text-sm text-muted-foreground">
          {traduzir(
            "É por este número que ele vai atender seus clientes. Se você conecta pelo celular, tenha ele por perto.",
            idioma,
          )}
        </p>
      </header>
      <ConnectWhatsappClient
        wahaConfigured={wahaConfigured}
        sessionName={`org_${activeOrg.orgId.slice(0, 8)}`}
        oficialPodeReceber={oficialPodeReceber}
      />
    </div>
  );
}
