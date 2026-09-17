/** Contexto para abrir o rascunho de comunicação do Max sem transportar conteúdo sensível ou chave. */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";
import { z } from "zod";

import { advomaxAppUrl } from "@/lib/advomax/navigation";
import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { env } from "@/lib/env";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";
interface RouteCtx { params: Promise<{ id: string }> }

const querySchema = z.object({ processo_codigo: z.coerce.number().int().positive() }).strict();

export async function GET(req: NextRequest, ctx: RouteCtx): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("agent", { requestId, resource: "advomax_communication_draft" });
  if (!authz.ok) return authz.response;
  const parsed = querySchema.safeParse(Object.fromEntries(req.nextUrl.searchParams));
  if (!parsed.success) return fail("validation_failed", "Informe um processo jurídico válido.", 422, { requestId });
  if (!env.ADVOMAX_API_URL.trim() || !env.ADVOMAX_CRM_INTEGRATION_KEY.trim()) {
    return fail("integration_unavailable", "A integração com o Advomax não está configurada.", 503, { requestId });
  }

  const { id } = await ctx.params;
  const supabase = await createClient();
  const [{ data: contact, error: contactError }, { data: link, error: linkError }] = await Promise.all([
    supabase.from("contacts").select("id").eq("organization_id", authz.org.orgId).eq("id", id).maybeSingle(),
    supabase.from("advomax_contact_links" as never).select("pessoa_codigo,status").eq("organization_id", authz.org.orgId).eq("contact_id", id).maybeSingle(),
  ]);
  if (contactError || linkError) return fail("internal_error", "Não foi possível validar o contexto jurídico.", 500, { requestId });
  if (!contact) return fail("not_found", "Contato não encontrado.", 404, { requestId });
  const typedLink = link as { pessoa_codigo: number; status: string } | null;
  if (!typedLink || typedLink.status !== "linked") return fail("conflict", "Vincule o cadastro jurídico antes de preparar a comunicação.", 409, { requestId });

  const base = env.ADVOMAX_API_URL.replace(/\/$/, "");
  const headers = {
    "X-CRM-Integration-Key": env.ADVOMAX_CRM_INTEGRATION_KEY,
    "X-CRM-User-Email": authz.user.email,
    "X-CRM-Organization-Id": authz.org.orgId,
  };
  const processesResponse = await fetch(`${base}/integracoes/crm/pessoas/${typedLink.pessoa_codigo}/processos`, {
    headers, cache: "no-store", signal: AbortSignal.timeout(15_000),
  }).catch(() => null);
  if (!processesResponse?.ok) return fail("bad_gateway", "Não foi possível consultar o contexto no Advomax.", 502, { requestId });
  const processes = await processesResponse.json().catch(() => null);
  if (!Array.isArray(processes)) return fail("bad_gateway", "O Advomax devolveu contexto inválido.", 502, { requestId });
  const processo = processes.find((item) => item?.codigo === parsed.data.processo_codigo);
  if (!processo) return fail("forbidden", "O processo não está disponível para este contato.", 403, { requestId });
  const response = ok({
    pessoa_codigo: typedLink.pessoa_codigo,
    processo,
    documentos: [],
    comunicacao: {
      destino: advomaxAppUrl("/documentos"),
      rota: "/inovacao/assistente/documentos/rascunho",
      requer_confirmacao: true,
      requer_revisao_humana: true,
      mensagem: "Selecione no Advomax os documentos deste processo e confirme o envio ao Max para gerar um rascunho editável.",
    },
  }, { requestId });
  response.headers.set("Cache-Control", "private, no-store");
  response.headers.set("Referrer-Policy", "no-referrer");
  return response;
}
