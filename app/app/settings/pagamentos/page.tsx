import { redirect } from "next/navigation";

import { requireAuth, resolveActiveOrg } from "@/lib/auth/server";
import { ROLE_RANK } from "@/lib/auth/types";
import { traduzir } from "@/lib/i18n/dicionario";
import { createClient } from "@/lib/supabase/server";
import { GatewayDaOrganizacaoClient, type GatewaySettingsRow } from "./_client";

export const dynamic = "force-dynamic";

/**
 * A tela lê a VIEW, nunca a tabela: `organization_payment_gateways_safe` omite as
 * sete colunas cifradas (`api_key_*`, `webhook_secret_*`), então nem uma consulta
 * montada com pressa consegue trazer ciphertext para o servidor de render. As
 * colunas são explícitas pelo mesmo motivo de `voip-trunk`: `select()` sem lista
 * pega o que a view ganhar amanhã, e a próxima coluna que alguém acrescentar não
 * passa por esta revisão.
 *
 * A linha daqui NÃO é o gateway em vigor — é só a configuração PRÓPRIA desta
 * organização, e pode nem existir (herança) ou estar desligada. Quem resolve a
 * herança é a rota (`GET /api/v1/pagamentos/gateway`), que é a única que sabe
 * qual é o provedor da instalação; esta página usa a linha apenas para o
 * formulário já abrir com o provedor e o `last4` certos, sem um piscar de campo
 * vazio.
 */
const SAFE_COLUMNS =
  "organization_id, provider, mode, api_key_last4, webhook_secret_last4, is_active";

export default async function PagamentosSettingsPage() {
  const user = await requireAuth();
  const activeOrg = await resolveActiveOrg(user);
  if (!activeOrg) redirect("/app");
  // `manager` VÊ (a tela de cobrança precisa saber qual provedor está em vigor);
  // quem ESCREVE é `admin`, e o cliente esconde os botões — a recusa de verdade
  // é da rota, com `requireRole("admin")`.
  if (ROLE_RANK[activeOrg.role] < ROLE_RANK.manager) {
    redirect("/403");
  }
  const idioma = user.idioma;

  const supabase = await createClient();
  const { data } = await supabase
    .from("organization_payment_gateways_safe")
    .select(SAFE_COLUMNS)
    .eq("organization_id", activeOrg.orgId)
    .maybeSingle();

  const canWrite = ROLE_RANK[activeOrg.role] >= ROLE_RANK.admin;

  return (
    <div className="flex h-full flex-col gap-6 p-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">
          {traduzir("Gateway de pagamento", idioma)}
        </h1>
        <p className="text-sm text-muted-foreground">
          {traduzir(
            "Com qual provedor esta organização cobra o cliente dela. A chave é conferida no provedor antes de ser gravada, fica cifrada e nunca volta para a tela — só os quatro últimos caracteres, e apenas os da chave desta organização.",
            idioma,
          )}
        </p>
      </header>
      <GatewayDaOrganizacaoClient
        initialRow={(data as GatewaySettingsRow | null) ?? null}
        canWrite={canWrite}
      />
    </div>
  );
}
