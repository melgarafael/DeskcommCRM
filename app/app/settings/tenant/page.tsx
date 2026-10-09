import { redirect } from "next/navigation";

import { requireAuth, resolveActiveOrg } from "@/lib/auth/server";
import { ROLE_RANK } from "@/lib/auth/types";
import { normalizarIdioma } from "@/lib/i18n/idiomas";
import { traduzir } from "@/lib/i18n/dicionario";
import { alineasDoArt15Visiveis, art15DoControlador } from "@/lib/legal/art15";
import { moedaServidaOu } from "@/lib/money";
import { createClient } from "@/lib/supabase/server";
import { Art15Form } from "./_art15";
import { ZonaDePerigoDaOrganizacao } from "./_danger-zone";
import { TenantForm } from "./_form";
import { InterfaceDaEmpresaForm } from "./_interface";

export const dynamic = "force-dynamic";

interface OrgRow {
  display_name: string;
  legal_name: string;
  cnpj: string | null;
  country: string | null;
  timezone: string;
  locale: string;
  currency: string;
  media_retention_days: number;
  media_retention_enforced: boolean;
  dpo_email: string | null;
  privacy_policy_url: string | null;
  /** Portas escolhidas pela EMPRESA (issue #1341). Opaco aqui: quem lê é `lerInterface`. */
  interface_settings: unknown;
  /** `settings` inteiro é lido aqui; para o cliente vai SÓ o bloco `art15`. */
  settings: unknown;
}

export default async function TenantSettingsPage() {
  const user = await requireAuth();
  const activeOrg = await resolveActiveOrg(user);
  if (!activeOrg) redirect("/app");
  if (!(user.is_platform_admin && !user.support) && ROLE_RANK[activeOrg.role] < ROLE_RANK.admin) {
    redirect("/403");
  }

  const supabase = await createClient();
  const { data } = await supabase
    .from("organizations")
    .select(
      "display_name, legal_name, cnpj, country, timezone, locale, currency, media_retention_days, media_retention_enforced, dpo_email, privacy_policy_url, interface_settings, settings",
    )
    .eq("id", activeOrg.orgId)
    .maybeSingle();

  const row = (data ?? null) as OrgRow | null;
  const idioma = user.idioma;
  // O bloco lido pela MESMA função que o relatório lê (`art15DoControlador`):
  // o que a tela mostra é o que o PDF vai imprimir, inclusive o `null` de quem
  // deixou a alínea em branco.
  const alineas = row ? art15DoControlador(row.settings) : null;

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
            // `null` na coluna é Brasil (migration 0277): o seletor não tem
            // opção vazia, então o país padrão aparece EXPLÍCITO. Salvar sem
            // trocar nada grava `BR` onde estava `null` — mesmo país, mesma
            // lei, mesmo calendário; o que muda é a linha deixar de depender
            // do default implícito.
            country: row.country ?? "BR",
            timezone: row.timezone,
            // `en-US` saiu da lista (nunca teve tradução). Uma linha antiga
            // com ele cai no padrão em vez de quebrar a tela.
            locale: normalizarIdioma(row.locale),
            currency: moedaServidaOu(row.currency),
            media_retention_days: row.media_retention_days,
            media_retention_enforced: row.media_retention_enforced,
            dpo_email: row.dpo_email,
            privacy_policy_url: row.privacy_policy_url,
          }}
        />
      )}
      {row && alineas && alineasDoArt15Visiveis(row.country) && (
        <Art15Form
          initial={{
            finalidades: alineas.finalidades ?? "",
            destinatarios: alineas.destinatarios ?? "",
            prazo_conservacao: alineas.prazo_conservacao ?? "",
          }}
        />
      )}
      {row && (
        <InterfaceDaEmpresaForm
          initial={row.interface_settings}
          role={activeOrg.role}
        />
      )}
      {row && <ZonaDePerigoDaOrganizacao displayName={row.display_name} />}
    </div>
  );
}
