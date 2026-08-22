import { buildLedgerRoutes } from "@/lib/accounting/ledger-routes";

export const { GET, POST } = buildLedgerRoutes({
  table: "accounting_receivables",
  createdAction: "accounting.receivable_created",
  paidAction: "accounting.receivable_paid",
});
