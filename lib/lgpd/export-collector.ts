/**
 * LGPD export collector — aggregates all personal data the CRM holds about
 * one contact (Art. 18 II — direito de acesso).
 *
 * CLAUDE.md §LGPD: every query filters `organization_id` programmatically
 * (admin client bypasses RLS). PII is NEVER logged — only ids and counts.
 */

import { createAdminClient } from "@/lib/supabase/admin";
import { logger } from "@/lib/logger";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface ContactSnapshot {
  id: string;
  name: string | null;
  display_name: string | null;
  email: string | null;
  phone_number: string | null;
  cpf_present: boolean;
  birthdate: string | null;
  is_blocked: boolean;
  is_anonymized: boolean;
  consent: Record<string, unknown> | null;
  tags: string[];
  source: string | null;
  source_metadata: Record<string, unknown> | null;
  created_at: string;
  last_activity_at: string | null;
}

export interface ConsentRow {
  scope: string;
  granted: boolean;
  granted_at: string | null;
  source?: string | null;
}

export interface ConversationRow {
  id: string;
  status: string;
  channel: string;
  last_inbound_at: string | null;
  last_message_at: string | null;
  is_group: boolean;
  created_at: string;
}

export interface MessageRow {
  id: string;
  conversation_id: string;
  direction: string;
  type: string;
  status: string;
  body: string | null;
  has_media: boolean;
  sent_at: string | null;
  created_at: string;
}

export interface LeadRow {
  id: string;
  pipeline_id: string;
  stage_id: string;
  title: string | null;
  status: string;
  value_cents: number | null;
  currency: string | null;
  created_at: string;
}

export interface OrderRow {
  id: string;
  external_id: string | null;
  external_provider: string | null;
  status: string;
  total_cents: number | null;
  currency: string | null;
  ordered_at: string | null;
}

export interface ActivityRow {
  id: string;
  lead_id: string | null;
  type: string;
  source_module: string | null;
  performed_at: string;
}

/**
 * Compromisso da agenda do titular.
 *
 * As colunas são as MESMAS que a migration 0184 redige ao anonimizar — e não é
 * coincidência: o que se apaga a pedido do titular é exatamente o que se
 * entrega a pedido dele. `starts_at`/`ends_at`/`status` a 0184 PRESERVA (é
 * registro de operação da clínica), e ainda assim entram aqui: o Art. 18 II é
 * sobre o que a organização sabe A RESPEITO DELE, e "houve consulta em tal dia"
 * é a informação mais legível que este export carrega.
 */
export interface AppointmentRow {
  id: string;
  title: string | null;
  description: string | null;
  notes: string | null;
  location_details: string | null;
  cancellation_reason: string | null;
  starts_at: string;
  ends_at: string;
  time_zone: string;
  status: string;
}

/**
 * Tarefa combinada SOBRE a pessoa (migration 0210).
 *
 * ⚠️ ESTE BLOCO NASCEU COM A OUTRA METADE, e não depois dela. A migration liga o
 * trigger `trg_redigir_tarefas_ao_anonimizar`, que troca `title` e apaga
 * `description` quando o titular pede apagamento — e neste repo redigir e
 * exportar sempre andam juntos: o que se apaga a pedido do titular é o que se
 * entrega a pedido dele. Foi assim que `calendar_appointments` e
 * `webhook_lead_captures` chegaram aqui, as duas depois do fato, achadas por
 * `tests/unit/lgpd-exporta-o-que-redige.test.ts`.
 *
 * `due_date`, `status` e `priority` vão junto porque o titular tem direito a
 * saber não só que a empresa escreveu algo sobre ele, mas quando ela combinou
 * agir — que é a informação que dá sentido ao texto.
 */
export interface TaskRow {
  id: string;
  title: string;
  description: string | null;
  due_date: string | null;
  status: string;
  priority: string;
}

/**
 * Captação por webhook — de onde a pessoa veio.
 *
 * ⚠️ ESTA NÃO É DA ENTREGA DO CALENDÁRIO. Ela apareceu porque o gate novo
 * (`tests/unit/lgpd-exporta-o-que-redige.test.ts`) DERIVA a lista das duas
 * pontas em vez de escrevê-la: a mesma classe de defeito tinha duas instâncias,
 * e a segunda ninguém sabia que existia. Uma allowlist fixa teria fechado só a
 * que eu já conhecia.
 *
 * As colunas são exatamente as que `fn_redigir_captacoes_do_contato_anonimizado`
 * zera — inclusive `remote_ip` e `user_agent`, que a LGPD trata como dado
 * pessoal e que a organização guarda a respeito do titular.
 */
export interface CaptureRow {
  id: string;
  source_name: string | null;
  outcome: string;
  captured_name: string | null;
  captured_phone: string | null;
  captured_email: string | null;
  fields: unknown;
  utm: unknown;
  remote_ip: string | null;
  user_agent: string | null;
  received_at: string;
}

export interface AuditRow {
  id: string;
  action: string;
  resource_type: string | null;
  resource_id: string | null;
  created_at: string;
}

export interface ExportPayload {
  request_id: string;
  organization_id: string;
  /**
   * Razão social do CONTROLADOR (`organizations.legal_name`, `NOT NULL` em
   * `supabase/baseline.sql:1749`). É o que o rodapé do relatório imprime — e é
   * de propósito que NÃO é a marca: ver `lib/lgpd/pdf-renderer.tsx`.
   */
  organization_legal_name: string;
  /** Nome fantasia. Não vai para o rodapé; existe para o JSON do export. */
  organization_display_name: string;
  /** Encarregado da organização. `null` cai em `env.LGPD_DPO_EMAIL`. */
  dpo_email: string | null;
  generated_at: string;
  no_local_footprint: boolean;
  contact: ContactSnapshot | null;
  consents: ConsentRow[];
  conversations: ConversationRow[];
  messages_count_total: number;
  messages_recent: MessageRow[];
  leads: LeadRow[];
  orders: OrderRow[];
  activities: ActivityRow[];
  appointments: AppointmentRow[];
  tasks: TaskRow[];
  webhook_captures: CaptureRow[];
  audit_log_extract: AuditRow[];
}

// ---------------------------------------------------------------------------
// collectExportData
// ---------------------------------------------------------------------------

interface CollectArgs {
  organizationId: string;
  requestId: string;
  contactId: string | null;
  externalCustomerId: string | null;
}

const RECENT_MESSAGES_LIMIT = 100;
const AUDIT_LIMIT = 200;

/** A identidade JURÍDICA da organização — quem responde pelos dados. */
interface Controlador {
  legal_name: string;
  display_name: string;
  dpo_email: string | null;
}

/**
 * Lê o controlador. NUNCA lança e nunca inventa: se a leitura falhar, os campos
 * saem vazios e o rodapé mostra o traço de campo ausente. Abortar o export
 * seria trocar um rodapé feio por um SLA legal de D+7 estourado; preencher com
 * o nome do produto seria escrever a entidade errada num documento jurídico.
 */
async function lerControlador(
  admin: ReturnType<typeof createAdminClient>,
  organizationId: string,
  requestId: string,
): Promise<Controlador> {
  const vazio: Controlador = { legal_name: "", display_name: "", dpo_email: null };
  const { data, error } = await admin
    .from("organizations")
    .select("legal_name, display_name, dpo_email")
    .eq("id", organizationId)
    .maybeSingle();
  if (error || !data) {
    logger.warn("[lgpd-export-worker] organization load failed", {
      request_id: requestId,
      error: error?.message ?? "not_found",
    });
    return vazio;
  }
  return {
    legal_name: data.legal_name ?? "",
    display_name: data.display_name ?? "",
    dpo_email: data.dpo_email ?? null,
  };
}

export async function collectExportData(args: CollectArgs): Promise<ExportPayload> {
  const admin = createAdminClient();
  const { organizationId, requestId, externalCustomerId } = args;
  // ANTES do primeiro `return`: o caminho "nenhum dado localizado" também gera
  // um relatório entregue ao titular, e ele precisa nomear o controlador igual.
  const controlador = await lerControlador(admin, organizationId, requestId);
  let contactId = args.contactId;

  // Resolve contact_id when only external customer id is provided.
  if (!contactId && externalCustomerId) {
    const { data, error } = await admin
      .from("contacts")
      .select("id")
      .eq("organization_id", organizationId)
      .eq("source", "nuvemshop")
      .eq("source_metadata->>nuvemshop_customer_id", externalCustomerId)
      .maybeSingle();
    if (error) {
      logger.warn("[lgpd-export-worker] resolve-by-external failed", {
        request_id: requestId,
        error: error.message,
      });
    }
    if (data) contactId = data.id;
  }

  // No contact AND no external customer -> empty footprint.
  if (!contactId && !externalCustomerId) {
    return emptyPayload(requestId, organizationId, controlador);
  }

  // Contact snapshot (PII intentionally retained — this report is the data
  // owner's right of access; only logs/metadata stay sanitized).
  let contact: ContactSnapshot | null = null;
  if (contactId) {
    const { data, error } = await admin
      .from("contacts")
      .select(
        "id, name, display_name, email, phone_number, cpf_encrypted, birthdate, is_blocked, is_anonymized, consent, tags, source, source_metadata, custom_fields, created_at, last_activity_at",
      )
      .eq("organization_id", organizationId)
      .eq("id", contactId)
      .maybeSingle();
    if (error) {
      logger.warn("[lgpd-export-worker] contact load failed", {
        request_id: requestId,
        error: error.message,
      });
    }
    if (data) {
      contact = {
        id: data.id,
        name: data.name ?? null,
        display_name: data.display_name ?? null,
        email: data.email ?? null,
        phone_number: data.phone_number ?? null,
        cpf_present: Boolean(data.cpf_encrypted),
        birthdate: data.birthdate ?? null,
        is_blocked: Boolean(data.is_blocked),
        is_anonymized: Boolean(data.is_anonymized),
        consent: (data.consent as Record<string, unknown> | null) ?? null,
        tags: Array.isArray(data.tags) ? (data.tags as string[]) : [],
        source: data.source ?? null,
        source_metadata: (data.source_metadata as Record<string, unknown> | null) ?? null,
        created_at: data.created_at,
        last_activity_at: data.last_activity_at ?? null,
      };
    }
  }

  // No `consents` table in current schema; legal basis is in contacts.consent JSONB.
  const consents: ConsentRow[] = [];
  if (contact?.consent && typeof contact.consent === "object") {
    for (const [scope, value] of Object.entries(contact.consent)) {
      if (value && typeof value === "object") {
        const v = value as Record<string, unknown>;
        consents.push({
          scope,
          granted: Boolean(v.granted),
          granted_at: typeof v.granted_at === "string" ? v.granted_at : null,
          source: typeof v.source === "string" ? v.source : null,
        });
      } else {
        consents.push({
          scope,
          granted: Boolean(value),
          granted_at: null,
        });
      }
    }
  }

  // Conversations.
  let conversations: ConversationRow[] = [];
  if (contactId) {
    const { data, error } = await admin
      .from("conversations")
      .select("id, status, channel, last_inbound_at, last_message_at, is_group, created_at")
      .eq("organization_id", organizationId)
      .eq("contact_id", contactId)
      .order("last_message_at", { ascending: false, nullsFirst: false })
      .limit(500);
    if (error) {
      logger.warn("[lgpd-export-worker] conversations load failed", {
        request_id: requestId,
        error: error.message,
      });
    } else if (data) {
      conversations = data.map((c) => ({
        id: c.id,
        status: c.status,
        channel: c.channel,
        last_inbound_at: c.last_inbound_at,
        last_message_at: c.last_message_at,
        is_group: Boolean(c.is_group),
        created_at: c.created_at,
      }));
    }
  }

  // Messages — count total + sample recent.
  let messages_count_total = 0;
  let messages_recent: MessageRow[] = [];
  if (contactId) {
    const { count, error: countErr } = await admin
      .from("messages")
      .select("id", { count: "exact", head: true })
      .eq("organization_id", organizationId)
      .eq("contact_id", contactId);
    if (countErr) {
      logger.warn("[lgpd-export-worker] messages count failed", {
        request_id: requestId,
        error: countErr.message,
      });
    } else {
      messages_count_total = count ?? 0;
    }

    const { data, error } = await admin
      .from("messages")
      .select(
        "id, conversation_id, direction, type, status, body, media_url, sent_at, created_at",
      )
      .eq("organization_id", organizationId)
      .eq("contact_id", contactId)
      .order("created_at", { ascending: false })
      .limit(RECENT_MESSAGES_LIMIT);
    if (error) {
      logger.warn("[lgpd-export-worker] messages recent load failed", {
        request_id: requestId,
        error: error.message,
      });
    } else if (data) {
      messages_recent = data.map((m) => ({
        id: m.id,
        conversation_id: m.conversation_id,
        direction: m.direction,
        type: m.type,
        status: m.status,
        body: m.body,
        has_media: Boolean(m.media_url),
        sent_at: m.sent_at,
        created_at: m.created_at,
      }));
    }
  }

  // Leads (direct contact_id FK on crm_leads).
  let leads: LeadRow[] = [];
  if (contactId) {
    const { data, error } = await admin
      .from("crm_leads")
      .select(
        "id, pipeline_id, stage_id, title, status, value_cents, currency, created_at",
      )
      .eq("organization_id", organizationId)
      .eq("contact_id", contactId)
      .order("created_at", { ascending: false })
      .limit(200);
    if (error) {
      logger.warn("[lgpd-export-worker] leads load failed", {
        request_id: requestId,
        error: error.message,
      });
    } else if (data) {
      leads = data;
    }
  }

  // Orders (contact_id when available, otherwise external_customer_id).
  let orders: OrderRow[] = [];
  {
    let q = admin
      .from("orders")
      .select(
        "id, external_id, external_provider, status, total_cents, currency, ordered_at, contact_id, customer_external_id",
      )
      .eq("organization_id", organizationId)
      .order("ordered_at", { ascending: false, nullsFirst: false })
      .limit(500);
    if (contactId) {
      q = q.eq("contact_id", contactId);
    } else if (externalCustomerId) {
      q = q.eq("customer_external_id", externalCustomerId);
    }
    const { data, error } = await q;
    if (error) {
      logger.warn("[lgpd-export-worker] orders load failed", {
        request_id: requestId,
        error: error.message,
      });
    } else if (data) {
      orders = data.map((o) => ({
        id: o.id,
        external_id: o.external_id,
        external_provider: o.external_provider,
        status: o.status,
        total_cents: o.total_cents,
        currency: o.currency,
        ordered_at: o.ordered_at,
      }));
    }
  }

  // Activities — direct contact_id on crm_lead_activities.
  let activities: ActivityRow[] = [];
  if (contactId) {
    const { data, error } = await admin
      .from("crm_lead_activities")
      .select("id, lead_id, type, source_module, performed_at")
      .eq("organization_id", organizationId)
      .eq("contact_id", contactId)
      .order("performed_at", { ascending: false })
      .limit(500);
    if (error) {
      logger.warn("[lgpd-export-worker] activities load failed", {
        request_id: requestId,
        error: error.message,
      });
    } else if (data) {
      activities = data;
    }
  }

  // Agenda — contact_id direto em calendar_appointments.
  //
  // ⚠️ ESTA METADE FALTAVA, e a outra tinha gate. A migration 0184 declarou esta
  // tabela dado pessoal e ligou o trigger de REDAÇÃO; esta branch escreveu
  // `tests/invariants/agenda-lgpd-alcanca.test.ts` com quatro casos para provar
  // a redação — e ninguém acrescentou a agenda ao EXPORT. O titular exercia o
  // Art. 18 II e recebia um relatório que não mencionava nenhuma consulta que
  // ele marcou. Neste repo, redigir e exportar sempre andaram juntos.
  let appointments: AppointmentRow[] = [];
  if (contactId) {
    const { data, error } = await admin
      .from("calendar_appointments")
      .select(
        "id, title, description, notes, location_details, cancellation_reason, starts_at, ends_at, time_zone, status",
      )
      .eq("organization_id", organizationId)
      .eq("contact_id", contactId)
      .order("starts_at", { ascending: false })
      .limit(500);
    if (error) {
      logger.warn("[lgpd-export-worker] appointments load failed", {
        request_id: requestId,
        error: error.message,
      });
    } else if (data) {
      appointments = data;
    }
  }

  // Tarefas — contact_id direto em crm_tasks (migration 0210).
  //
  // O texto que a equipe escreveu sobre o titular ("ligar para Fulano confirmar
  // o orçamento") é dado dele. Se a anonimização o apaga — e ela apaga —, o
  // pedido de acesso tem de entregá-lo.
  let tasks: TaskRow[] = [];
  if (contactId) {
    const { data, error } = await admin
      .from("crm_tasks")
      .select("id, title, description, due_date, status, priority")
      .eq("organization_id", organizationId)
      .eq("contact_id", contactId)
      .order("due_date", { ascending: false })
      .limit(500);
    if (error) {
      logger.warn("[lgpd-export-worker] tasks load failed", {
        request_id: requestId,
        error: error.message,
      });
    } else if (data) {
      tasks = data;
    }
  }

  // Captação por webhook — a MESMA classe do bloco acima, achada pelo gate.
  let webhook_captures: CaptureRow[] = [];
  if (contactId) {
    const { data, error } = await admin
      .from("webhook_lead_captures")
      .select(
        "id, source_name, outcome, captured_name, captured_phone, captured_email, fields, utm, remote_ip, user_agent, received_at",
      )
      .eq("organization_id", organizationId)
      .eq("contact_id", contactId)
      .order("received_at", { ascending: false })
      .limit(500);
    if (error) {
      logger.warn("[lgpd-export-worker] webhook captures load failed", {
        request_id: requestId,
        error: error.message,
      });
    } else if (data) {
      webhook_captures = data;
    }
  }

  // Audit log extract (best-effort: rows where metadata.contact_id matches).
  let audit_log_extract: AuditRow[] = [];
  if (contactId) {
    const { data, error } = await admin
      .from("api_audit_log")
      .select("id, action, resource_type, resource_id, created_at, metadata")
      .eq("organization_id", organizationId)
      .or(`resource_id.eq.${contactId},metadata->>contact_id.eq.${contactId}`)
      .order("created_at", { ascending: false })
      .limit(AUDIT_LIMIT);
    if (error) {
      logger.warn("[lgpd-export-worker] audit load failed", {
        request_id: requestId,
        error: error.message,
      });
    } else if (data) {
      audit_log_extract = data.map((a) => ({
        id: a.id,
        action: a.action,
        resource_type: a.resource_type,
        resource_id: a.resource_id,
        created_at: a.created_at,
      }));
    }
  }

  return {
    request_id: requestId,
    organization_id: organizationId,
    organization_legal_name: controlador.legal_name,
    organization_display_name: controlador.display_name,
    dpo_email: controlador.dpo_email,
    generated_at: new Date().toISOString(),
    no_local_footprint: !contact && conversations.length === 0 && orders.length === 0,
    contact,
    consents,
    conversations,
    messages_count_total,
    messages_recent,
    leads,
    orders,
    activities,
    appointments,
    tasks,
    webhook_captures,
    audit_log_extract,
  };
}

function emptyPayload(
  requestId: string,
  organizationId: string,
  controlador: Controlador,
): ExportPayload {
  return {
    request_id: requestId,
    organization_id: organizationId,
    organization_legal_name: controlador.legal_name,
    organization_display_name: controlador.display_name,
    dpo_email: controlador.dpo_email,
    generated_at: new Date().toISOString(),
    no_local_footprint: true,
    contact: null,
    consents: [],
    conversations: [],
    messages_count_total: 0,
    messages_recent: [],
    leads: [],
    orders: [],
    activities: [],
    appointments: [],
    tasks: [],
    webhook_captures: [],
    audit_log_extract: [],
  };
}
