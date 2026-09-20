import { createHash } from "node:crypto";
import { z } from "zod";
import { ok, fail } from "@/lib/api/wrappers";
import { caktoConfiguration, verifyCaktoSignature } from "@/lib/billing/cakto";
import { getRequestPool } from "@/lib/agent-engine/db/request-pool";

const order = z.object({ id: z.uuid(), product: z.object({ id: z.uuid() }) });
const envelope = z.object({
  event: z.string().max(100),
  data: z.union([order, z.array(order).min(1).max(20)]),
});
const events = new Set([
  "purchase_approved",
  "purchase_refused",
  "refund",
  "chargeback",
  "subscription_created",
  "subscription_renewed",
  "subscription_renewal_refused",
  "subscription_paused",
  "subscription_resumed",
  "subscription_late",
  "subscription_late_recovered",
  "subscription_canceled",
]);
export async function POST(request: Request) {
  let config;
  try {
    config = caktoConfiguration();
  } catch {
    return fail("service_unavailable", "Integração indisponível.", 503);
  }
  // Read with a byte limit, rather than buffering arbitrary untrusted bodies.
  const reader = request.body?.getReader();
  if (!reader) return fail("invalid_request", "Evento inválido.", 400);
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > 1_000_000) {
      await reader.cancel();
      return fail("invalid_request", "Evento muito grande.", 413);
    }
    chunks.push(value);
  }
  const body = Buffer.concat(chunks).toString("utf8");
  if (
    !verifyCaktoSignature(
      body,
      request.headers.get("x-cakto-timestamp") ?? "",
      request.headers.get("x-cakto-signature") ?? "",
      config.webhookSecret,
    )
  )
    return fail("unauthorized", "Assinatura inválida.", 401);
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    return fail("invalid_request", "Evento inválido.", 400);
  }
  const eventOnly = z.object({ event: z.string() }).safeParse(json);
  if (eventOnly.success && !events.has(eventOnly.data.event))
    return ok({ received: true, ignored: true });
  const parsed = envelope.safeParse(json);
  if (!parsed.success) return fail("invalid_request", "Evento inválido.", 400);
  const items = Array.isArray(parsed.data.data) ? parsed.data.data : [parsed.data.data];
  const relevant = items.filter((item) => item.product.id === config.catalog.product);
  if (!relevant.length) return ok({ received: true, ignored: true });
  const db = await Promise.resolve()
    .then(() => getRequestPool().connect())
    .catch(() => null);
  if (!db) return fail("service_unavailable", "Não foi possível registrar o evento.", 503);
  try {
    await db.query("begin");
    for (const item of relevant) {
      const key = createHash("sha256").update(body).update(item.id).digest("hex");
      await db.query(
        "insert into cakto_billing_inbox(id,order_id,event_type) values($1,$2,$3) on conflict do nothing",
        [key, item.id, parsed.data.event],
      );
    }
    await db.query("commit");
    return ok({ received: true });
  } catch {
    await db.query("rollback").catch(() => undefined);
    return fail("service_unavailable", "Não foi possível registrar o evento.", 503);
  } finally {
    db.release();
  }
}
