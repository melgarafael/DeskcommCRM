import { randomUUID } from "node:crypto";
import { fail } from "@/lib/api/wrappers";
import {
  requirePlatformAdmin,
  requirePlatformAdminEscrita,
  falhaDaEscritaDePlatformAdmin,
} from "@/lib/auth/requirePlatformAdmin";
import { createClient } from "@/lib/supabase/server";
import { noticeRpcResult } from "@/lib/realtime/notice-rpc-result";
import { noticeReceiptSchema } from "@/lib/realtime/notice-receipt-schema";
export const dynamic = "force-dynamic";
export async function GET() {
  const requestId = randomUUID();
  try {
    await requirePlatformAdmin();
  } catch (error) {
    return falhaDaEscritaDePlatformAdmin(error, requestId);
  }
  return noticeRpcResult(
    await (await createClient()).rpc("fn_derived_notice_page", { p_limit: 20 }),
    requestId,
  );
}
export async function POST(req: Request) {
  const requestId = randomUUID();
  try {
    await requirePlatformAdminEscrita();
  } catch (error) {
    return falhaDaEscritaDePlatformAdmin(error, requestId);
  }
  const parsed = noticeReceiptSchema.safeParse(
    await req.json().catch(() => null),
  );
  if (!parsed.success)
    return fail("validation_failed", "Recibo inválido.", 422, { requestId });
  return noticeRpcResult(
    await (
      await createClient()
    ).rpc("fn_derived_notice_ack", { p_items: parsed.data.items }),
    requestId,
  );
}
