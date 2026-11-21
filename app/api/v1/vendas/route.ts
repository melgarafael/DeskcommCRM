/**
 * /api/v1/vendas — as vendas registradas de um negócio ou de um contato.
 * O contrato e as réguas estão em `lib/vendas/registradas.ts`.
 *
 * GET  ?lead_id=… | ?contact_id=…  → a lista (client de SESSÃO: a RLS da
 *      tabela recorta pela organização).
 * POST { lead_id?, contact_id?, valor_cents, data, tags?, observacao? }
 *      → registra uma venda. Papel `agent`+.
 *
 * ─── A organização NUNCA vem do corpo ──────────────────────────────────────
 * Ela vem do cookie (`requireRole`). O negócio e o contato do corpo são
 * CONFERIDOS como desta organização antes de gravar — com o admin client e
 * `organization_id` filtrado à mão, porque a gravação é pelo admin (a tabela
 * não dá INSERT a `authenticated`). O negócio é lido também pela SESSÃO: quem
 * não enxerga o card (RLS de `crm_leads`) não registra venda nele.
 */
import { randomUUID } from "node:crypto";

import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { MOEDA_PADRAO } from "@/lib/money";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { criarVendaSchema, type VendaRegistrada } from "@/lib/vendas/registradas";

export const dynamic = "force-dynamic";

const COLUNAS = "id, lead_id, contact_id, valor_cents, currency, data, tags, observacao, created_by, created_at";

const listarSchema = z
  .object({
    lead_id: z.uuid().optional(),
    contact_id: z.uuid().optional(),
  })
  .refine((q) => q.lead_id !== undefined || q.contact_id !== undefined, {
    message: "Informe lead_id ou contact_id.",
  });

export async function GET(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("viewer", { requestId, resource: "vendas", allowPlatformAdmin: "leitura" });
  if (!authz.ok) return authz.response;

  const url = new URL(req.url);
  const parsed = listarSchema.safeParse({
    lead_id: url.searchParams.get("lead_id") || undefined,
    contact_id: url.searchParams.get("contact_id") || undefined,
  });
  if (!parsed.success) return fail("validation_failed", "Informe o negócio ou o contato.", 422, { requestId });

  const supabase = await createClient();
  let consulta = supabase
    .from("vendas_registradas")
    .select(COLUNAS)
    .eq("organization_id", authz.org.orgId)
    .order("data", { ascending: false })
    .order("created_at", { ascending: false })
    .limit(200);
  if (parsed.data.lead_id) consulta = consulta.eq("lead_id", parsed.data.lead_id);
  else if (parsed.data.contact_id) consulta = consulta.eq("contact_id", parsed.data.contact_id);

  const { data, error } = await consulta;
  if (error) return fail("internal_error", "Não foi possível carregar as vendas.", 500, { requestId });
  return ok((data ?? []) as VendaRegistrada[], { requestId });
}

export async function POST(req: NextRequest): Promise<Response> {
  const denied = await requireSupportWrite();
  if (denied) return denied;
  const requestId = randomUUID();
  const authz = await requireRole("agent", { requestId, resource: "vendas" });
  if (!authz.ok) return authz.response;
  const orgId = authz.org.orgId;

  const parsed = criarVendaSchema().safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return fail("validation_failed", parsed.error.issues[0]?.message ?? "Confira os dados da venda.", 422, {
      requestId,
      details: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
    });
  }
  const venda = parsed.data;
  const admin = createAdminClient();

  // O NEGÓCIO: desta organização E visível a quem registra (sessão + RLS).
  let contactId = venda.contact_id ?? null;
  // A moeda da venda é a do NEGÓCIO (a soma do Valor só conta essa); venda só de
  // contato fica na da organização.
  let moedaDoNegocio: string | null = null;
  if (venda.lead_id) {
    const sessao = await createClient();
    const { data: lead, error } = await sessao
      .from("crm_leads")
      .select("id, contact_id, currency")
      .eq("organization_id", orgId)
      .eq("id", venda.lead_id)
      .maybeSingle();
    if (error) return fail("internal_error", "Não foi possível conferir o negócio.", 500, { requestId });
    if (!lead) return fail("not_found", "Negócio não encontrado.", 404, { requestId });
    const doNegocio = (lead as { contact_id: string | null }).contact_id;
    moedaDoNegocio = (lead as { currency: string | null }).currency?.trim() || null;
    if (contactId && doNegocio && contactId !== doNegocio) {
      return fail("validation_failed", "O contato não é o deste negócio.", 422, { requestId });
    }
    contactId = contactId ?? doNegocio;
  }

  // O CONTATO: desta organização (filtro à mão — o admin bypassa a RLS).
  if (contactId) {
    const { data: contato, error } = await admin
      .from("contacts")
      .select("id")
      .eq("organization_id", orgId)
      .eq("id", contactId)
      .maybeSingle();
    if (error) return fail("internal_error", "Não foi possível conferir o contato.", 500, { requestId });
    if (!contato) return fail("not_found", "Contato não encontrado.", 404, { requestId });
  }

  const { data: criada, error } = await admin
    .from("vendas_registradas")
    .insert({
      organization_id: orgId,
      lead_id: venda.lead_id ?? null,
      contact_id: contactId,
      valor_cents: venda.valor_cents,
      currency: (moedaDoNegocio || authz.org.currency?.trim() || MOEDA_PADRAO).toUpperCase(),
      data: venda.data,
      tags: venda.tags,
      observacao: venda.observacao,
      created_by: authz.user.id,
    })
    .select(COLUNAS)
    .single();
  if (error || !criada) return fail("internal_error", "Não foi possível registrar a venda.", 500, { requestId });

  void audit({
    action: "venda.registrada",
    actorUserId: authz.user.id,
    organizationId: orgId,
    resourceType: "venda_registrada",
    resourceId: (criada as VendaRegistrada).id,
    requestId,
    metadata: {
      lead_id: venda.lead_id ?? null,
      contact_id: contactId,
      valor_cents: venda.valor_cents,
      data: venda.data,
      tags: venda.tags,
    },
  });

  return ok(criada as VendaRegistrada, { requestId, status: 201 });
}
