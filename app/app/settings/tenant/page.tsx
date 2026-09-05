import { redirect } from "next/navigation";

import { requireAuth, resolveActiveOrg } from "@/lib/auth/server";
import { ROLE_RANK } from "@/lib/auth/types";
import { traduzir } from "@/lib/i18n/dicionario";
import { moedaServidaOu } from "@/lib/money";
import { createClient } from "@/lib/supabase/server";
import { ZonaDePerigoDaOrganizacao } from "./_danger-zone";
import { TenantForm } from "./_form";

export const dynamic = "force-dynamic";

interface OrgRow {
  display_name: string;
  legal_name: string;
  cnpj: string | null;
  timezone: string;
  locale: string;
  currency: string;
  media_retention_days: number;
  dpo_email: string | null;
  privacy_policy_url: string | null;
  settings: Record<string, unknown> | null;
}

export default async function TenantSettingsPage() {
  const user = await requireAuth();
  const activeOrg = await resolveActiveOrg(user);
  if (!activeOrg) redirect("/app");
  if (!user.is_platform_admin && ROLE_RANK[activeOrg.role] < ROLE_RANK.admin) {
    redirect("/403");
  }

  const supabase = await createClient();
  const { data } = await supabase
    .from("organizations")
    .select(
      "display_name, legal_name, cnpj, timezone, locale, currency, media_retention_days, dpo_email, privacy_policy_url, settings",
    )
    .eq("id", activeOrg.orgId)
    .maybeSingle();

  const row = (data ?? null) as OrgRow | null;
  const lostReasonsExtra =
    (row?.settings && Array.isArray((row.settings as { lost_reasons_extra?: unknown }).lost_reasons_extra)
      ? ((row.settings as { lost_reasons_extra?: string[] }).lost_reasons_extra ?? [])
      : []) as string[];
  const idioma = user.idioma;

  return (
    <div className="flex h-full flex-col gap-6 p-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">{traduzir("Organização", idioma)}</h1>
        <p className="text-sm text-muted-foreground">
          {traduzir("Dados da empresa, retenção de mídia, DPO. Admin only.", idioma)}
        </p>
      </header>
      {row && (
        <TenantForm
          initial={{
            display_name: row.display_name,
            legal_name: row.legal_name,
            cnpj: row.cnpj,
            timezone: row.timezone,
            // `en-US` saiu da lista (nunca teve tradução). Uma linha antiga
            // com ele cai no padrão em vez de quebrar a tela.
            locale: row.locale === "es" ? "es" : "pt-BR",
            currency: moedaServidaOu(row.currency),
            media_retention_days: row.media_retention_days,
            dpo_email: row.dpo_email,
            privacy_policy_url: row.privacy_policy_url,
            lost_reasons_extra: lostReasonsExtra,
          }}
        />
      )}
      {row && <ZonaDePerigoDaOrganizacao displayName={row.display_name} />}
    </div>
  );
}
