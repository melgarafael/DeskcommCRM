import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * GET    /api/v1/contacts/[id] — fetch single (handler em ../_handler.ts)
 * PATCH  /api/v1/contacts/[id] — update (handler em ../_handler.ts)
 * DELETE /api/v1/contacts/[id] — remove (handler em ../_handler.ts)
 *
 * Thin wrapper: auth + Zod + ok/fail. Decrypt CPF + LGPD irreversibility no handler.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";

import { ApiError } from "@/lib/api/types";
import { ok, fail, noContent } from "@/lib/api/wrappers";
import { orgAtivaDaApi, requireRole } from "@/lib/auth/require-role";
import { loadAuthUser } from "@/lib/auth/server";
import { traduzir } from "@/lib/i18n/dicionario";
import { contactPatchSchemaDoPais, validateRequest } from "@/lib/schemas";
import { perfilDaOrganizacao } from "@/lib/legal/perfil-do-pais";
import { createClient } from "@/lib/supabase/server";

import { deleteContactHandler, getContactHandler, patchContactHandler } from "../_handler";

export const dynamic = "force-dynamic";

/**
 * Os telefones da ficha além do principal (Spec 31, B1), e o tipo e o WhatsApp
 * do principal, que o handler da ficha não seleciona. O filtro de organização é
 * EXPLÍCITO nas duas leituras: o cliente de sessão tem RLS, mas a regra do
 * repositório é não depender só dela. `wa_lid` fica de fora de propósito: é o
 * identificador do WhatsApp daquele número, e a API não precisa dele.
 */
async function telefonesDaFicha(
  supabase: SupabaseClient,
  organizationId: string,
  contactId: string,
  requestId: string,
): Promise<{
  phone_type: string | null;
  phone_whatsapp: string | null;
  additional_phones: Array<{
    phone_number: string;
    type: string;
    whatsapp: string;
    label: string | null;
    origin: string;
    created_at: string;
  }>;
}> {
  const { data: principal, error: errPrincipal } = await supabase
    .from("contacts")
    .select("phone_type, phone_whatsapp")
    .eq("organization_id", organizationId)
    .eq("id", contactId)
    .maybeSingle();
  const { data: extras, error: errExtras } = await supabase
    .from("contact_phones")
    .select("phone_number, tipo, whatsapp, rotulo, origem, created_at")
    .eq("organization_id", organizationId)
    .eq("contact_id", contactId)
    .order("created_at", { ascending: true });
  const erro = errPrincipal ?? errExtras;
  if (erro) throw new ApiError(500, "internal_error", undefined, requestId, erro.message);
  return {
    phone_type: principal?.phone_type ?? null,
    phone_whatsapp: principal?.phone_whatsapp ?? null,
    additional_phones: (extras ?? []).map((e) => ({
      phone_number: e.phone_number,
      type: e.tipo,
      whatsapp: e.whatsapp,
      label: e.rotulo,
      origin: e.origem,
      created_at: e.created_at,
    })),
  };
}

export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  const requestId = randomUUID();
  const { id } = await ctx.params;

  const supabase = await createClient();
  const {
    data: { user },
    error: authErr,
  } = await supabase.auth.getUser();
  if (authErr || !user) {
    return fail("unauthenticated", "Auth required.", 401, { requestId });
  }

  const authUser = await loadAuthUser();
  const t = (texto: string) => traduzir(texto, authUser?.idioma ?? "pt-BR");
  const ativa = await orgAtivaDaApi(authUser, requestId);
  if (!ativa.ok) return ativa.response;
  const activeOrg = ativa.org;
  if (!activeOrg) {
    return fail("no_active_org", t("No active organization."), 403, { requestId });
  }

  const decryptPurpose = req.headers.get("x-decrypt-purpose");

  try {
    const result = await getContactHandler(
      supabase,
      {
        organization_id: activeOrg.orgId,
        actor: { type: "user", id: user.id },
        requestId,
        idioma: authUser?.idioma,
      },
      { contactId: id, decryptPurpose },
    );
    const telefones = await telefonesDaFicha(supabase, activeOrg.orgId, id, requestId);
    return ok({ ...result, ...telefones }, { requestId });
  } catch (err) {
    if (err instanceof ApiError) {
      return fail(err.code, err.message, err.status, { requestId });
    }
    throw err;
  }
}

export async function PATCH(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const { id } = await ctx.params;

  const supabase = await createClient();
  // spec 13 §4: escrita é agent+ (viewer é read-only).
  const authz = await requireRole("agent", { requestId, resource: "contacts" });
  if (!authz.ok) return authz.response;
  const user = authz.user;
  const activeOrg = authz.org;

  // O documento do titular é validado pela régua do PAÍS da organização (issue
  // #1033) — a mesma razão do POST: quem decide é a organização, não o corpo.
  const perfil = await perfilDaOrganizacao(supabase, activeOrg.orgId);

  let input;
  try {
    input = await validateRequest(contactPatchSchemaDoPais(perfil), req);
  } catch (err) {
    if (err instanceof ApiError) {
      return fail(err.code, err.message, err.status, {
        details: err.details as Record<string, unknown> | undefined,
        requestId,
      });
    }
    throw err;
  }

  try {
    const contact = await patchContactHandler(
      supabase,
      {
        organization_id: activeOrg.orgId,
        actor: { type: "user", id: user.id },
        requestId,
        idioma: user.idioma,
      },
      id,
      input,
    );
    return ok(contact, { requestId });
  } catch (err) {
    if (err instanceof ApiError) {
      return fail(err.code, err.message, err.status, { requestId });
    }
    throw err;
  }
}

export async function DELETE(
  _req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const { id } = await ctx.params;

  const authz = await requireRole("agent", { requestId, resource: "contacts" });
  if (!authz.ok) return authz.response;
  const user = authz.user;
  const activeOrg = authz.org;

  const supabase = await createClient();

  try {
    await deleteContactHandler(
      supabase,
      {
        organization_id: activeOrg.orgId,
        actor: { type: "user", id: user.id },
        requestId,
        idioma: user.idioma,
      },
      id,
    );
    return noContent(requestId);
  } catch (err) {
    if (err instanceof ApiError) {
      // `details` carrega os vínculos que barraram a exclusão (#1925); sem ele a
      // tela só tem o texto genérico.
      return fail(err.code, err.message, err.status, { details: err.details, requestId });
    }
    throw err;
  }
}
