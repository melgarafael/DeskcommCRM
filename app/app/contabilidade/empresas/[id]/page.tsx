import { notFound } from "next/navigation";

import { requireAuth, resolveActiveOrg } from "@/lib/auth/server";
import { ROLE_RANK } from "@/lib/auth/types";
import { createAdminClient } from "@/lib/supabase/admin";
import { Card } from "@/components/ui/card";
import { PlanoDeContas, Lancamentos, type AccountRow, type EntryRow } from "./_client";
import { Financeiro, type LedgerRow } from "./_financeiro";

export const dynamic = "force-dynamic";

interface Activity {
  id: string;
  type: string;
  payload: Record<string, unknown>;
  performed_at: string;
}

const ACTIVITY_LABEL: Record<string, (a: Activity) => string> = {
  client_company_created: () => "Empresa cadastrada",
  journal_entry_created: (a) => `Lançamento: ${String(a.payload.description ?? "")}`,
};

export default async function EmpresaDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const user = await requireAuth();
  const activeOrg = await resolveActiveOrg(user);
  if (!activeOrg) notFound();

  const admin = createAdminClient();
  const { data: company } = await admin
    .from("accounting_client_companies")
    .select("id, legal_name, trade_name, cnpj, tax_regime, status")
    .eq("organization_id", activeOrg.orgId)
    .eq("id", id)
    .maybeSingle();

  if (!company) notFound();

  const canWrite = ROLE_RANK[activeOrg.role] >= ROLE_RANK.manager;

  const [
    { data: contas },
    { data: lancamentos },
    { data: activities },
    { data: payables },
    { data: receivables },
  ] = await Promise.all([
    admin
      .from("accounting_chart_of_accounts")
      .select("id, code, name, account_type")
      .eq("client_company_id", id)
      .order("code", { ascending: true }),
    admin
      .from("accounting_journal_entries")
      .select("id, entry_date, description, status")
      .eq("client_company_id", id)
      .order("entry_date", { ascending: false }),
    admin
      .from("accounting_client_company_activities")
      .select("id, type, payload, performed_at")
      .eq("client_company_id", id)
      .order("performed_at", { ascending: false })
      .limit(20),
    admin
      .from("accounting_payables")
      .select("id, description, amount_cents, due_date, paid_at, status")
      .eq("client_company_id", id)
      .order("due_date", { ascending: true }),
    admin
      .from("accounting_receivables")
      .select("id, description, amount_cents, due_date, paid_at, status")
      .eq("client_company_id", id)
      .order("due_date", { ascending: true }),
  ]);

  return (
    <div className="flex h-full flex-col gap-6 p-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">
          {company.trade_name || company.legal_name}
        </h1>
        <p className="text-sm text-muted-foreground">
          {company.cnpj}
          {company.tax_regime ? ` · ${company.tax_regime}` : ""}
        </p>
      </header>

      <PlanoDeContas
        clientCompanyId={id}
        contas={(contas ?? []) as AccountRow[]}
        canWrite={canWrite}
      />
      <Lancamentos
        clientCompanyId={id}
        contas={(contas ?? []) as AccountRow[]}
        lancamentos={(lancamentos ?? []) as EntryRow[]}
        canWrite={canWrite}
      />

      <Financeiro
        clientCompanyId={id}
        payables={(payables ?? []) as LedgerRow[]}
        receivables={(receivables ?? []) as LedgerRow[]}
        canWrite={canWrite}
      />

      <Card className="p-6 space-y-3">
        <h2 className="text-sm font-semibold">Linha do tempo</h2>
        {activities && activities.length > 0 ? (
          <ul className="space-y-2">
            {(activities as Activity[]).map((a) => (
              <li key={a.id} className="text-sm">
                <span className="text-muted-foreground">
                  {new Date(a.performed_at).toLocaleString("pt-BR")}
                </span>{" "}
                — {ACTIVITY_LABEL[a.type]?.(a) ?? a.type}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted-foreground">Nenhuma atividade ainda.</p>
        )}
      </Card>
    </div>
  );
}
