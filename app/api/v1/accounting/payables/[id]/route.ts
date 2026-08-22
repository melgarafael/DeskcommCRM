import { type NextRequest } from "next/server";

import { buildLedgerRoutes } from "@/lib/accounting/ledger-routes";

const routes = buildLedgerRoutes({
  table: "accounting_payables",
  createdAction: "accounting.payable_created",
  paidAction: "accounting.payable_paid",
});

/** PATCH marca como pago (paid_at=now, status='paid'). Único write suportado nesta fundação. */
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return routes.markPaid(req, id);
}
