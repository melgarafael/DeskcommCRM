/**
 * GET /api/v1/leads/proposals — as próximas ações da IA, em lista.
 *
 * POR QUE ESTA ROTA EXISTE: até aqui, uma proposta só era visível para quem
 * abrisse o board e olhasse card por card. Se o vendedor não passasse naquela
 * coluna, a sugestão ficava parada — a morte silenciosa que este épico existe
 * para matar, acontecendo dentro do próprio mecanismo anti-morte.
 *
 * E estava invertido: a proposta AMBÍGUA já tinha lista (vai para a caixa de
 * avisos), e a proposta NORMAL não tinha nenhuma. O caso problemático era mais
 * visível que o caso comum.
 *
 * ⚠️ ROTEAMENTO PELA MESMA FUNÇÃO DO BOARD (`roteiaProximasAcoes`), de
 * propósito. Uma segunda regra de "de qual negócio é esta proposta" divergiria
 * da primeira no primeiro ajuste, e a divergência apareceria como "a lista
 * mostra uma proposta que o card não mostra" — indistinguível de bug de cache
 * para quem reporta.
 *
 * Tenancy: client de sessão (RLS), nunca admin. A lista é o que ESTE usuário
 * pode ver.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { fail, ok } from "@/lib/api/wrappers";
import type { LeadCandidate } from "@/lib/leads/active-lead";
import { roteiaProximasAcoes, type EstadoDoContato } from "@/lib/leads/next-action";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/server";
import { requireAuth } from "@/lib/auth/server";
import { orgAtivaDaApi } from "@/lib/auth/require-role";
import { nomeDoContato } from "@/lib/contacts/rotulo-do-contato";
import { traduzir } from "@/lib/i18n/dicionario";
import { nomesDosAtendentes } from "@/lib/users/nome-do-atendente";
import { extractBearer } from "@/lib/mcp/auth";
import { resolveAuthDual, tetoDeEscritaDoToken } from "@/lib/api/auth-dual";
import { IDIOMA_PADRAO, type Idioma } from "@/lib/i18n/idiomas";

export const dynamic = "force-dynamic";

/** Quantas decisões passadas a aba mostra. Histórico é contexto, não arquivo. */
const LIMITE_HISTORICO = 50;

export interface PropostaPendente {
  lead_id: string;
  lead_title: string;
  stage_name: string | null;
  contact_name: string | null;
  next_action: string;
  /** Identidade da proposta — vai no POST de decisão como trava otimista. */
  seq: number;
  proposed_at: string;
}

export interface DecisaoPassada {
  activity_id: string;
  lead_id: string;
  lead_title: string;
  decision: "approve" | "dismiss";
  next_action: string;
  decided_by: string | null;
  decided_at: string;
}

export async function GET(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();

  const authHeader = req.headers.get("authorization");
  if (extractBearer(authHeader)) {
    const authz = await resolveAuthDual(req, {
      requestId,
      resource: "crm_leads",
      role: "viewer",
      scope: "mcp:read",
    });
    if (!authz.ok) return authz.response;
    const teto = await tetoDeEscritaDoToken(authz, "leads_proposals", requestId);
    if (teto) return teto;
    return responder(authz.supabase, authz.organizationId, authz.idioma ?? IDIOMA_PADRAO, requestId);
  }

  // Sessão do navegador
  const user = await requireAuth();
  const ativa = await orgAtivaDaApi(user, requestId);
  if (!ativa.ok) return ativa.response;
  const activeOrg = ativa.org;
  if (!activeOrg) {
    return fail("forbidden", traduzir("sem organização ativa", user.idioma), 403, { requestId });
  }
  const supabase = await createClient();
  return responder(supabase, activeOrg.orgId, user.idioma, requestId);
}

async function responder(
  supabase: SupabaseClient,
  orgId: string,
  idioma: Idioma,
  requestId: string,
): Promise<Response> {
  // ── PENDENTES ────────────────────────────────────────────────────────────
  const [{ data: estados, error: estadosErr }, { data: candidatos, error: candErr }] =
    await Promise.all([
      supabase
        .from("lead_state")
        .select("contact_id, next_action, next_action_seq, updated_at")
        .eq("organization_id", orgId)
        .not("next_action", "is", null),
      supabase
        .from("crm_leads")
        .select(
          "id, organization_id, pipeline_id, status, last_activity_at, created_at, contact_id",
        )
        .eq("organization_id", orgId)
        .eq("status", "open"),
    ]);
  if (estadosErr) return fail("internal", estadosErr.message, 500, { requestId });
  if (candErr) return fail("internal", candErr.message, 500, { requestId });

  const { porLead } = roteiaProximasAcoes(
    (estados ?? []) as EstadoDoContato[],
    (candidatos ?? []) as Array<LeadCandidate & { contact_id: string | null }>,
  );

  // As ambíguas NÃO entram nesta lista: elas já viram item na caixa de avisos,
  // e repetir aqui faria o mesmo caso pedir duas ações em dois lugares. Lá a
  // pergunta é "de qual negócio é?"; aqui é "aprova ou não?" — perguntas
  // diferentes, telas diferentes.
  const leadIds = [...porLead.keys()];
  const pendentes: PropostaPendente[] = [];

  if (leadIds.length > 0) {
    const { data: leads, error: leadsErr } = await supabase
      .from("crm_leads")
      .select("id, title, contact_id, pipeline_id")
      .eq("organization_id", orgId)
      .in("id", leadIds);
    if (leadsErr) return fail("internal", leadsErr.message, 500, { requestId });

    // Consultas separadas (sem EMBED do PostgREST, que o service role ignora):
    // estágios e contatos, cada uma filtrada pela organização do token.
    const stageIds = [...new Set((leads ?? []).map((l) => l.pipeline_id).filter(Boolean))];
    const stageMap = new Map<string, string>();
    if (stageIds.length > 0) {
      const { data: stages } = await supabase
        .from("crm_stages")
        .select("id, name")
        .eq("organization_id", orgId)
        .in("id", stageIds);
      for (const s of (stages ?? []) as Array<{ id: string; name: string }>) {
        stageMap.set(s.id, s.name);
      }
    }
    const contactIds = [...new Set((leads ?? []).map((l) => l.contact_id).filter(Boolean))];
    const contactMap = new Map<string, { name: string | null; display_name: string | null }>();
    if (contactIds.length > 0) {
      const { data: contacts } = await supabase
        .from("contacts")
        .select("id, name, display_name")
        .eq("organization_id", orgId)
        .in("id", contactIds);
      for (const c of (contacts ?? []) as Array<{ id: string; name: string | null; display_name: string | null }>) {
        contactMap.set(c.id, { name: c.name, display_name: c.display_name });
      }
    }

    for (const l of (leads ?? []) as unknown as Array<{
      id: string;
      title: string | null;
      contact_id: string | null;
      pipeline_id: string | null;
    }>) {
      const proposta = porLead.get(l.id);
      if (!proposta) continue;
      pendentes.push({
        lead_id: l.id,
        lead_title: l.title ?? traduzir("(sem título)", idioma),
        stage_name: l.pipeline_id ? stageMap.get(l.pipeline_id) ?? null : null,
        contact_name: l.contact_id ? nomeDoContato(contactMap.get(l.contact_id) ?? null) : null,
        next_action: proposta.label,
        seq: proposta.seq,
        proposed_at: proposta.proposed_at,
      });
    }
    // Mais antiga primeiro: a que está esperando há mais tempo é a que corre
    // mais risco de apodrecer, e é ela que tem de estar no topo.
    pendentes.sort((a, b) => a.proposed_at.localeCompare(b.proposed_at));
  }

  // ── DECIDIDAS ────────────────────────────────────────────────────────────
  //
  // O histórico é o que PROVA que recusar virou registro. Sem ele, a aba
  // mostraria só o que falta decidir e a recusa continuaria parecendo ausência
  // de decisão — que é exatamente o defeito que a wave 4 consertou.
  const { data: decididas, error: decErr } = await supabase
    .from("crm_lead_activities")
    .select("id, lead_id, type, payload, performed_at, performed_by_user_id, crm_leads!crm_lead_activities_lead_id_fkey(title)")
    .eq("organization_id", orgId)
    .in("type", ["next_action_approved", "next_action_dismissed"])
    .order("performed_at", { ascending: false })
    .limit(LIMITE_HISTORICO);
  if (decErr) return fail("internal", decErr.message, 500, { requestId });

  const linhas = (decididas ?? []) as unknown as Array<{
    id: string;
    lead_id: string | null;
    type: string;
    payload: { next_action?: string } | null;
    performed_at: string;
    performed_by_user_id: string | null;
    crm_leads: { title: string | null } | null;
  }>;

  // NOME DE QUEM DECIDIU vem do metadata do Auth — não existe tabela
  // `profiles` neste schema, e a rota de equipe (`/api/v1/team`) resolve pelo
  // mesmo caminho. Buscar por IDs DISTINTOS: 50 decisões da mesma pessoa custam
  // uma chamada, não cinquenta.
  //
  // Sem service role (ou usuário apagado) a linha fica com "—" e continua
  // honesta: a decisão aconteceu e o registro dela não depende de o autor ainda
  // existir. Perder o nome não pode virar perder a decisão.
  const userIds = [
    ...new Set(linhas.map((d) => d.performed_by_user_id).filter((u): u is string => !!u)),
  ];
  const nomes = await nomesDosAtendentes(orgId, userIds);

  const historico: DecisaoPassada[] = linhas.map((d) => ({
    activity_id: d.id,
    lead_id: d.lead_id ?? "",
    lead_title: d.crm_leads?.title ?? traduzir("(negócio removido)", idioma),
    decision: d.type === "next_action_approved" ? "approve" : "dismiss",
    next_action: d.payload?.next_action ?? "",
    decided_by: d.performed_by_user_id ? (nomes.get(d.performed_by_user_id) ?? null) : null,
    decided_at: d.performed_at,
  }));

  return ok({ pending: pendentes, history: historico }, { requestId });
}
