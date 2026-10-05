/**
 * GET /api/v1/leads/[id]/contatos-relacionados — a F1 da #1506.
 *
 * POR QUE ESTA ROTA EXISTE: o negócio guarda UM contato (`crm_leads.contact_id`)
 * e as outras pessoas viram texto na descrição. O schema já prevê o vínculo —
 * `crm_lead_links` com `target_kind='contact'` (Spec 02 §2.6) — mas nada no
 * produto lê `target_kind='contact'`: nem escritor, nem leitor. Escola (aluno +
 * responsável), clínica (paciente + quem paga) e imobiliária (casal + corretor)
 * cabem todos aqui, sem tabela nova e sem migration.
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

import { ok, fail } from "@/lib/api/wrappers";
import { nomeDoContato } from "@/lib/contacts/rotulo-do-contato";
import { loadAuthUser } from "@/lib/auth/server";
import { traduzir } from "@/lib/i18n/dicionario";
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
  nome: string | null;
  papel: string | null;
  anonimizado: boolean;
}

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
      nome: nomeDoContato(contato),
      papel: papelDo(link.metadata),
      anonimizado: contato.is_anonymized === true,
    });
  }

  return ok(resultado, { requestId });
}
