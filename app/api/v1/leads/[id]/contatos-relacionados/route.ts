/**
 * GET/POST/PATCH/DELETE /api/v1/leads/[id]/contatos-relacionados.
 *
 * O negócio guarda UM contato principal (`crm_leads.contact_id`). Outras pessoas
 * ficam em `crm_lead_links` com `target_kind='contact'` e `link_kind='related'`
 * (Spec 02 §2.6). Escola (aluno + responsável), clínica (paciente + quem paga)
 * e imobiliária (casal + corretor) cabem aqui sem tabela nova ou migration.
 *
 * TRÊS DECISÕES QUE O TESTE PRENDE:
 *
 *  1. DEFESA ALÉM DA RLS. `target_id` não é FK para `contacts` — é o preço do
 *     `target_kind` polimórfico — então um link forjado pode apontar para
 *     contato de outra organização. A RLS derruba isso na consulta; a checagem
 *     de org aqui embaixo derruba mesmo se um dia a consulta rodar sem RLS.
 *     Os dois níveis precisam existir: é o segundo que sobrevive quando o
 *     primeiro falha.
 *  2. LÁPIDE DE FUSÃO APARECE PELO VENCEDOR. `is_merged_into` é o mapa que a
 *     fusão de contatos já reponta (baseline) — quem lê tem que subir o
 *     ponteiro, senão a tela exibe um contato que a fusão aposentou.
 *  3. ANONIMIZADO APARECE COMO ANONIMIZADO. A cascata LGPD já redigiu nome e
 *     telefone; a rota só não mente sobre o estado — daí o flag `anonimizado`
 *     no payload, para a tela marcar a pessoa.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";
import { z } from "zod";

import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { nomeDoContato } from "@/lib/contacts/rotulo-do-contato";
import { loadAuthUser } from "@/lib/auth/server";
import { requireRole } from "@/lib/auth/require-role";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { traduzir } from "@/lib/i18n/dicionario";
import { emitLeadActivity } from "@/lib/leads/activity-emitter";
import { registraFalhaDeAtividade } from "@/lib/leads/activity-write-failure";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

interface RouteCtx {
  params: Promise<{ id: string }>;
}

interface LinhaDeContato {
  id: string;
  organization_id: string;
  name: string | null;
  display_name: string | null;
  is_merged_into: string | null;
  is_anonymized: boolean;
}

/** O que a tela recebe por pessoa: a âncora, o nome, o papel e o estado LGPD. */
export interface ContatoRelacionado {
  contact_id: string;
  /** ID que o vínculo realmente guarda; pode ser uma lápide de fusão. */
  vinculo_contact_id: string;
  nome: string | null;
  papel: string | null;
  anonimizado: boolean;
}

const idContato = z.string().uuid();
const corpoBase = z.object({ contact_id: idContato });
const corpoCriacao = corpoBase.extend({ papel: z.string().trim().max(40).optional() }).strict();
const corpoEdicao = corpoBase.extend({ papel: z.string().trim().max(40) }).strict();
const corpoRemocao = corpoBase.strict();

type Operacao = "adicionar" | "editar" | "remover";

const motivoDaOperacao: Record<Operacao, string> = {
  adicionar: "Adicionou uma pessoa relacionada ao negócio",
  editar: "Alterou a função de uma pessoa relacionada ao negócio",
  remover: "Removeu uma pessoa relacionada do negócio",
};

/** `metadata.papel` é texto livre (F2 limita a 40); aqui só lemos o que veio. */
function papelDo(metadata: unknown): string | null {
  const bruto = (metadata as { papel?: unknown } | null | undefined)?.papel;
  return typeof bruto === "string" && bruto.trim() !== "" ? bruto.trim() : null;
}

export async function GET(_req: NextRequest, ctx: RouteCtx): Promise<Response> {
  const requestId = randomUUID();
  const { id: leadId } = await ctx.params;

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

  // O lead vem pela RLS do caller — é ele que prova a org, nunca o body.
  const { data: lead, error: leadErr } = await supabase
    .from("crm_leads")
    .select("id, organization_id")
    .eq("id", leadId)
    .maybeSingle();
  if (leadErr) return fail("internal_error", leadErr.message, 500, { requestId });
  if (!lead) return fail("not_found", t("Negócio não encontrado."), 404, { requestId });
  const orgId = (lead as { organization_id: string }).organization_id;

  // Filtro de tenant EXPLÍCITO na tabela (doutrina multi-tenancy da CLAUDE.md),
  // não só RLS: o lead prova a org na linha acima, e o vínculo é da mesma org.
  // A checagem de org dos CONTATOS continua embaixo, porque `target_id` não é FK
  // e nenhuma consulta por id resolve sozinha de quem é o dono da linha.
  const { data: links, error: linksErr } = await supabase
    .from("crm_lead_links")
    .select("target_id, metadata")
    .eq("lead_id", leadId)
    .eq("organization_id", orgId)
    .eq("target_kind", "contact")
    .eq("link_kind", "related")
    // Ordem explícita: sem ela, a ordem da lista e o papel que vence na
    // deduplicação ficariam por conta da ordem física da tabela.
    .order("created_at", { ascending: true });
  if (linksErr) return fail("internal_error", linksErr.message, 500, { requestId });

  const linhasDeLink = (links ?? []) as unknown as { target_id: string; metadata: unknown }[];
  const alvos = [...new Set(linhasDeLink.map((l) => l.target_id))];
  if (alvos.length === 0) return ok([], { requestId });

  const { data: contatos, error: contatosErr } = await supabase
    .from("contacts")
    .select("id, organization_id, name, display_name, is_merged_into, is_anonymized")
    .in("id", alvos);
  if (contatosErr) return fail("internal_error", contatosErr.message, 500, { requestId });

  const porId = new Map<string, LinhaDeContato>();
  for (const c of (contatos ?? []) as unknown as LinhaDeContato[]) porId.set(c.id, c);

  // Sobe a cadeia de lápides até o ponteiro parar. 5 voltas de teto: fusão
  // encadeada não deveria existir, mas o laço não pode ser infinito — e se o
  // vencedor não vier do banco (linha inexistente), o `break` abaixo segura.
  for (let volta = 0; volta < 5; volta++) {
    const ponteiros = [
      ...new Set(
        [...porId.values()]
          .map((c) => c.is_merged_into)
          .filter((id): id is string => !!id && !porId.has(id)),
      ),
    ];
    if (ponteiros.length === 0) break;
    const { data: vencedores, error: vencedoresErr } = await supabase
      .from("contacts")
      .select("id, organization_id, name, display_name, is_merged_into, is_anonymized")
      .in("id", ponteiros);
    if (vencedoresErr) return fail("internal_error", vencedoresErr.message, 500, { requestId });
    const novos = (vencedores ?? []) as unknown as LinhaDeContato[];
    if (novos.length === 0) break;
    for (const v of novos) porId.set(v.id, v);
  }

  const resultado: ContatoRelacionado[] = [];
  const vistos = new Set<string>();
  for (const link of linhasDeLink) {
    let contato = porId.get(link.target_id) ?? null;
    const seguidos = new Set<string>();
    while (contato?.is_merged_into && !seguidos.has(contato.id)) {
      seguidos.add(contato.id);
      contato = porId.get(contato.is_merged_into) ?? null;
    }
    if (!contato) continue; // alvo apagado e sem vencedor resolvível: sem tela.
    // DEFESA EM PROFUNDIDADE ALÉM DA RLS — `target_id` não é FK. Um link
    // forjado de outra org não passa daqui mesmo que a RLS falhe. É esta
    // linha que o teste da #1506 prende: sabote ela e o teste fica vermelho.
    if (contato.organization_id !== orgId) continue;
    if (vistos.has(contato.id)) continue;
    vistos.add(contato.id);
    resultado.push({
      contact_id: contato.id,
      vinculo_contact_id: link.target_id,
      nome: nomeDoContato(contato),
      papel: papelDo(link.metadata),
      anonimizado: contato.is_anonymized === true,
    });
  }

  return ok(resultado, { requestId });
}

async function escrever(req: NextRequest, ctx: RouteCtx, operacao: Operacao): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;
  const requestId = randomUUID();
  const authz = await requireRole("agent", { requestId, resource: "crm_lead_links" });
  if (!authz.ok) return authz.response;
  const { id: leadId } = await ctx.params;
  const idioma = authz.user.idioma;
  const t = (texto: string) => traduzir(texto, idioma);
  if (!z.string().uuid().safeParse(leadId).success) {
    return fail("validation_failed", t("Negócio inválido."), 422, { requestId });
  }

  const schema =
    operacao === "adicionar" ? corpoCriacao : operacao === "editar" ? corpoEdicao : corpoRemocao;
  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return fail("validation_failed", t("Confira o contato e a função (até 40 caracteres)."), 422, {
      requestId,
    });
  }
  const { contact_id: contactId } = parsed.data;
  const valorPapel = "papel" in parsed.data ? parsed.data.papel : undefined;
  const papel = typeof valorPapel === "string" ? valorPapel.trim() : "";
  const orgId = authz.org.orgId;
  const supabase = await createClient();

  // A org vem da sessão, e as duas pontas são conferidas ANTES da escrita.
  // `target_id` é polimórfico e não possui FK para contacts.
  const { data: lead, error: leadErr } = await supabase
    .from("crm_leads")
    .select("id, organization_id, contact_id")
    .eq("id", leadId)
    .eq("organization_id", orgId)
    .maybeSingle();
  if (leadErr) return fail("internal_error", leadErr.message, 500, { requestId });
  if (!lead) return fail("not_found", t("Negócio não encontrado."), 404, { requestId });
  if (lead.contact_id === contactId) {
    return fail("already_primary", t("Este já é o contato principal do negócio."), 409, {
      requestId,
    });
  }

  const { data: contato, error: contatoErr } = await supabase
    .from("contacts")
    .select("id, organization_id, kind, is_personal, is_anonymized, is_merged_into")
    .eq("id", contactId)
    .eq("organization_id", orgId)
    .maybeSingle();
  if (contatoErr) return fail("internal_error", contatoErr.message, 500, { requestId });
  if (!contato) return fail("not_found", t("Contato não encontrado."), 404, { requestId });
  if (operacao !== "remover" && contato.is_personal) {
    return fail("forbidden", t("Contato marcado como pessoal."), 403, { requestId });
  }
  if (operacao === "editar" && contato.is_anonymized) {
    return fail("invalid_contact", t("Contato anonimizado não pode receber nova função."), 422, {
      requestId,
    });
  }
  if (operacao === "adicionar" && contato.is_merged_into) {
    return fail("merged_contact", t("Este cadastro foi unido a outro contato. Selecione o cadastro atual."), 409, { requestId });
  }
  if (operacao === "adicionar" && (contato.kind !== "person" || contato.is_anonymized)) {
    return fail("invalid_contact", t("Selecione um contato ativo."), 422, { requestId });
  }

  let mudou = true;
  if (operacao === "adicionar") {
    const { error } = await supabase.from("crm_lead_links").insert({
      organization_id: orgId,
      lead_id: leadId,
      target_kind: "contact",
      target_id: contactId,
      link_kind: "related",
      metadata: papel ? { papel } : {},
      created_by_user_id: authz.user.id,
    });
    if (error?.code === "23505") {
      return fail("already_related", t("Este contato já está relacionado ao negócio."), 409, {
        requestId,
      });
    }
    if (error) return fail("internal_error", error.message, 500, { requestId });
  } else {
    const { data: vinculo, error: vinculoErr } = await supabase
      .from("crm_lead_links")
      .select("id, metadata")
      .eq("lead_id", leadId)
      .eq("organization_id", orgId)
      .eq("target_kind", "contact")
      .eq("target_id", contactId)
      .eq("link_kind", "related")
      .maybeSingle();
    if (vinculoErr) return fail("internal_error", vinculoErr.message, 500, { requestId });
    if (!vinculo) return fail("not_found", t("Vínculo não encontrado."), 404, { requestId });

    if (operacao === "editar") {
      mudou = papelDo(vinculo.metadata) !== (papel || null);
      if (mudou) {
        const metadata =
          vinculo.metadata &&
          typeof vinculo.metadata === "object" &&
          !Array.isArray(vinculo.metadata)
            ? (vinculo.metadata as Record<string, unknown>)
            : {};
        const { data, error } = await supabase
          .from("crm_lead_links")
          .update({ metadata: { ...metadata, papel: papel || null } })
          .eq("id", vinculo.id)
          .eq("organization_id", orgId)
          .select("id")
          .maybeSingle();
        if (error) return fail("internal_error", error.message, 500, { requestId });
        if (!data) return fail("not_found", t("Vínculo não encontrado."), 404, { requestId });
      }
    } else {
      const { data, error } = await supabase
        .from("crm_lead_links")
        .delete()
        .eq("id", vinculo.id)
        .eq("organization_id", orgId)
        .select("id")
        .maybeSingle();
      if (error) return fail("internal_error", error.message, 500, { requestId });
      if (!data) return fail("not_found", t("Vínculo não encontrado."), 404, { requestId });
    }
  }

  if (mudou) {
    const atividade = await emitLeadActivity(supabase, {
      organizationId: orgId,
      leadId,
      contactId: lead.contact_id,
      type: "lead_edited",
      sourceModule: "crm",
      sourceId: leadId,
      actor: { type: "user", id: authz.user.id },
      reason: motivoDaOperacao[operacao],
      payload: { fields: ["contatos_relacionados"], operation: operacao },
    });
    if (!atividade.ok) {
      await registraFalhaDeAtividade(supabase, {
        organizationId: orgId,
        leadId,
        tipo: "lead_edited",
        origem: "leads/[id]/contatos-relacionados",
        erro: atividade.error,
        requestId,
      });
    }
    await audit({
      action: "lead.updated",
      actorUserId: authz.user.id,
      organizationId: orgId,
      resourceType: "crm_lead",
      resourceId: leadId,
      requestId,
      metadata: { fields: ["contatos_relacionados"], operation: operacao },
    });
  }
  return ok(
    { contact_id: contactId, papel: papel || null, changed: mudou },
    { requestId, status: operacao === "adicionar" ? 201 : 200 },
  );
}

export async function POST(req: NextRequest, ctx: RouteCtx): Promise<Response> {
  return escrever(req, ctx, "adicionar");
}

export async function PATCH(req: NextRequest, ctx: RouteCtx): Promise<Response> {
  return escrever(req, ctx, "editar");
}

export async function DELETE(req: NextRequest, ctx: RouteCtx): Promise<Response> {
  return escrever(req, ctx, "remover");
}
