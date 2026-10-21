import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";
import { z } from "zod";
import { requireRole } from "@/lib/auth/require-role";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { ok, fail } from "@/lib/api/wrappers";
import { ApiError } from "@/lib/api/types";
import { audit } from "@/lib/audit";
import { configuracaoDoServicoSchema, bloquearServicoSchema } from "@/lib/agenda/servicos/regras";
import { atualizarFontesDoServico, consultarServico, lerServico } from "@/lib/agenda/servicos/consulta";
import { rpcDoServico } from "@/lib/agenda/servicos/escrita";
import { googleRpc } from "@/lib/agenda/google/sync-store";
import { traduzir } from "@/lib/i18n/dicionario";
import { resolveAuthDual, tetoDeEscritaDoToken } from "@/lib/api/auth-dual";

export const dynamic = "force-dynamic";
const querySchema = z.object({ event_type_id: z.uuid().optional(), de: z.iso.datetime({ offset: true }).optional(), ate: z.iso.datetime({ offset: true }).optional() })
  .refine((v) => (!v.de && !v.ate) || (!!v.de && !!v.ate));
const commandSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("configure"), config: configuracaoDoServicoSchema }),
  z.object({ action: z.literal("block"), input: bloquearServicoSchema }),
  z.object({ action: z.literal("block_preview"), input: bloquearServicoSchema }),
  z.object({ action: z.literal("unblock"), input: z.object({ archive_id: z.uuid(), expected_revision: z.number().int().positive() }) }),
  z.object({ action: z.literal("resource"), input: z.object({ id: z.uuid().optional(), expected_revision: z.number().int().positive().optional(), name: z.string().trim().min(2).max(100), capacity: z.number().int().min(1).max(100000), is_active: z.boolean().optional() }) }),
  z.object({ action: z.literal("refresh"), event_type_id: z.uuid() }),
]);

/** Leitura humana usa a sessão. As conexões exibidas são catálogo sem credenciais. */
export async function GET(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const auth = await requireRole("viewer", { requestId, resource: "agenda" });
  if (!auth.ok) return auth.response;
  const t = (s: string) => traduzir(s, auth.user.idioma);
  const query = querySchema.safeParse(Object.fromEntries(new URL(req.url).searchParams));
  if (!query.success) return fail("validation_failed", t("Consulta inválida."), 422, { requestId });
  const db = await createClient();
  const org = auth.org.orgId;
  try {
    const { data: resources, error } = await db.from("calendar_resources").select("id,name,capacity,is_active,revision").eq("organization_id", org).order("name");
    if (error) throw error;
    const { data: blocks, error: blockError } = await db.from("calendar_service_blocks")
      .select("id,scope_kind,event_type_id,owner_user_id,resource_id,starts_at,ends_at,reason,revision,publication_appointment_id")
      .eq("organization_id", org).is("archived_at", null).order("starts_at").limit(100);
    if (blockError) throw blockError;
    const service = query.data.event_type_id ? await lerServico(db, org, query.data.event_type_id) : null;
    const preview = service && query.data.de && query.data.ate ? await consultarServico(db, org, service,
      { de: new Date(query.data.de), ate: new Date(query.data.ate), agora: new Date() }) : null;
    const calendars = await googleRpc(db, "fn_calendar_service_catalog", { p_org: org });
    return ok({ service, resources: resources ?? [], blocks: blocks ?? [], calendars, preview }, { requestId });
  } catch {
    return fail("internal_error", t("Não foi possível ler a configuração do serviço."), 500, { requestId });
  }
}

export async function POST(req: NextRequest): Promise<Response> {
  const denied = await requireSupportWrite();
  if (denied) return denied;
  const requestId = randomUUID();
  const auth = await resolveAuthDual(req, { requestId, resource: "agenda", role: "manager", scope: "mcp:write" });
  if (!auth.ok) return auth.response;
  const t = (s: string) => traduzir(s, auth.idioma ?? "pt-BR");
  const ceiling = await tetoDeEscritaDoToken(auth, "agenda_tipos", requestId);
  if (ceiling) return ceiling;
  const command = commandSchema.safeParse(await req.json().catch(() => null));
  if (!command.success) return fail("validation_failed", t(command.error.issues[0]?.message ?? "corpo inválido"), 422, { requestId });
  const db = createAdminClient();
  const ctx = { organization_id: auth.organizationId, actor: auth.actor, requestId };
  try {
    const c = command.data;
    if (c.action === "refresh") await rpcDoServico(db, ctx, "fn_calendar_service_assert_actor", { p_role: "manager" });
    const result = c.action === "refresh" ? await atualizarFontesDoServico(db, ctx.organization_id, c.event_type_id)
      : await rpcDoServico(db, ctx, c.action === "configure" ? "fn_calendar_service_configure" : c.action === "resource" ? "fn_calendar_service_resource" : "fn_calendar_service_block",
        c.action === "configure" ? { p_config: c.config } : c.action === "resource" ? { p_config: c.input } : { p_input: { ...c.input, ...(c.action === "block_preview" ? { preview: true } : {}) } });
    if (c.action === "block_preview") return ok(result, { requestId });
    await audit({ action: `agenda.service_${c.action}`, actorUserId: auth.actor.type === "user" ? auth.actor.id : null, actorApiTokenId: auth.apiTokenId ?? null, organizationId: ctx.organization_id, requestId,
      metadata: { action: c.action } });
    return ok(result, { requestId });
  } catch (error) {
    if (error instanceof ApiError) return fail(error.code, t(error.message), error.status, { requestId });
    return fail("internal_error", t("Não foi possível salvar a configuração do serviço."), 500, { requestId });
  }
}
