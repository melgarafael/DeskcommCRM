/**
 * Cria (ou reaproveita) o customer Asaas de um tenant, e a linha local de
 * organization_subscriptions que amarra os dois.
 *
 * DIRC: o CNPJ vem de `organizations.cnpj` (já existe, doutrina proíbe
 * duplicar). Chamador garante que está preenchido antes de invocar — este
 * módulo não valida formato de CNPJ, só recusa string vazia.
 */
import { createAdminClient } from "@/lib/supabase/admin";
import { asaasClient } from "./client";
import { isBillingEnabled, BillingDisabledError } from "./config";

interface CreateCustomerInput {
  organizationId: string;
  legalName: string;
  email?: string;
  cnpj: string;
}

/**
 * Cria o customer na Asaas e a linha `organization_subscriptions` em
 * status='incomplete' (a assinatura em si vem depois, em subscriptions.ts —
 * separar as duas chamadas deixa o caller decidir plano só quando o customer
 * já existe, sem reconstruir o payload inteiro).
 */
export async function ensureAsaasCustomer(input: CreateCustomerInput): Promise<string> {
  if (!isBillingEnabled()) throw new BillingDisabledError();

  const admin = createAdminClient();
  const { data: existing } = await admin
    .from("organization_subscriptions")
    .select("asaas_customer_id")
    .eq("organization_id", input.organizationId)
    .maybeSingle();

  if (existing?.asaas_customer_id) return existing.asaas_customer_id;

  const customer = await asaasClient.createCustomer({
    name: input.legalName,
    email: input.email,
    cpfCnpj: input.cnpj,
  });

  return customer.id;
}
