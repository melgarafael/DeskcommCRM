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
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { isServiceRoleConfigured } from "@/lib/audit";
import { requireAuth, resolveActiveOrg } from "@/lib/auth/server";
import { traduzir } from "@/lib/i18n/dicionario";

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
  void req;

  const user = await requireAuth();
  const activeOrg = await resolveActiveOrg(user);
  if (!activeOrg) {
    return fail("forbidden", traduzir("sem organização ativa", user.idioma), 403, { requestId });
  }
  const orgId = activeOrg.orgId;
  const supabase = await createClient();

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
      .select("id, title, contact_id, crm_stages(name), contacts(display_name)")
      .eq("organization_id", orgId)
      .in("id", leadIds);
    if (leadsErr) return fail("internal", leadsErr.message, 500, { requestId });

    for (const l of (leads ?? []) as unknown as Array<{
      id: string;
      title: string | null;
      crm_stages: { name: string | null } | null;
      contacts: { display_name: string | null } | null;
    }>) {
      const proposta = porLead.get(l.id);
      if (!proposta) continue;
      pendentes.push({
        lead_id: l.id,
        lead_title: l.title ?? traduzir("(sem título)", user.idioma),
        stage_name: l.crm_stages?.name ?? null,
        contact_name: l.contacts?.display_name ?? null,
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
    .select("id, lead_id, type, payload, performed_at, performed_by_user_id, crm_leads(title)")
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
  const nomes = new Map<string, string>();
  if (userIds.length > 0 && isServiceRoleConfigured()) {
    const admin = createAdminClient();
    await Promise.all(
      userIds.map(async (uid) => {
        const { data } = await admin.auth.admin.getUserById(uid);
        const nome = data?.user?.user_metadata?.full_name as string | undefined;
        if (nome) nomes.set(uid, nome);
      }),
    );
  }

  const historico: DecisaoPassada[] = linhas.map((d) => ({
    activity_id: d.id,
    lead_id: d.lead_id ?? "",
    lead_title: d.crm_leads?.title ?? traduzir("(negócio removido)", user.idioma),
    decision: d.type === "next_action_approved" ? "approve" : "dismiss",
    next_action: d.payload?.next_action ?? "",
    decided_by: d.performed_by_user_id ? (nomes.get(d.performed_by_user_id) ?? null) : null,
    decided_at: d.performed_at,
  }));

  return ok({ pending: pendentes, history: historico }, { requestId });
}
