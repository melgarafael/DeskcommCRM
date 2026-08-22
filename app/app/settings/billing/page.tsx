import { redirect } from "next/navigation";

import { requireAuth, resolveActiveOrg } from "@/lib/auth/server";
import { ROLE_RANK } from "@/lib/auth/types";
import { emailDeSuporte } from "@/lib/branding/saida";
import { isBillingEnabled } from "@/lib/asaas/config";
import { createAdminClient } from "@/lib/supabase/admin";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

export const dynamic = "force-dynamic";

/**
 * A tela de dinheiro entregava o nosso contato ao cliente do revendedor, e ela
 * tem porta de 1ª classe no menu. Mesmo tratamento da tela de conta suspensa:
 * o endereço é o de quem opera a instalação (`SUPPORT_EMAIL`) e, sem ele
 * configurado, nenhum endereço aparece.
 *
 * Fase 3 do pivot ADR-0002: para de ser stub SE a instância roda
 * BILLING_MODE=asaas E o tenant tem uma linha em organization_subscriptions.
 * Self-host (billing desligado, ou tenant sem assinatura nenhuma) continua
 * vendo exatamente o texto de antes — nada muda para quem já usa esta tela.
 */

const STATUS_LABEL: Record<string, string> = {
  active: "Ativa",
  incomplete: "Aguardando confirmação",
  past_due: "Pagamento em atraso",
  canceled: "Cancelada",
  expired: "Expirada",
};

const INVOICE_STATUS_LABEL: Record<string, string> = {
  PENDING: "Pendente",
  CONFIRMED: "Confirmada",
  RECEIVED: "Paga",
  OVERDUE: "Vencida",
  REFUNDED: "Estornada",
};

function formatCents(cents: number, currency: string): string {
  return (cents / 100).toLocaleString("pt-BR", { style: "currency", currency });
}

function formatDate(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("pt-BR");
}

export default async function BillingPage() {
  // spec 13 §4: billing é admin-only (viewer/agent/manager = none).
  const user = await requireAuth();
  const activeOrg = await resolveActiveOrg(user);
  if (!activeOrg || ROLE_RANK[activeOrg.role] < ROLE_RANK.admin) {
    redirect("/403");
  }

  if (isBillingEnabled()) {
    const admin = createAdminClient();
    const { data: subscription } = await admin
      .from("organization_subscriptions")
      .select(
        "id, status, current_period_end, trial_ends_at, plan:billing_plans(name, price_cents, currency, billing_interval)",
      )
      .eq("organization_id", activeOrg.orgId)
      .maybeSingle();

    if (subscription) {
      const { data: invoices } = await admin
        .from("billing_invoices")
        .select("id, status, amount_cents, currency, due_date, paid_at, invoice_url, created_at")
        .eq("organization_id", activeOrg.orgId)
        .order("created_at", { ascending: false })
        .limit(10);

      const plan = Array.isArray(subscription.plan) ? subscription.plan[0] : subscription.plan;

      return (
        <div className="flex h-full flex-col gap-6 p-6">
          <header>
            <h1 className="text-2xl font-semibold tracking-tight">Billing</h1>
            <p className="text-sm text-muted-foreground">Planos, faturas e cobrança.</p>
          </header>

          <Card className="max-w-xl p-6 space-y-3">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-semibold">{plan?.name ?? "Plano"}</h2>
              <Badge variant={subscription.status === "active" ? "default" : "secondary"}>
                {STATUS_LABEL[subscription.status] ?? subscription.status}
              </Badge>
            </div>
            {plan && (
              <p className="text-2xl font-semibold">
                {formatCents(plan.price_cents, plan.currency)}
                <span className="text-sm font-normal text-muted-foreground">
                  /{plan.billing_interval === "monthly" ? "mês" : "ano"}
                </span>
              </p>
            )}
            <p className="text-sm text-muted-foreground">
              Próxima cobrança: {formatDate(subscription.current_period_end)}
            </p>
          </Card>

          <Card className="max-w-2xl p-6 space-y-3">
            <h2 className="text-sm font-semibold">Faturas</h2>
            {invoices && invoices.length > 0 ? (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Vencimento</TableHead>
                    <TableHead>Valor</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Link</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {invoices.map((inv) => (
                    <TableRow key={inv.id}>
                      <TableCell>{formatDate(inv.due_date)}</TableCell>
                      <TableCell>{formatCents(inv.amount_cents, inv.currency)}</TableCell>
                      <TableCell>
                        <Badge variant="secondary">
                          {INVOICE_STATUS_LABEL[inv.status] ?? inv.status}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        {inv.invoice_url ? (
                          <a
                            href={inv.invoice_url}
                            target="_blank"
                            rel="noreferrer"
                            className="underline underline-offset-4"
                          >
                            Abrir
                          </a>
                        ) : (
                          "—"
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            ) : (
              <p className="text-sm text-muted-foreground">Nenhuma fatura ainda.</p>
            )}
          </Card>
        </div>
      );
    }
  }

  // BILLING_MODE=disabled (self-host, o caminho de sempre) OU nenhuma
  // assinatura vinculada a este tenant — mesmo texto que a tela sempre teve.
  const suporte = emailDeSuporte();
  return (
    <div className="flex h-full flex-col gap-6 p-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Billing</h1>
        <p className="text-sm text-muted-foreground">Planos, faturas e cobrança.</p>
      </header>
      <Card className="max-w-xl p-6">
        <h2 className="text-sm font-semibold">Em breve — Fase 2</h2>
        <p className="mt-2 text-sm text-muted-foreground">
          Billing entra na Fase 2 do roadmap.{" "}
          {suporte ? (
            <>
              Para questões de pagamento, contate{" "}
              <a className="underline" href={`mailto:${suporte}`}>
                {suporte}
              </a>
              .
            </>
          ) : (
            <>Para questões de pagamento, fale com quem administra este sistema.</>
          )}
        </p>
      </Card>
    </div>
  );
}
