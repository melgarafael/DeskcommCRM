/**
 * LISTA DE ESPERA — a fila, os prazos da organização e a inscrição.
 *
 * Módulo opcional (doc 208, ADR-0002): com o módulo desligado na instalação,
 * esta rota não existe (404), e nenhuma consulta alcança `calendar_waitlist`.
 * Inscrever exige, além dele, a organização com os prazos escolhidos.
 *
 * A leitura passa pela sessão, sob RLS. A escrita usa o client de serviço, porque
 * a tabela não aceita escrita de sessão: a organização vem do cookie validado, e
 * contato, tipo e profissional são conferidos contra ela antes de gravar.
 */
import { randomUUID } from "node:crypto";

import { type NextRequest } from "next/server";
import { z } from "zod";

import { inscreverNaEspera, configDaEspera } from "@/lib/agenda/encaixe-supabase";
import { configDaListaDeEsperaSchema, janelasDaEsperaSchema } from "@/lib/agenda/lista-de-espera";
import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { nomeDoContato, type ContatoNomeavel } from "@/lib/contacts/rotulo-do-contato";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { moduloLigado } from "@/lib/instalacao/modulos";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

const inscreverSchema = z.strictObject({
  contact_id: z.uuid(),
  event_type_id: z.uuid(),
  owner_user_id: z.uuid().nullish(),
  janelas: janelasDaEsperaSchema.default([]),
  antecedencia_minima_horas: z.number().int().min(0).max(720).default(0),
  valido_ate: z.iso.datetime().nullish(),
  urgencia: z.number().int().min(-5).max(5).default(0),
  observacoes: z.string().trim().max(2000).nullish(),
  /** A pessoa aceitou ser avisada. Sem isto não há inscrição (doc 208). */
  consentimento: z.literal(true),
});

async function seModuloDesligado(requestId: string): Promise<Response | null> {
  if (await moduloLigado(createAdminClient(), "lista_de_espera")) return null;
  return fail("not_found", "Not found.", 404, { requestId });
}

export async function GET(): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("viewer", { requestId, resource: "calendar_waitlist" });
  if (!authz.ok) return authz.response;
  const desligado = await seModuloDesligado(requestId);
  if (desligado) return desligado;

  const org = authz.org.orgId;
  const supabase = await createClient();
  const [{ data: organizacao, error: erroOrg }, { data: linhas, error }] = await Promise.all([
    supabase.from("organizations").select("settings").eq("id", org).single(),
    supabase
      .from("calendar_waitlist")
      .select(
        "id, contact_id, event_type_id, owner_user_id, status, urgencia, janelas, valido_ate, oferta_expira_em, consentimento_em, consentimento_origem, observacoes, created_at",
      )
      .eq("organization_id", org)
      .in("status", ["waiting", "offered"])
      .is("fora_da_fila_em", null)
      .order("urgencia", { ascending: false })
      .order("created_at", { ascending: true })
      .limit(200),
  ]);
  if (error || erroOrg) return fail("internal_error", "Não foi possível carregar a fila.", 500, { requestId });

  const fila = linhas ?? [];
  const [{ data: contatos }, { data: tipos }] = await Promise.all([
    supabase.from("contacts").select("id, name, display_name, phone_number").eq("organization_id", org)
      .in("id", [...new Set(fila.map((l) => l.contact_id))]),
    supabase.from("calendar_event_types").select("id, name").eq("organization_id", org)
      .in("id", [...new Set(fila.map((l) => l.event_type_id))]),
  ]);
  const nomes = new Map((contatos ?? []).map((c) => [c.id, nomeDoContato(c as ContatoNomeavel)]));
  const servicos = new Map((tipos ?? []).map((t) => [t.id, t.name]));

  const settings = organizacao.settings as Record<string, unknown> | null;
  const config = configDaListaDeEsperaSchema.safeParse(settings?.lista_de_espera);
  return ok(
    {
      config: config.success ? config.data : null,
      fila: fila.map((l) => ({
        ...l,
        contato: nomes.get(l.contact_id) ?? null,
        servico: servicos.get(l.event_type_id) ?? null,
      })),
    },
    { requestId },
  );
}

/** Os prazos e a chave da organização. Recusa com os prazos incompletos: sem padrão. */
export async function PATCH(req: NextRequest): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;
  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "calendar_waitlist" });
  if (!authz.ok) return authz.response;
  const desligado = await seModuloDesligado(requestId);
  if (desligado) return desligado;

  const parsed = configDaListaDeEsperaSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return fail("validation_failed", "Escolha os três prazos antes de ligar a lista de espera.", 422, {
      requestId,
      details: parsed.error.flatten().fieldErrors as Record<string, unknown>,
    });
  }

  const org = authz.org.orgId;
  const admin = createAdminClient();
  const { data, error: erroLeitura } = await admin.from("organizations").select("settings").eq("id", org).single();
  if (erroLeitura) return fail("internal_error", "Não foi possível salvar.", 500, { requestId });
  const { error } = await admin
    .from("organizations")
    .update({ settings: { ...(data.settings as Record<string, unknown>), lista_de_espera: parsed.data } })
    .eq("id", org);
  if (error) return fail("internal_error", "Não foi possível salvar.", 500, { requestId });

  void audit({
    action: "agenda.lista_de_espera_configurada",
    organizationId: org,
    actorUserId: authz.user.id,
    requestId,
    resourceType: "organization",
    resourceId: authz.org.orgId,
    metadata: parsed.data,
  });
  return ok(parsed.data, { requestId });
}

export async function POST(req: NextRequest): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;
  const requestId = randomUUID();
  const authz = await requireRole("agent", { requestId, resource: "calendar_waitlist" });
  if (!authz.ok) return authz.response;
  const desligado = await seModuloDesligado(requestId);
  if (desligado) return desligado;

  const org = authz.org.orgId;
  const admin = createAdminClient();
  if (!(await configDaEspera(admin, org))) {
    return fail("conflict", "A lista de espera ainda não foi ligada nesta organização.", 409, { requestId });
  }

  const parsed = inscreverSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return fail("validation_failed", "Confira os dados da inscrição e o consentimento.", 422, {
      requestId,
      details: parsed.error.flatten().fieldErrors as Record<string, unknown>,
    });
  }
  const pedido = parsed.data;

  const [{ data: contato }, { data: tipo }, { data: profissional }] = await Promise.all([
    admin.from("contacts").select("id").eq("organization_id", org).eq("id", pedido.contact_id)
      .eq("is_blocked", false).eq("is_anonymized", false).maybeSingle(),
    admin.from("calendar_event_types").select("id").eq("organization_id", org).eq("id", pedido.event_type_id)
      .eq("is_active", true).maybeSingle(),
    pedido.owner_user_id
      ? admin.from("user_organizations").select("user_id").eq("organization_id", org)
          .eq("user_id", pedido.owner_user_id).is("revoked_at", null).maybeSingle()
      : Promise.resolve({ data: { user_id: null } }),
  ]);
  if (!contato) return fail("not_found", "Contato indisponível para a lista de espera.", 404, { requestId });
  if (!tipo) return fail("not_found", "Tipo de atendimento indisponível.", 404, { requestId });
  if (!profissional) return fail("not_found", "Profissional não encontrado.", 404, { requestId });

  const resultado = await inscreverNaEspera(admin, {
    organizationId: org,
    contactId: pedido.contact_id,
    eventTypeId: pedido.event_type_id,
    ownerUserId: pedido.owner_user_id ?? null,
    janelas: pedido.janelas,
    antecedenciaMinimaHoras: pedido.antecedencia_minima_horas,
    validoAte: pedido.valido_ate ? new Date(pedido.valido_ate) : null,
    urgencia: pedido.urgencia,
    observacoes: pedido.observacoes ?? null,
    consentimentoEm: new Date(),
    consentimentoOrigem: "tela",
    createdByKind: "user",
    createdByUserId: authz.user.id,
  });
  if (!resultado.inscrito) return fail("conflict", "Não foi possível inscrever.", 409, { requestId });

  if (!resultado.jaEstava) {
    void audit({
      action: "agenda.lista_de_espera_inscrito",
      organizationId: org,
      actorUserId: authz.user.id,
      requestId,
      resourceType: "calendar_waitlist",
      resourceId: resultado.esperaId,
      metadata: { event_type_id: pedido.event_type_id },
    });
  }
  return ok({ id: resultado.esperaId, ja_estava: resultado.jaEstava }, { requestId, status: 201 });
}
