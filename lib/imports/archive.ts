import { z } from "zod";

export const archiveQuery = z.object({
  table: z.string().regex(/^[a-z_]+$/).max(80).default("contacts"),
  page: z.coerce.number().int().min(1).max(100000).default(1),
  contact: z.string().uuid().optional(),
});

export const archiveManifest = z.object({
  tables: z.record(z.string(), z.object({ count: z.number().int().nonnegative() })),
});

/** Destinos reais do CRM; nenhum path é aceito do JSON de origem. */
export function importedRecordHref(table: string | null, id: string | null): string | null {
  if (!id || !z.string().uuid().safeParse(id).success) return null;
  if (table === "contacts") return `/app/contacts/${id}`;
  if (table === "conversations") return `/app/inbox?id=${id}`;
  return null;
}

export function importedRecordSummary(data: unknown): string | null {
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const record = data as Record<string, unknown>;
  for (const key of ["name", "title", "content", "subject", "description", "markdown", "action", "event_type"])
    if (typeof record[key] === "string" && record[key]) return record[key].slice(0, 500);
  return null;
}

export const ARCHIVE_LABELS: Record<string, string> = {
  contacts: "Contatos", crm_conversations: "Conversas", crm_messages: "Mensagens",
  deals: "Negócios", pipelines: "Funis", pipeline_stages: "Etapas",
  crm_tasks: "Tarefas", crm_notes: "Notas", appointments: "Compromissos",
  crm_files: "Arquivos", profiles: "Perfis de origem", workspace_members: "Membros de origem",
  contact_identities: "Identidades dos contatos", crm_contact_consents: "Evidências legais",
  crm_channels: "Canais de origem", crm_tags: "Etiquetas", crm_conversation_tags: "Etiquetas das conversas",
  crm_channel_events: "Eventos dos canais", crm_ai_memory: "Memória de IA",
  crm_ai_analyses: "Análises de IA", crm_ai_alerts: "Alertas de IA",
  crm_ai_briefings: "Resumos de IA", crm_ai_chat_messages: "Mensagens com a IA",
  crm_ai_chat_threads: "Conversas com a IA", crm_ai_chat_usage: "Uso de IA",
  crm_conversation_assignment_history: "Histórico de responsáveis",
  crm_conversation_status_log: "Histórico de estados das conversas",
  crm_conversation_participants: "Participantes das conversas",
  crm_deal_stage_history: "Histórico de etapas", crm_message_translations: "Traduções das mensagens",
  crm_contact_merge_logs: "Histórico de mesclagens", crm_contact_enrichment: "Informações complementares",
  appointment_event_history: "Histórico da agenda", appointment_no_show_predictions: "Previsões de comparecimento",
  crm_deal_risk_signals: "Sinais de risco", crm_revenue_forecasts: "Previsões de receita",
  crm_objection_events: "Objeções", crm_duplicate_suggestions: "Sugestões de duplicidade",
  workspace_roles: "Papéis de origem", workspace_role_permissions: "Permissões de origem",
  workspace_access_audit_logs: "Auditoria de acesso", workspace_member_channel_restrictions: "Restrições de canais",
  workspace_invitations: "Convites de origem", workspace_subscriptions: "Plano de origem",
  whatsapp_sessions: "Sessões de origem", whatsapp_session_status_log: "Histórico das conexões",
  followup_job_workspace_runs: "Histórico de acompanhamentos", workspaces: "Empresa de origem",
  plans: "Configuração do plano", internal_conversations: "Conversas internas",
  internal_conversation_participants: "Participantes internos", platform_notifications: "Notificações de origem",
  mcp_agent_tokens: "Registros de integração sem credenciais", mcp_audit_log: "Auditoria de integrações",
  admin_audit_log: "Auditoria administrativa",
};
