import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * GET  — chave VAPID pública (ou enabled=false se o operador não configurou).
 * PUT  — grava a inscrição deste navegador.
 * DELETE — remove a inscrição pelo endpoint.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { createClient } from "@/lib/supabase/server";
import { vapidPronto, vapidPublica } from "@/lib/notifications/vapid";
import { traduzir } from "@/lib/i18n/dicionario";

export const dynamic = "force-dynamic";

const subSchema = z.object({
  endpoint: z.string().url(),
  keys: z.object({
    p256dh: z.string().min(1),
    auth: z.string().min(1),
  }),
});

export async function GET(): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("viewer", { requestId, resource: "push_subscriptions" });
  if (!authz.ok) return authz.response;
  return ok(
    { enabled: vapidPronto(), public_key: vapidPublica() },
    { requestId },
  );
}

export async function PUT(req: NextRequest): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const authz = await requireRole("viewer", { requestId, resource: "push_subscriptions" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  if (!vapidPronto()) {
    return fail("unavailable", t("Web Push não configurado nesta instalação."), 503, { requestId });
  }

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return fail("invalid_request", t("Body JSON inválido."), 400, { requestId });
  }
  const parsed = subSchema.safeParse(raw);
  if (!parsed.success) {
    return fail("validation_failed", t("Campos inválidos."), 422, {
      requestId,
      details: parsed.error.flatten(),
    });
  }

  const { user, org } = authz;
  const supabase = await createClient();
  const { error } = await supabase.from("push_subscriptions" as never).upsert(
    {
      organization_id: org.orgId,
      user_id: user.id,
      endpoint: parsed.data.endpoint,
      p256dh: parsed.data.keys.p256dh,
      auth: parsed.data.keys.auth,
      updated_at: new Date().toISOString(),
    } as never,
    { onConflict: "endpoint" },
  );

  if (error) {
    if (error.code === "PGRST205") {
      return fail("unavailable", t("Web Push ainda não está no banco desta instalação."), 503, { requestId });
    }
    return fail("internal_error", error.message, 500, { requestId });
  }

  void audit({
    action: "notification_prefs.changed",
    actorUserId: user.id,
    organizationId: org.orgId,
    resourceType: "push_subscription",
    requestId,
    metadata: { channel: "web_push" },
  });

  return ok({ ok: true }, { requestId });
}

export async function DELETE(req: NextRequest): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const authz = await requireRole("viewer", { requestId, resource: "push_subscriptions" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return fail("invalid_request", t("Body JSON inválido."), 400, { requestId });
  }
  const parsed = z.object({ endpoint: z.string().url() }).safeParse(raw);
  if (!parsed.success) {
    return fail("validation_failed", t("Campos inválidos."), 422, { requestId });
  }

  const supabase = await createClient();
  const { error } = await supabase
    .from("push_subscriptions" as never)
    .delete()
    .eq("endpoint" as never, parsed.data.endpoint)
    .eq("user_id" as never, authz.user.id);

  if (error) return fail("internal_error", error.message, 500, { requestId });
  return ok({ ok: true }, { requestId });
}
