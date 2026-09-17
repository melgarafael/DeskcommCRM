import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { z } from "zod";
import { fail } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { traduzir } from "@/lib/i18n/dicionario";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

export async function GET(_request: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "data_import_records" });
  if (!authz.ok) return authz.response;
  const t = (text: string) => traduzir(text, authz.user.idioma);
  const parsed = z.string().uuid().safeParse((await ctx.params).id);
  if (!parsed.success) return fail("validation_failed", t("Arquivo inválido."), 422, { requestId });
  const db = await createClient();
  const { data: record, error } = await db.from("data_import_records")
    .select("storage_path, file_availability").eq("organization_id", authz.org.orgId).eq("id", parsed.data).maybeSingle();
  if (error) return fail("internal_error", t("Não foi possível carregar o arquivo."), 500, { requestId });
  if (record?.file_availability !== "available" || !record.storage_path?.startsWith(authz.org.orgId + "/")) {
    return fail("not_found", t("Anexo indisponível na origem."), 404, { requestId });
  }
  const { data: signed, error: signingError } = await createAdminClient().storage.from("whatsapp-media").createSignedUrl(record.storage_path, 60);
  if (signingError || !signed) return fail("internal_error", t("Não foi possível carregar o arquivo."), 500, { requestId });
  const response = NextResponse.redirect(signed.signedUrl, 302);
  response.headers.set("X-Request-Id", requestId);
  response.headers.set("Cache-Control", "private, no-store");
  return response;
}
