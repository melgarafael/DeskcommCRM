import type { SupabaseClient } from "@supabase/supabase-js";
import { decryptWebhookSecret } from "@/lib/webhooks/secrets";
import {
  lerConexaoGoogleParaApi,
  normalizarIdLegado,
  type ConexaoGoogleParaApi,
  type RespostaDaApiGoogle,
} from "./api-google-ads";

export interface ContaDeRelatorio {
  customerId: string;
  label: string;
  loginCustomerId: string | null;
  propria: boolean;
}

/** O seletor precisa apenas de identificadores. A credencial só é lida na consulta da conta escolhida. */
export async function listarContasDeRelatorio(admin: SupabaseClient, orgId: string) {
  const [proprias, legado] = await Promise.all([
    admin.from("google_ads_reporting_accounts")
      .select("customer_id,label,login_customer_id").eq("organization_id", orgId)
      .order("label").order("customer_id"),
    admin.from("ad_platform_connections")
      .select("google_customer_id,google_login_customer_id")
      .eq("organization_id", orgId).eq("platform", "google_ads")
      .not("google_refresh_token_encrypted", "is", null).maybeSingle(),
  ]);
  if (proprias.error || legado.error) {
    return { ok: false as const, detalhe: "Não foi possível carregar as contas de relatório." };
  }
  const contas: ContaDeRelatorio[] = (proprias.data ?? []).map((linha) => ({
    customerId: linha.customer_id, label: linha.label, loginCustomerId: linha.login_customer_id, propria: true,
  }));
  const contaAntiga = normalizarIdLegado(legado.data?.google_customer_id ?? "");
  if (/^\d{10}$/.test(contaAntiga) && !contas.some((conta) => conta.customerId === contaAntiga)) {
    const gerente = normalizarIdLegado(legado.data?.google_login_customer_id ?? "");
    contas.unshift({ customerId: contaAntiga, label: contaAntiga, loginCustomerId: gerente || null, propria: false });
  }
  return { ok: true as const, contas };
}

export async function lerContaDeRelatorio(
  admin: SupabaseClient, orgId: string, customerId: string,
): Promise<RespostaDaApiGoogle<ConexaoGoogleParaApi>> {
  const { data, error } = await admin.from("google_ads_reporting_accounts")
    .select("customer_id,login_customer_id,refresh_token_encrypted")
    .eq("organization_id", orgId).eq("customer_id", customerId).maybeSingle();
  if (error) return { ok: false, falha: "transitorio", detalhe: "Leitura da conexão falhou." };
  // Um ID informado pelo navegador nunca pode redirecionar o token legado para outra conta.
  if (!data) return lerConexaoGoogleParaApi(admin, orgId, customerId);
  const refreshToken = await decryptWebhookSecret(admin, data.refresh_token_encrypted);
  if (!refreshToken) return { ok: false, falha: "cifra_indisponivel", detalhe: "Não foi possível abrir a credencial desta conta." };
  return { ok: true, dados: { customerId: data.customer_id, loginCustomerId: data.login_customer_id, refreshToken } };
}
