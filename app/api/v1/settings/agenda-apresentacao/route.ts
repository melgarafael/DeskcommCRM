import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { createAdminClient } from "@/lib/supabase/admin";
import { tituloDaAgendaEntradaSchema } from "@/lib/agenda/apresentacao";
import { traduzir } from "@/lib/i18n/dicionario";

export const dynamic = "force-dynamic";
/** Único campo permitido: título. O escopo vem da sessão, nunca do corpo. */
export async function PATCH(req: NextRequest): Promise<Response> {
  const negado = await requireSupportWrite();
  if (negado) return negado;
  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "agenda_presentation" });
  if (!authz.ok) return authz.response;
  const t = (text: string) => traduzir(text, authz.user.idioma);
  const parsed = tituloDaAgendaEntradaSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return fail("validation_failed", t("Dados inválidos."), 422, { requestId, details: parsed.error.flatten().fieldErrors });
  const db = createAdminClient();
  const original = await db.from("organizations").select("settings").eq("id", authz.org.orgId).maybeSingle();
  if (original.error) return fail("internal_error", t("Não foi possível salvar."), 500, { requestId });
  if (!original.data) return fail("not_found", t("Organização não encontrada."), 404, { requestId });
  const settings = original.data.settings;
  if (settings !== null && (typeof settings !== "object" || Array.isArray(settings))) return fail("conflict", t("Confira os campos."), 409, { requestId });
  const current = (settings ?? {}) as Record<string, unknown>;
  const presentation = current.agenda_presentation;
  if (presentation != null && (typeof presentation !== "object" || Array.isArray(presentation))) return fail("conflict", t("Confira os campos."), 409, { requestId });
  const title = parsed.data.title || null;
  let update = db.from("organizations").update({ settings: { ...current, agenda_presentation: { ...((presentation ?? {}) as Record<string, unknown>), title } } }).eq("id", authz.org.orgId);
  // CAS do documento inteiro: escrita concorrente nunca perde outra configuração.
  update = settings === null ? update.is("settings", null) : update.filter("settings", "eq", JSON.stringify(settings));
  const saved = await update.select("id").maybeSingle();
  if (saved.error) return fail("internal_error", t("Não foi possível salvar."), 500, { requestId });
  if (!saved.data) return fail("conflict", t("A configuração mudou. Recarregue a página e tente novamente."), 409, { requestId });
  void audit({ action: "settings.agenda_presentation_updated", actorUserId: authz.user.id, organizationId: authz.org.orgId, resourceType: "organization", resourceId: authz.org.orgId, requestId, metadata: { custom_title: title !== null } });
  return ok({ title }, { requestId });
}
