import { buildLedgerRoutes } from "@/lib/accounting/ledger-routes";

export const { GET, POST } = buildLedgerRoutes({
  table: "accounting_payables",
  createdAction: "accounting.payable_created",
  paidAction: "accounting.payable_paid",
});
