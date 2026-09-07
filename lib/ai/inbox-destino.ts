import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import type { InboxKind } from "@/lib/agent-engine/db/repository";
import { ROLE_RANK, type Role } from "@/lib/auth/types";
import { logger } from "@/lib/logger";

/** DTO projetado no servidor. O browser nunca deriva URLs de referências livres. */
export type DestinoDoAviso =
  | { estado: "disponivel"; rotulo: string; href: string; orientacao?: string }
  | { estado: "sem_permissao" | "indisponivel" | "sem_destino"; orientacao: string };

interface ReferenciaDoAviso { kind: string; ref_kind: string | null; ref_id: string | null }
interface Alvo { tabela: string; papel: Role; rotulo: string; href: (id: string, pipelineId?: string) => string; ativo?: boolean }

/** Apenas entidades que têm produtor e superfície atual; agenda nasce com a Task 6. */
export const REFERENCIAS_DE_AVISO = {
  ai_agent: { tabela: "ai_agents", papel: "admin", rotulo: "Revisar agente", href: (id: string) => `/app/ai/agents/${id}`, ativo: true },
  appointment: {tabela:"calendar_appointments",papel:"agent",rotulo:"Abrir compromisso",href:(id:string)=>`/app/agenda?compromisso=${id}`},
  conversation: { tabela: "conversations", papel: "agent", rotulo: "Abrir conversa", href: (id: string) => `/app/inbox/${id}` },
  contact: { tabela: "contacts", papel: "agent", rotulo: "Ver contato", href: (id: string) => `/app/contacts/${id}` },
  lead: { tabela: "crm_leads", papel: "agent", rotulo: "Abrir negócio", href: (id: string, pipelineId?: string) => `/app/pipelines/${pipelineId}?lead=${id}` },
  followup_enrollment: { tabela: "followup_enrollments", papel: "viewer", rotulo: "Abrir acompanhamento", href: (id: string) => `/app/ai/followups/enrollments/${id}` },
  channel_session: { tabela: "channel_sessions", papel: "admin", rotulo: "Revisar conexão", href: () => "/app/connections", ativo: true },
  ai_knowledge_source: { tabela: "ai_knowledge_sources", papel: "manager", rotulo: "Abrir base de conhecimento", href: () => "/app/ai/knowledge/sources" },
} satisfies Record<string, Alvo>;

export type InboxRefKind = keyof typeof REFERENCIAS_DE_AVISO | "organization" | "ai_budget" | "job_queue" | "cron_jobs";
type ContextoGeral = { papel: Role; href: string; rotulo: string };
interface Politica { refs: readonly InboxRefKind[]; orientacao: string; geral?: ContextoGeral }
const EVOLUCAO: ContextoGeral = { papel: "manager", href: "/app/ai/evolution", rotulo: "Abrir evolução do assistente" };
const CONEXOES: ContextoGeral = { papel: "admin", href: "/app/connections", rotulo: "Revisar conexões" };

/** Completude em compile time; pares desconhecidos em clones falham fechados. */
export const POLITICAS_DE_AVISO = {
  appointment_outcome_required:{refs:["appointment"],orientacao:"Abra o compromisso e confirme a presença."},
  appointment_recovery_review:{refs:["appointment"],orientacao:"Confira o motivo e escolha o próximo passo no compromisso."},
  routing_unassigned: { refs: ["conversation"], orientacao: "Confira os responsáveis em Configurações → Atendimento." },
  qr_rescan: { refs: ["channel_session"], orientacao: "Peça a quem administra para revisar a conexão do WhatsApp." },
  job_dead: { refs: ["conversation", "job_queue", "cron_jobs"], orientacao: "Confira o motivo deste aviso com quem administra antes de tentar a operação novamente." },
  event_dead: { refs: [], orientacao: "Peça a quem administra para conferir o processamento descrito neste aviso." },
  budget_exceeded: { refs: ["ai_budget"], orientacao: "Peça ao gestor para revisar o limite e o uso de IA." },
  budget_warning: { refs: ["ai_budget"], orientacao: "Peça ao gestor para revisar o limite e o uso de IA." },
  handoff: { refs: ["contact", "conversation"], orientacao: "Confira o atendimento descrito e combine quem assume o próximo passo." },
  promotion_review: { refs: [], orientacao: "Na evolução do assistente, confira as propostas disponíveis. Este aviso não identifica uma proposta específica.", geral: EVOLUCAO },
  judge_unaligned: { refs: [], orientacao: "Na evolução do assistente, confira a avaliação de qualidade. Este aviso não identifica uma avaliação específica.", geral: EVOLUCAO },
  followup_dead: { refs: ["followup_enrollment"], orientacao: "Peça ao gestor para revisar o acompanhamento que parou." },
  snooze_expired: { refs: ["conversation"], orientacao: "Confira se cabe retomar o atendimento descrito neste aviso." },
  next_action_ambiguous: { refs: ["contact"], orientacao: "Confira os negócios do contato e escolha a qual deles pertence a próxima ação." },
  risk_backlog_seeded: { refs: ["organization"], orientacao: "Revise os negócios parados no Radar e defina o próximo passo." },
  reactivation_expired: { refs: ["organization"], orientacao: "Revise no Radar se ainda cabe retomar os negócios indicados." },
  capabilities_missing: { refs: ["conversation"], orientacao: "Peça ao gestor para revisar as ferramentas habilitadas para o assistente deste atendimento." },
  message_send_stuck: { refs: ["conversation"], orientacao: "Confira a resposta que não chegou antes de decidir se precisa enviar novamente." },
  midia_nao_lida: { refs: [], orientacao: "Peça ao gestor para revisar o provedor e as credenciais de leitura de fotos e áudios.", geral: { papel: "manager", href: "/app/ai/providers", rotulo: "Revisar provedores de IA" } },
  channel_template_review: { refs: [], orientacao: "Confira os modelos na conexão WhatsApp via Parceiro. Este aviso não identifica um modelo específico.", geral: { papel: "admin", href: "/app/connections?aba=parceiro&sub=templates", rotulo: "Revisar modelos do canal" } },
  channel_number_alert: { refs: ["channel_session"], orientacao: "Peça a quem administra para revisar a situação do número nas conexões.", geral: CONEXOES },
  promise_unfulfilled: { refs: ["conversation"], orientacao: "Confira o compromisso descrito e defina quem fica responsável." },
  contact_proposal_expired: { refs: ["organization"], orientacao: "A sugestão venceu. Se a informação ainda for relevante, confirme com o cliente antes de editar sua ficha." },
  conhecimento_nao_indexado: { refs: ["ai_knowledge_source"], orientacao: "Peça ao gestor para conferir o material e o motivo da falha na base de conhecimento." },
  other: { refs: ["lead", "channel_session", "appointment", "ai_agent"], orientacao: "Confira a situação descrita neste aviso com a pessoa responsável." },
} satisfies Record<InboxKind, Politica>;

const SEM_DESTINO: DestinoDoAviso = { estado: "sem_destino", orientacao: "Este aviso não tem um contexto que possa ser aberto nesta versão." };
const INDISPONIVEL: DestinoDoAviso = { estado: "indisponivel", orientacao: "Este contexto não está disponível para você. Ele pode ter sido removido ou seu acesso pode ter mudado." };
const uuid = z.uuid();
function politica(item: ReferenciaDoAviso): Politica | undefined {
  return Object.hasOwn(POLITICAS_DE_AVISO, item.kind) ? POLITICAS_DE_AVISO[item.kind as InboxKind] : undefined;
}
function alvo(ref: string | null): Alvo | undefined {
  return ref && Object.hasOwn(REFERENCIAS_DE_AVISO, ref) ? REFERENCIAS_DE_AVISO[ref as keyof typeof REFERENCIAS_DE_AVISO] : undefined;
}
function permite(papel: Role, minimo: Role) { return ROLE_RANK[papel] >= ROLE_RANK[minimo]; }
function semPermissao(minimo: Role): DestinoDoAviso {
  return { estado: "sem_permissao", orientacao: minimo === "admin" ? "Peça a quem administra para revisar este contexto." : "Peça ao gestor para revisar este contexto." };
}

/**
 * Recebe EXCLUSIVAMENTE o client autenticado da request. A RLS é dona da regra
 * own/own_and_unassigned, inclusive em suporte; existência via admin não basta.
 * Uma consulta por tipo, não por aviso. Erro, ausência e referência externa não
 * revelam existência nem liberam URL. Não há escrita ou resolução automática.
 */
export async function resolverDestinosDosAvisos<T extends ReferenciaDoAviso>(
  leitor: SupabaseClient, organizationId: string, papel: Role, itens: T[],
): Promise<Array<T & { destination: DestinoDoAviso }>> {
  const grupos = new Map<string, Set<string>>();
  for (const item of itens) {
    const p = politica(item), a = alvo(item.ref_kind);
    if (!p || !a || !p.refs.includes(item.ref_kind as InboxRefKind) || !permite(papel, a.papel) || !uuid.safeParse(item.ref_id).success) continue;
    const ids = grupos.get(item.ref_kind!) ?? new Set<string>();
    ids.add(item.ref_id!);
    grupos.set(item.ref_kind!, ids);
  }
  const visiveis = new Map<string, Set<string>>();
  const funilPorLead = new Map<string, string>();
  await Promise.all([...grupos].map(async ([ref, ids]) => {
    const a = alvo(ref)!;
    try {
      let query = leitor.from(a.tabela).select(ref === "lead" ? "id, pipeline_id" : "id").eq("organization_id", organizationId).in("id", [...ids]);
      if (a.ativo) query = query.is("archived_at", null);
      const { data, error } = await query;
      if (error) throw new Error("consulta_indisponivel");
      if (ref === "lead") {
        const leads = (data ?? []) as unknown as Array<{ id: string; pipeline_id: string }>;
        const idsDeFunis = [...new Set(leads.map(l => l.pipeline_id).filter(id => uuid.safeParse(id).success))];
        if (idsDeFunis.length > 0) {
          // A FK simples não prova organização: legado inconsistente também
          // precisa falhar fechado. Um segundo lote valida a superfície real.
          const { data: funis, error: erroFunis } = await leitor.from("crm_pipelines").select("id").eq("organization_id", organizationId).in("id", idsDeFunis);
          if (erroFunis) throw new Error("consulta_indisponivel");
          const permitidos = new Set((funis ?? []).map((f: { id: string }) => f.id));
          for (const lead of leads) if (permitidos.has(lead.pipeline_id)) funilPorLead.set(lead.id, lead.pipeline_id);
        }
        visiveis.set(ref, new Set(funilPorLead.keys()));
      } else visiveis.set(ref, new Set(((data ?? []) as unknown as Array<{ id: string }>).map(linha => linha.id)));
    } catch {
      // Somente catálogo fechado e contagem. Nunca erro bruto, título, UUID ou payload.
      logger.warn("[inbox] contexto indisponível na projeção", { referencia: ref, quantidade: ids.size });
    }
  }));
  return itens.map((item) => {
    const p = politica(item);
    let destination: DestinoDoAviso = SEM_DESTINO;
    if (p) {
      if (item.ref_kind === null && item.ref_id === null) {
        destination = p.geral
          ? permite(papel, p.geral.papel) ? { estado: "disponivel", href: p.geral.href, rotulo: p.geral.rotulo, orientacao: p.orientacao } : semPermissao(p.geral.papel)
          : { estado: "sem_destino", orientacao: p.orientacao };
      } else if (!p.refs.includes(item.ref_kind as InboxRefKind) || !uuid.safeParse(item.ref_id).success) {
        destination = INDISPONIVEL;
      } else {
        const a = alvo(item.ref_kind);
        if (a) {
          destination = !permite(papel, a.papel) ? semPermissao(a.papel)
            : visiveis.get(item.ref_kind!)?.has(item.ref_id!)
              ? { estado: "disponivel", rotulo: item.kind === "message_send_stuck" ? "Abrir uma conversa afetada" : a.rotulo, href: a.href(item.ref_id!, funilPorLead.get(item.ref_id!)) }
              : INDISPONIVEL;
        } else if (item.ref_kind === "ai_budget" || item.ref_kind === "organization") {
          destination = item.ref_id !== organizationId ? INDISPONIVEL
            : item.kind === "contact_proposal_expired" ? { estado: "sem_destino", orientacao: p.orientacao }
            : !permite(papel, item.ref_kind === "ai_budget" ? "manager" : "agent") ? semPermissao("manager")
            : { estado: "disponivel", href: item.ref_kind === "ai_budget" ? "/app/ai/usage" : "/app/radar", rotulo: item.ref_kind === "ai_budget" ? "Abrir uso de IA" : "Abrir Radar" };
        } else destination = { estado: "sem_destino", orientacao: p.orientacao };
      }
    }
    return { ...item, destination };
  });
}
