/**
 * /api/v1/leads/[id]/contatos-relacionados — as outras pessoas do negócio.
 *
 *   GET    — o leitor (a F1 da #1506).
 *   POST   — o escritor: liga um contato ao negócio, com papel.
 *   DELETE — desliga o vínculo.
 *
 * POR QUE ESTA ROTA EXISTE: o negócio guarda UM contato (`crm_leads.contact_id`)
 * e as outras pessoas viram texto na descrição. O schema já prevê o vínculo —
 * `crm_lead_links` com `target_kind='contact'` (Spec 02 §2.6) — mas nada no
 * produto lê `target_kind='contact'`: nem escritor, nem leitor. Escola (aluno +
 * responsável), clínica (paciente + quem paga) e imobiliária (casal + corretor)
 * cabem todos aqui, sem tabela nova e sem migration.
 *
 * O ESCRITOR É A FATIA 1 DA #3083. Antes dele a lista do dossiê só sabia LER:
 * `INSERT` em `crm_lead_links` com `target_kind='contact'` não existia em lugar
 * nenhum do produto (o escritor da Agenda grava `appointment`; ver o
 * `_handler.ts` de `agenda/agendamentos`), então adicionar, remover ou dar
 * papel a um participante era impossível pela tela.
 *
 * TRÊS DECISÕES QUE O TESTE PRENDE:
 *
 *  1. DEFESA ALÉM DA RLS. `target_id` não é FK para `contacts` — é o preço do
 *     `target_kind` polimórfico — então um link forjado pode apontar para
 *     contato de outra organização. A RLS derruba isso na consulta; a checagem
 *     de org aqui embaixo derruba mesmo se um dia a consulta rodar sem RLS.
 *     Os dois níveis precisam existir: é o segundo que sobrevive quando o
 *     primeiro falha. Vale igual para a ESCRITA, e é ela que o teste da #3083
 *     sabota: a RLS do `crm_lead_links` só olha a org do NEGÓCIO (que é a do
 *     caller), então sem a checagem do alvo um POST com o id de um contato de
 *     outra organização GRAVARIA o vínculo.
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
import { traduzir } from "@/lib/i18n/dicionario";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { createClient } from "@/lib/supabase/server";
import { logger } from "@/lib/logger";

export const dynamic = "force-dynamic";

/**
 * O VOCABULÁRIO DESTE VÍNCULO, num lugar só.
 *
 * `target_kind` é polimórfico (CHECK de sete valores no baseline) e
 * `link_kind` é a segunda chave do índice único; escrever os dois literais
 * três vezes — no leitor, no INSERT e no DELETE — é como uma das três pontas
 * diverge e a linha some da tela sem erro nenhum.
 */
export const ALVO_DE_CONTATO = "contact" as const;
export const VINCULO_DE_CONTATO = "related" as const;

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
  phone_number?: string | null;
}

/** O que a tela recebe por pessoa: a âncora, o nome, o papel e o estado LGPD. */
export interface ContatoRelacionado {
  contact_id: string;
  nome: string | null;
  papel: string | null;
  anonimizado: boolean;
  /**
   * O número da pessoa e a conversa mais recente dela (#3669): com o comprador
   * e o fixo da loja na mesma lista, o número É o que distingue um do outro, e
   * a conversa é o atalho que a vendedora procura. AUSENTES quando não há
   * (sem telefone, anonimizado, nenhuma conversa) — nunca uma string vazia que
   * a tela teria de adivinhar.
   */
  telefone?: string;
  conversa_id?: string;
}

/**
 * `metadata.papel` é texto livre, com teto de 40 (o mesmo da régua abaixo);
 * aqui só lemos o que veio.
 */
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
    .eq("target_kind", ALVO_DE_CONTATO)
    .eq("link_kind", VINCULO_DE_CONTATO)
    // Ordem explícita: sem ela, a ordem da lista e o papel que vence na
    // deduplicação ficariam por conta da ordem física da tabela.
    .order("created_at", { ascending: true });
  if (linksErr) return fail("internal_error", linksErr.message, 500, { requestId });

  const linhasDeLink = (links ?? []) as unknown as { target_id: string; metadata: unknown }[];
  const alvos = [...new Set(linhasDeLink.map((l) => l.target_id))];
  if (alvos.length === 0) return ok([], { requestId });

  const { data: contatos, error: contatosErr } = await supabase
    .from("contacts")
    .select("id, organization_id, name, display_name, is_merged_into, is_anonymized, phone_number")
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
      .select("id, organization_id, name, display_name, is_merged_into, is_anonymized, phone_number")
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
    const anonimizado = contato.is_anonymized === true;
    resultado.push({
      contact_id: contato.id,
      nome: nomeDoContato(contato),
      papel: papelDo(link.metadata),
      anonimizado,
      // A cascata LGPD já redigiu o número do anonimizado; a rota não o
      // mostra nem assim, para não depender da redação ter rodado.
      ...(!anonimizado && contato.phone_number ? { telefone: contato.phone_number } : {}),
    });
  }

  // A CONVERSA de cada pessoa, a mais recente (mesma ordem do quadro, rota
  // `pipelines/[id]/board`). Uma consulta para a lista inteira, com o filtro de
  // organização explícito. Falhar aqui não derruba a lista: as pessoas e os
  // números continuam sendo a resposta, só sem o atalho — e o motivo vai para o
  // log, não some.
  if (resultado.length > 0) {
    const { data: conversas, error: conversasErr } = await supabase
      .from("conversations")
      .select("id, contact_id, last_message_at")
      .eq("organization_id", orgId)
      .in(
        "contact_id",
        resultado.map((p) => p.contact_id),
      )
      .order("last_message_at", { ascending: false, nullsFirst: false });
    if (conversasErr) {
      logger.warn("contatos-relacionados: conversas não lidas", {
        requestId,
        error: conversasErr.message,
      });
    } else {
      const conversaDe = new Map<string, string>();
      for (const c of (conversas ?? []) as unknown as { id: string; contact_id: string }[]) {
        if (!conversaDe.has(c.contact_id)) conversaDe.set(c.contact_id, c.id);
      }
      for (const pessoa of resultado) {
        const conversa = conversaDe.get(pessoa.contact_id);
        if (conversa) pessoa.conversa_id = conversa;
      }
    }
  }

  return ok(resultado, { requestId });
}

/** O corpo do POST: quem entra, e com que papel. */
const CorpoDoParticipante = z.object({
  contact_id: z.string().uuid(),
  /**
   * Texto livre do operador ("pagante", "passageiro", "responsável
   * financeiro"), com teto de 40. Ausente ou em branco LIMPA o papel — é assim
   * que a tela tira um papel sem tirar a pessoa.
   */
  papel: z.string().trim().max(40).nullish(),
});

/** O alvo do DELETE — na query, porque DELETE com corpo não é portátil. */
const AlvoDoVinculo = z.object({ contact_id: z.string().uuid() });

/**
 * O NEGÓCIO DO CALLER, pela RLS — nunca pelo body.
 *
 * As três pontas (o leitor, o INSERT e o DELETE) fazem a MESMA pergunta: de
 * quem é este negócio? Aqui ela está escrita uma vez só, e é a organização
 * desta resposta que filtra as escritas todas.
 *
 * Devolve resultado, e não exceção: a falha do banco vira 500 com a mensagem
 * do PostgREST, que é o que o resto do arquivo faz — e um `throw` obrigaria
 * cada chamador a repetir o mesmo try/catch.
 */
type NegocioDoCaller =
  | { ok: true; lead: { id: string; organization_id: string; contact_id: string | null } | null }
  | { ok: false; message: string };

async function negocioDoCaller(
  supabase: Awaited<ReturnType<typeof createClient>>,
  leadId: string,
): Promise<NegocioDoCaller> {
  const { data, error } = await supabase
    .from("crm_leads")
    .select("id, organization_id, contact_id")
    .eq("id", leadId)
    .maybeSingle();
  if (error) return { ok: false, message: error.message };
  return {
    ok: true,
    lead:
      (data as { id: string; organization_id: string; contact_id: string | null } | null) ?? null,
  };
}

export async function POST(req: NextRequest, ctx: RouteCtx): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const { id: leadId } = await ctx.params;

  // Escrita é `agent`+ (spec 13 §4): `viewer` lê a lista e não a escreve.
  // A guarda de suporte não substitui o papel — as duas valem.
  const authz = await requireRole("agent", { requestId, resource: "crm_lead_links" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);

  const parsed = CorpoDoParticipante.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return fail("validation_failed", t("Corpo inválido."), 422, {
      requestId,
      details: { issues: parsed.error.issues },
    });
  }
  const { contact_id: contactId, papel } = parsed.data;

  const supabase = await createClient();

  const busca = await negocioDoCaller(supabase, leadId);
  if (!busca.ok) return fail("internal_error", busca.message, 500, { requestId });
  const lead = busca.lead;
  if (!lead) return fail("not_found", t("Negócio não encontrado."), 404, { requestId });

  // O PRINCIPAL NÃO É PARTICIPANTE. Ele já é a pessoa do card e do cabeçalho do
  // dossiê; deixá-lo entrar aqui o exibiria duas vezes na mesma tela, e a
  // segunda cópia seria a que ninguém sabe que pode apagar.
  if (lead.contact_id === contactId) {
    return fail(
      "contact_is_principal",
      t("Este contato já é o contato principal do negócio."),
      409,
      { requestId },
    );
  }

  // DEFESA EM PROFUNDIDADE ALÉM DA RLS, do lado da ESCRITA — o mesmo raciocínio
  // do leitor, e é esta checagem que o teste da #3083 sabota. `target_id` não é
  // FK para `contacts`: o id sozinho não diz de quem é a linha. A RLS do
  // `crm_lead_links` só confere a organização do NEGÓCIO (a do caller), então
  // sem esta linha um POST com o id de um contato de OUTRA organização gravaria
  // o vínculo, e o leitor o descartaria só na exibição — a sujeira ficaria no
  // banco, invisível para quem a criou.
  const { data: contato, error: contatoErr } = await supabase
    .from("contacts")
    .select("id, organization_id")
    .eq("id", contactId)
    .maybeSingle();
  if (contatoErr) return fail("internal_error", contatoErr.message, 500, { requestId });
  if (
    !contato ||
    (contato as { organization_id: string }).organization_id !== lead.organization_id
  ) {
    return fail("not_found", t("Contato não encontrado."), 404, { requestId });
  }

  // UPSERT no índice único `uniq_crm_lead_links_lead_target_link`
  // (lead_id, target_kind, target_id, link_kind): o segundo POST do MESMO
  // contato é "dar papel", não uma segunda linha. Sem ele, o índice único
  // devolveria 23505 e a tela mostraria erro de banco para um gesto legítimo.
  const { error: upsertErr } = await supabase.from("crm_lead_links").upsert(
    {
      organization_id: lead.organization_id,
      lead_id: leadId,
      target_kind: ALVO_DE_CONTATO,
      target_id: contactId,
      link_kind: VINCULO_DE_CONTATO,
      // `metadata` é NOT NULL com default `{}`: papel em branco é objeto vazio,
      // nunca null.
      metadata: papel ? { papel } : {},
      // Quem deu o papel — o último a escrever, que é quem responde por ele.
      created_by_user_id: authz.user.id,
    },
    { onConflict: "lead_id,target_kind,target_id,link_kind" },
  );
  if (upsertErr) return fail("internal_error", upsertErr.message, 500, { requestId });

  // O papel é texto livre: a trilha guarda só SE havia papel, nunca o texto.
  await audit({
    action: "lead.participant_added",
    actorUserId: authz.user.id,
    organizationId: lead.organization_id,
    resourceType: "crm_lead",
    resourceId: leadId,
    requestId,
    metadata: { contact_id: contactId, com_papel: !!papel },
  });

  return ok({ contact_id: contactId, papel: papel || null }, { status: 201, requestId });
}

export async function DELETE(req: NextRequest, ctx: RouteCtx): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const { id: leadId } = await ctx.params;

  const authz = await requireRole("agent", { requestId, resource: "crm_lead_links" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);

  const parsed = AlvoDoVinculo.safeParse({
    contact_id: req.nextUrl.searchParams.get("contact_id"),
  });
  if (!parsed.success) {
    return fail("validation_failed", t("Corpo inválido."), 422, {
      requestId,
      details: { issues: parsed.error.issues },
    });
  }
  const contactId = parsed.data.contact_id;

  const supabase = await createClient();

  const busca = await negocioDoCaller(supabase, leadId);
  if (!busca.ok) return fail("internal_error", busca.message, 500, { requestId });
  const lead = busca.lead;
  if (!lead) return fail("not_found", t("Negócio não encontrado."), 404, { requestId });

  // O filtro de organização EXPLÍCITO, como no leitor: o DELETE apaga o vínculo
  // do negócio que o caller provou — nunca "todo vínculo com este contato".
  const { data: apagadas, error: delErr } = await supabase
    .from("crm_lead_links")
    .delete()
    .eq("lead_id", leadId)
    .eq("organization_id", lead.organization_id)
    .eq("target_kind", ALVO_DE_CONTATO)
    .eq("link_kind", VINCULO_DE_CONTATO)
    .eq("target_id", contactId)
    .select("target_id");
  if (delErr) return fail("internal_error", delErr.message, 500, { requestId });

  // DELETE de vínculo que não existe não é mutação: não audita, e a resposta
  // não afirma uma remoção que não houve.
  const removido = (apagadas ?? []).length > 0;
  if (removido) {
    await audit({
      action: "lead.participant_removed",
      actorUserId: authz.user.id,
      organizationId: lead.organization_id,
      resourceType: "crm_lead",
      resourceId: leadId,
      requestId,
      metadata: { contact_id: contactId },
    });
  }

  return ok({ contact_id: contactId, removido }, { requestId });
}
