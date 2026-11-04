import { randomUUID } from "node:crypto";
import { fail } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { PAPEL_MINIMO_DA_CENTRAL } from "@/lib/ai/inbox-destino";
import { createClient } from "@/lib/supabase/server";
import { noticeRpcResult } from "@/lib/realtime/notice-rpc-result";
import { noticeReceiptSchema } from "@/lib/realtime/notice-receipt-schema";
export const dynamic = "force-dynamic";
export async function GET() {
  const requestId = randomUUID();
  const authz = await requireRole(PAPEL_MINIMO_DA_CENTRAL, {
    requestId,
    resource: "agent_inbox_items",
  });
  if (!authz.ok) return authz.response;
  return noticeRpcResult(
    await (
      await createClient()
    ).rpc("fn_notice_episode_page", {
      p_organization_id: authz.org.orgId,
      p_limit: 20,
    }),
    requestId,
  );
}
export async function POST(req: Request) {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;
  const requestId = randomUUID();
  const authz = await requireRole(PAPEL_MINIMO_DA_CENTRAL, {
    requestId,
    resource: "agent_inbox_items",
  });
  if (!authz.ok) return authz.response;
  const parsed = noticeReceiptSchema.safeParse(
    await req.json().catch(() => null),
  );
  if (!parsed.success)
    return fail("validation_failed", "Recibo inválido.", 422, { requestId });
  return noticeRpcResult(
    await (
      await createClient()
    ).rpc("fn_notice_episode_ack", {
      p_organization_id: authz.org.orgId,
      p_items: parsed.data.items,
    }),
    requestId,
  );
}
