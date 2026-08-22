import { requireAuth, resolveActiveOrg } from "@/lib/auth/server";
import { ROLE_RANK } from "@/lib/auth/types";
import { createAdminClient } from "@/lib/supabase/admin";
import { NovaEmpresaForm, ListaDeEmpresas, type ClientCompanyRow } from "./_client";

export const dynamic = "force-dynamic";
export const metadata = { title: "Empresas — Contabilidade" };

/**
 * Fundação do módulo Contábil (ADR-0002, Fase 5). Lista as empresas que o
 * escritório (tenant) atende — cada uma leva ao próprio plano de contas e
 * lançamentos em /app/contabilidade/empresas/[id].
 */
export default async function EmpresasPage() {
  const user = await requireAuth();
  const activeOrg = await resolveActiveOrg(user);
  const canWrite = Boolean(activeOrg && ROLE_RANK[activeOrg.role] >= ROLE_RANK.manager);

  const admin = createAdminClient();
  const { data } = activeOrg
    ? await admin
        .from("accounting_client_companies")
        .select("id, legal_name, trade_name, cnpj, tax_regime, status")
        .eq("organization_id", activeOrg.orgId)
        .order("legal_name", { ascending: true })
    : { data: null };

  const empresas = (data ?? []) as ClientCompanyRow[];

  return (
    <div className="flex h-full flex-col gap-6 p-6">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Empresas</h1>
          <p className="text-sm text-muted-foreground">
            As empresas que seu escritório atende — plano de contas e lançamentos de cada uma.
          </p>
        </div>
      </header>

      <NovaEmpresaForm canWrite={canWrite} />
      <ListaDeEmpresas empresas={empresas} />
    </div>
  );
}
