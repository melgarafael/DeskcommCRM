import { redirect } from "next/navigation";
import { requireAuth, resolveActiveOrg } from "@/lib/auth/server";
import { ROLE_RANK } from "@/lib/auth/types";
import { traduzir } from "@/lib/i18n/dicionario";
import { createAdminClient } from "@/lib/supabase/admin";
import { buscarLogsRecentesBling, obterConfiguracaoBling } from "@/lib/integrations/bling/store";
import { BlingConfigClient } from "./_form";

export const metadata = { title: "Bling ERP" };
export const dynamic = "force-dynamic";

export default async function BlingSettingsPage() {
  const user = await requireAuth();
  const activeOrg = await resolveActiveOrg(user);
  if (!activeOrg) redirect("/app");

  if (!(user.is_platform_admin && !user.support) && ROLE_RANK[activeOrg.role] < ROLE_RANK.admin) {
    redirect("/403");
  }

  const admin = createAdminClient();
  const config = await obterConfiguracaoBling(admin, activeOrg.orgId);
  const logs = await buscarLogsRecentesBling(admin, activeOrg.orgId, 10);

  const idioma = user.idioma;
  const t = (texto: string) => traduzir(texto, idioma);

  return (
    <div className="flex h-full flex-col gap-6 overflow-y-auto p-6 max-w-5xl">
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">{t("Bling ERP")}</h1>
        <p className="text-sm text-muted-foreground">
          {t(
            "Integre seu CRM ao Bling para sincronizar pedidos, consultar estoques em tempo real e emitir notas fiscais de forma modular e segura.",
          )}
        </p>
      </header>

      <div className="rounded-md border border-amber-500/30 bg-amber-500/10 p-4 text-sm text-amber-200/90 leading-relaxed">
        {t(
          "A integração é 100% modular. Você pode ligar ou desligar cada funcionalidade individualmente. Nenhuma ação fiscal é executada sem a chave de notas estar explicitamente ativada.",
        )}
      </div>

      <BlingConfigClient
        initialConfig={config}
        initialLogs={logs}
        idioma={idioma}
      />
    </div>
  );
}
