/**
 * LGPD export collector — aggregates all personal data the CRM holds about
 * one contact (Art. 18 II — direito de acesso).
 *
 * CLAUDE.md §LGPD: every query filters `organization_id` programmatically
 * (admin client bypasses RLS). PII is NEVER logged — only ids and counts.
 */

import { createAdminClient } from "@/lib/supabase/admin";
import { citacaoDaLei, perfilDoPais } from "@/lib/legal/perfil-do-pais";
import { logger } from "@/lib/logger";
import { maskPhone } from "@/lib/lgpd/mask";
import type { Json } from "@/lib/database.types";

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
  /** Primeiro atendimento marcado. Sobrevive à anonimização: é registro de operação. */
  first_service_at: string | null;
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
 * O resumo que o agente guarda sobre o titular (`lead_checkpoints`).
 *
 * Entra porque a anonimização o REDIGE (migration 0391): o resumo corrido, os
 * compromissos e a próxima ação são texto que o modelo escreveu SOBRE a pessoa,
 * e o que se apaga a pedido do titular é o que se entrega a pedido dele.
 */
export interface CheckpointRow {
  id: string;
  rolling_summary: string;
  commitments: unknown;
  objections: unknown;
  next_action: string | null;
  created_at: string;
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
  google_base_projection?: Json | null;
  google_conflict?: Json | null;
  google_pending_write?: Json | null;
  meeting_url?: string | null;
  meeting_state?: string;
}

/**
 * A comanda do titular (migrations 0350-0359).
 *
 * Entra porque a anonimização APAGA: a 0359 pôs `sales` na cascata de redação
 * (`notes`, `cancel_reason`, `reverse_reason`), e neste repo redigir e exportar
 * andam juntos. Valor, forma de pagamento e datas a cascata PRESERVA — é
 * registro financeiro da organização —, e ainda assim entram aqui pela mesma
 * razão que `starts_at` da agenda entra: "gastei tanto, em tal dia, pago
 * assim" é informação a respeito dele, e é a mais legível deste bloco.
 *
 * Os ITENS não entram: `sale_items.description` é o nome do serviço, não dado
 * de pessoa, e a cascata não o toca — as duas pontas continuam espelhadas.
 */
export interface SaleRow {
  id: string;
  number: number;
  status: string;
  total_cents: number;
  currency: string;
  notes: string | null;
  cancel_reason: string | null;
  reverse_reason: string | null;
  finalized_at: string | null;
  created_at: string;
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

/** Entrega do link: estado e referência ao compromisso, sem autorização/claim. */
export interface MeetingDeliveryRow {
  id: string;
  status: string;
  created_at: string;
  run_after: string;
  appointment_id: string | null;
}

/** Aviso sobre um compromisso comprovadamente ligado ao titular. */
export interface AppointmentNoticeRow {
  id: string;
  ref_id: string | null;
  title: string;
  body: string | null;
  status: string;
  created_at: string;
  resolved_at: string | null;
}

/**
 * Um caso aberto pela IA sobre o titular — o que ela entendeu quando travou.
 *
 * O vínculo é pela CONVERSA: `agent_cases` não tem FK para `contacts`. `kind`
 * (migration 0248) fica fora da projeção porque `lib/database.types.ts` ainda
 * não o conhece, e selecionar coluna que o tipo não tem é erro de compilação.
 */
export interface CaseRow {
  id: string;
  conversation_id: string;
  status: string;
  title: string;
  summary: string;
  blocker: string;
  source: string;
  opened_at: string;
  closed_at: string | null;
  created_at: string;
}

/** Uma linha do tempo do caso: quem tocou, quando, e o que escreveu. */
export interface CaseEventRow {
  id: string;
  case_id: string;
  kind: string;
  actor_kind: string;
  human_action: string | null;
  body: string | null;
  metadata: unknown;
  created_at: string;
}

/**
 * Uma mensagem da conversa INTERNA da equipe com a IA sobre um caso do titular
 * (migration 0281). O que se apaga a pedido dele é o que se entrega a pedido
 * dele: `body` está na cascata de redação, logo a tabela tem de ser visitada
 * aqui — é o que `tests/unit/lgpd-exporta-o-que-redige.test.ts` cobra.
 *
 * O vínculo é a FK DIRETA `contact_id`, e não a conversa: ela existe nesta
 * tabela exatamente para isso.
 */
export interface CaseChatMessageRow {
  id: string;
  case_id: string;
  turn_id: string;
  author_kind: string;
  body: string | null;
  error_code: string | null;
  created_at: string;
}

/**
 * Uma passagem do atendimento automático para uma pessoa (migration 0291).
 *
 * O que se apaga a pedido do titular é o que se entrega a pedido dele: as quatro
 * colunas de texto estão na cascata de redação, logo a tabela tem de ser
 * visitada aqui — é o que `tests/unit/lgpd-exporta-o-que-redige.test.ts` cobra,
 * derivando as duas pontas da fonte.
 *
 * O vínculo é a FK DIRETA `contact_id`. As colunas de OPERAÇÃO entram junto
 * (`motor`, `origem`, `motivo_codigo`, o par do aviso e o do reconhecimento):
 * o titular tem direito de saber não só o que escreveram sobre ele, mas que a
 * conversa dele foi passada a uma pessoa, por quê, e quando alguém assumiu.
 */
export interface PassagemDeAtendimentoRow {
  id: string;
  conversation_id: string;
  caso_id: string | null;
  motor: string;
  origem: string;
  motivo_codigo: string;
  title: string | null;
  body: string;
  notes: string | null;
  content: string | null;
  tentativas: unknown;
  cliente_avisado: boolean | null;
  aviso_motivo_codigo: string | null;
  criado_em: string;
  reconhecido_em: string | null;
}

/**
 * O registro de que a equipe foi (ou não foi) avisada no WhatsApp sobre um caso
 * do titular — migration 0292.
 *
 * ⚠️ `destino` entra MASCARADO. Ele é o telefone de um FUNCIONÁRIO, não do
 * titular: entregá-lo inteiro num relatório do Art. 18 II trocaria o dado
 * pessoal de uma pessoa pelo de outra. O que o titular tem direito de saber é
 * QUE houve um aviso sobre o atendimento dele, quando, e se chegou.
 *
 * O corpo do aviso não aparece porque ele NÃO É GUARDADO — a tabela tem só o
 * resumo criptográfico, e um hash não reidentifica ninguém.
 */
export interface AvisoDeCasoEntregaRow {
  id: string;
  case_id: string;
  destino_mascarado: string | null;
  status: string;
  erro_codigo: string | null;
  tentativas: number;
  enviado_em: string | null;
  created_at: string;
}

/** Uma demanda do titular — o pedido, seu dono e seu desfecho. */
export interface DemandaRow {
  id: string;
  agent_case_id: string | null;
  origem: string;
  assunto: string | null;
  estado: string;
  dono_kind: string;
  proximo_passo: string | null;
  desfecho: string | null;
  aberta_em: string;
  fechada_em: string | null;
}

/** Uma chamada de voz do titular — o registro, não a gravação (não gravamos). */
export interface VoiceCallRow {
  id: string;
  direction: string;
  peer_phone: string;
  status: string;
  end_reason: string | null;
  started_at: string;
  answered_at: string | null;
  ended_at: string | null;
  duration_ms: number | null;
}

/** Pesquisa e resultado da abordagem ligados ao titular (redação: migration 0370). */
export interface ProspectingCandidateRow {
  id: string;
  campaign_id: string;
  place_id: string;
  phone: string | null;
  data: Json;
  status: string;
  lead_id: string | null;
  conversation_id: string | null;
  attempted_at: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * Uma campanha que falou com este titular (migration 0374).
 *
 * O texto vai junto porque é o que foi DITO a ele; o telefone não, porque ele já
 * está no bloco do contato e repeti-lo só multiplica PII no arquivo entregue.
 */
export interface CampaignRecipientRow {
  id: string;
  campaign_id: string;
  status: string;
  eligibility_status: string;
  exclusion_reason: string | null;
  rendered_body: string | null;
  sent_at: string | null;
  delivered_at: string | null;
  read_at: string | null;
  replied_at: string | null;
  opted_out_at: string | null;
}

/**
 * Uma linha da lista de exclusão de campanhas que aponta para este titular
 * (migration 0375).
 *
 * O hash do telefone NÃO entra: ele não diz nada a quem lê e não é dado que o
 * titular reconheça. O que entra é o fato — "este número está fora das
 * campanhas desde tal dia, por tal motivo" —, que é exatamente a informação
 * dele que a organização guarda.
 */
export interface CampaignSuppressionRow {
  id: string;
  address_tail: string | null;
  reason: string | null;
  source: string;
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
  /** Encarregado da organização; `null` cai no encarregado da INSTALAÇÃO (0341). */
  dpo_email: string | null;
  /**
   * A lei que o documento de acesso cita, pronta (`LGPD Art. 18, II (Lei nº
   * 13.709/2018)`), ou `null` quando o país da organização ainda não tem
   * citação revisada (issue #1033). `null` NÃO cai para a lei brasileira: o
   * documento responde a um direito legal do titular, e afirmar a lei de outro
   * país é pior do que não citar artigo nenhum — o rodapé diz que não há
   * citação revisada em vez de inventar uma.
   */
  lei_citada: string | null;
  /** O rótulo do documento do titular no país ("CPF", "Documento"). */
  documento_rotulo: string;
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
  checkpoints: CheckpointRow[];
  appointments: AppointmentRow[];
  sales: SaleRow[];
  tasks: TaskRow[];
  webhook_captures: CaptureRow[];
  audit_log_extract: AuditRow[];
  meeting_deliveries: MeetingDeliveryRow[];
  appointment_notices: AppointmentNoticeRow[];
  /**
   * Chamadas de voz (migration 0232).
   *
   * Entra porque a anonimização APAGA: a 0235 pôs `voice_calls` na cascata de
   * redação, e o que se apaga a pedido do titular é o que se entrega a pedido
   * dele. Sem este bloco o relatório dizia "houve uma atividade de chamada" na
   * linha do tempo e não mostrava chamada nenhuma — export incoerente com o
   * próprio cascade.
   */
  voice_calls: VoiceCallRow[];
  prospecting_candidates: ProspectingCandidateRow[];
  /**
   * Casos, linha do tempo do caso e demandas (migration 0280).
   *
   * Entram pelo mesmo motivo de `voice_calls`: a 0280 pôs as três na cascata de
   * redação, e o que se apaga a pedido do titular é o que se entrega a pedido
   * dele. Sem os três blocos, o relatório mostrava a conversa e as mensagens e
   * não mencionava que o atendimento tinha parado, o que a IA entendeu do
   * problema dele, nem quem da equipe respondeu — que é a parte em que uma
   * pessoa identificável é DESCRITA por máquina.
   */
  cases: CaseRow[];
  case_events: CaseEventRow[];
  demandas: DemandaRow[];
  /**
   * O que a equipe PERGUNTOU à IA sobre os casos do titular, e o que ela
   * respondeu. Obrigatório, não opcional: campo obrigatório faz um caminho de
   * export novo NÃO COMPILAR se esquecer, que é a única sincronia que não
   * depende de memória humana.
   */
  case_chat_messages: CaseChatMessageRow[];
  /**
   * As passagens do atendimento dele para uma pessoa. Obrigatório, não
   * opcional, pela mesma razão do campo acima: campo obrigatório faz um caminho
   * de export novo NÃO COMPILAR se esquecer, que é a única sincronia que não
   * depende de memória humana.
   */
  passagens: PassagemDeAtendimentoRow[];
  avisos_de_caso: AvisoDeCasoEntregaRow[];
  /**
   * Campanhas que falaram com o titular (migration 0375).
   *
   * Entra pelo mesmo motivo de `voice_calls`: o trigger
   * `trg_redigir_campanhas_anonimizado` APAGA o texto e o telefone destas linhas
   * quando ele pede anonimização, e o que se apaga a pedido dele é o que se
   * entrega a pedido dele (Art. 18 II). Sem este bloco, alguém que recebeu uma
   * prospecção pediria acesso e não veria a mensagem que recebeu.
   */
  campaign_recipients: CampaignRecipientRow[];
  /**
   * Lista de exclusão de campanhas (migration 0375).
   *
   * Entra pelo mesmo motivo das demais: o trigger
   * `trg_redigir_exclusoes_anonimizado` APAGA o vínculo e os últimos dígitos
   * quando o titular pede anonimização, e o que se apaga a pedido dele é o que
   * se entrega a pedido dele (Art. 18 II).
   */
  campaign_suppressions: CampaignSuppressionRow[];
  reply_drafts?: Array<{
    id: string;
    status: string;
    original_body: string | null;
    edited_body: string | null;
    approved_body: string | null;
    proposals: unknown;
    feedback: unknown;
    created_at: string;
  }>;
}

// ---------------------------------------------------------------------------
// collectExportData
// ---------------------------------------------------------------------------

interface CollectArgs {
  organizationId: string;
  requestId: string;
  contactId: string | null;
  externalCustomerId: string | null;
  /**
   * O encarregado de dados da INSTALAÇÃO — o piso do da organização, já
   * RESOLVIDO por quem chama.
   *
   * Injetado, e não lido aqui, porque o coletor de LGPD tem de tocar o mínimo:
   * `tests/invariants/agenda-meet-export.test.ts` exige que a coleta sem
   * identificador visite APENAS `organizations`, e consultar a configuração da
   * instalação acrescentaria uma tabela a toda coleta — inclusive à que não vai
   * usar o valor. Quem chama já é assíncrono e já resolve outras coisas da
   * instalação; resolver mais esta ali não custa visita nenhuma aqui.
   */
  dpoDaInstalacao?: string | null;
}

const RECENT_MESSAGES_LIMIT = 100;
const AUDIT_LIMIT = 200;

/** A identidade JURÍDICA da organização — quem responde pelos dados. */
interface Controlador {
  legal_name: string;
  display_name: string;
  dpo_email: string | null;
  /**
   * O país da organização (issue #1033). Lido JUNTO do controlador, na mesma
   * consulta, porque é dele que saem a lei citada e o rótulo do documento: dois
   * `select` na mesma linha divergem no dia em que um ganhar fallback e o outro
   * não — e aqui a divergência sairia impressa num documento entregue a um
   * titular, afirmando a lei de um país com o rótulo de outro.
   */
  country: string | null;
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
  dpoDaInstalacao: string | null,
): Promise<Controlador> {
  const vazio: Controlador = {
    legal_name: "",
    display_name: "",
    dpo_email: dpoDaInstalacao,
    country: null,
  };
  const { data, error } = await admin
    .from("organizations")
    .select("legal_name, display_name, dpo_email, country")
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
    dpo_email: data.dpo_email?.trim() || dpoDaInstalacao,
    country: (data as { country?: string | null }).country ?? null,
  };
}

export async function collectExportData(args: CollectArgs): Promise<ExportPayload> {
  const admin = createAdminClient();
  const { organizationId, requestId, externalCustomerId } = args;
  // ANTES do primeiro `return`: o caminho "nenhum dado localizado" também gera
  // um relatório entregue ao titular, e ele precisa nomear o controlador igual.
  const controlador = await lerControlador(admin, organizationId, requestId, args.dpoDaInstalacao ?? null);
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
        "id, name, display_name, email, phone_number, cpf_encrypted, birthdate, is_blocked, is_anonymized, consent, tags, source, source_metadata, custom_fields, created_at, last_activity_at, first_service_at",
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
        first_service_at: data.first_service_at ?? null,
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
      .select("id, conversation_id, direction, type, status, body, media_url, sent_at, created_at")
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
      .select("id, pipeline_id, stage_id, title, status, value_cents, currency, created_at")
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

  // Resumos do agente — contact_id direto em lead_checkpoints.
  let checkpoints: CheckpointRow[] = [];
  if (contactId) {
    const { data, error } = await admin
      .from("lead_checkpoints")
      .select("id, rolling_summary, commitments, objections, next_action, created_at")
      .eq("organization_id", organizationId)
      .eq("contact_id", contactId)
      .order("created_at", { ascending: false })
      .limit(500);
    if (error) {
      logger.warn("[lgpd-export-worker] checkpoints load failed", {
        request_id: requestId,
        error: error.message,
      });
    } else if (data) {
      checkpoints = data;
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
        "id, title, description, notes, location_details, cancellation_reason, starts_at, ends_at, time_zone, status, google_base_projection, google_conflict, google_pending_write, meeting_url, meeting_state",
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

  // Comandas — contact_id direto em sales (migrations 0350-0359).
  //
  // A 0359 acrescentou esta tabela à cascata de redação; este bloco é a outra
  // metade, escrita no mesmo PR. Sem ele, o titular pediria acesso e receberia
  // um relatório que não menciona nenhuma compra que ele fez — o defeito que
  // `tests/unit/lgpd-exporta-o-que-redige.test.ts` existe para pegar, e que
  // pegou este bloco antes de ele ser escrito.
  let sales: SaleRow[] = [];
  if (contactId) {
    const { data, error } = await admin
      .from("sales")
      .select(
        "id, number, status, total_cents, currency, notes, cancel_reason, reverse_reason, finalized_at, created_at",
      )
      .eq("organization_id", organizationId)
      .eq("contact_id", contactId)
      .order("created_at", { ascending: false })
      .limit(500);
    if (error) {
      logger.warn("[lgpd-export-worker] sales load failed", {
        request_id: requestId,
        error: error.message,
      });
    } else if (data) {
      sales = data;
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

  // Chamadas de voz — `contact_id` direto em `voice_calls` (migration 0232).
  //
  // O que existe aqui é o REGISTRO da ligação, nunca o áudio: gravação está
  // deliberadamente fora do produto (spec 18 §1.2), então não há mídia a
  // enfileirar como acontece com foto e anexo.
  let voice_calls: VoiceCallRow[] = [];
  if (contactId) {
    const { data, error } = await admin
      .from("voice_calls")
      .select(
        "id, direction, peer_phone, status, end_reason, started_at, answered_at, ended_at, duration_ms",
      )
      .eq("organization_id", organizationId)
      .eq("contact_id", contactId)
      .order("started_at", { ascending: false })
      .limit(500);
    if (error) {
      logger.warn("[lgpd-export-worker] voice calls load failed", {
        request_id: requestId,
        error: error.message,
      });
    } else if (data) {
      voice_calls = data as VoiceCallRow[];
    }
  }

  // Campanhas — `contact_id` direto em `campaign_recipients` (migration 0375).
  let campaign_recipients: CampaignRecipientRow[] = [];
  if (contactId) {
    const { data, error } = await admin
      .from("campaign_recipients")
      .select(
        "id, campaign_id, status, eligibility_status, exclusion_reason, rendered_body, sent_at, delivered_at, read_at, replied_at, opted_out_at",
      )
      .eq("organization_id", organizationId)
      .eq("contact_id", contactId)
      .order("created_at", { ascending: false })
      .limit(500);
    if (error) {
      logger.warn("[lgpd-export-worker] campaign recipients load failed", {
        request_id: requestId,
        error: error.message,
      });
    } else if (data) {
      campaign_recipients = data as unknown as CampaignRecipientRow[];
    }
  }

  // Lista de exclusão de campanhas — `contact_id` direto (migration 0375).
  let campaign_suppressions: CampaignSuppressionRow[] = [];
  if (contactId) {
    const { data, error } = await admin
      .from("campaign_suppressions")
      .select("id, address_tail, reason, source, created_at")
      .eq("organization_id", organizationId)
      .eq("contact_id", contactId)
      .order("created_at", { ascending: false })
      .limit(100);
    if (error) {
      logger.warn("[lgpd-export-worker] campaign suppressions load failed", {
        request_id: requestId,
        error: error.message,
      });
    } else if (data) {
      campaign_suppressions = data as unknown as CampaignSuppressionRow[];
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

  // A 0226/0229 redige estes registros. Só o FK de contato e os compromissos
  // comprovados abaixo dão escopo: nunca o conteúdo livre de um aviso ou a
  // autorização privada do job. Paginar os IDs evita perder avisos de consultas
  // antigas além do recorte de appointments mostrado no relatório.
  const reply_drafts: NonNullable<ExportPayload["reply_drafts"]> = [];
  if (contactId) {
    for (let offset = 0; ; offset += 500) {
      const { data, error } = await admin
        .from("ai_reply_drafts")
        .select("id,status,original_body,edited_body,approved_body,proposals,feedback,created_at")
        .eq("organization_id", organizationId)
        .eq("contact_id", contactId)
        .order("id")
        .range(offset, offset + 499);
      if (error) throw error;
      reply_drafts.push(...(data ?? []));
      if (!data || data.length < 500) break;
    }
  }
  // Espelha exatamente o escopo da redação 0361: contato + organização.
  // Telefone coincidente sem vínculo não comprova identidade. Tokens de
  // supressão e a autorização de envio permanecem internos, fora da projeção.
  const prospecting_candidates: ProspectingCandidateRow[] = [];
  if (contactId) {
    for (let offset = 0; ; offset += 500) {
      const { data, error } = await admin
        .from("prospecting_candidates")
        .select(
          "id,campaign_id,place_id,phone,data,status,lead_id,conversation_id,attempted_at,error,created_at,updated_at",
        )
        .eq("organization_id", organizationId)
        .eq("contact_id", contactId)
        .order("id")
        .range(offset, offset + 499);
      // Uma falha não pode virar um relatório que diz que não guardamos dados.
      if (error) throw error;
      prospecting_candidates.push(...(data ?? []));
      if (!data || data.length < 500) break;
    }
  }
  // Casos, linha do tempo do caso e demandas — o que a 0280 pôs na cascata.
  //
  // O escopo do CASO é a CONVERSA do titular: `agent_cases` não tem FK para
  // `contacts`. Os ids das conversas são paginados por conta própria em vez de
  // reaproveitar a projeção `conversations` acima — ela tem teto de 500 e existe
  // para o relatório. Usá-la como filtro faria o titular com mais de 500
  // conversas receber um export sem os casos das excedentes, em silêncio.
  const cases: CaseRow[] = [];
  const case_events: CaseEventRow[] = [];
  let demandas: DemandaRow[] = [];
  const case_chat_messages: CaseChatMessageRow[] = [];
  const passagens: PassagemDeAtendimentoRow[] = [];
  const avisos_de_caso: AvisoDeCasoEntregaRow[] = [];
  if (contactId) {
    const pageSize = 500;
    const refBatchSize = 100; // Mantém o filtro IN abaixo dos limites de URL dos proxies.
    const conversationIds: string[] = [];
    for (let offset = 0; ; offset += pageSize) {
      const { data, error } = await admin
        .from("conversations")
        .select("id")
        .eq("organization_id", organizationId)
        .eq("contact_id", contactId)
        .order("id")
        .range(offset, offset + pageSize - 1);
      if (error) {
        logger.warn("[lgpd-export-worker] case conversation refs load failed", {
          request_id: requestId,
          error: error.message,
        });
        break;
      }
      for (const conversa of data ?? []) conversationIds.push(conversa.id);
      if (!data || data.length < pageSize) break;
    }
    for (let batch = 0; batch < conversationIds.length; batch += refBatchSize) {
      for (let offset = 0; ; offset += pageSize) {
        const { data, error } = await admin
          .from("agent_cases")
          .select(
            "id, conversation_id, status, title, summary, blocker, source, opened_at, closed_at, created_at",
          )
          .eq("organization_id", organizationId)
          .in("conversation_id", conversationIds.slice(batch, batch + refBatchSize))
          .order("id")
          .range(offset, offset + pageSize - 1);
        if (error) {
          logger.warn("[lgpd-export-worker] cases load failed", {
            request_id: requestId,
            error: error.message,
          });
          break;
        }
        cases.push(...(data ?? []));
        if (!data || data.length < pageSize) break;
      }
    }
    // A linha do tempo pende do caso já coletado: um `case_id` que não esteja em
    // `cases` seria de outro titular, e é por isso que o escopo sai daqui e não
    // de uma segunda derivação pela conversa.
    const caseIds = cases.map((caso) => caso.id);
    for (let batch = 0; batch < caseIds.length; batch += refBatchSize) {
      for (let offset = 0; ; offset += pageSize) {
        const { data, error } = await admin
          .from("agent_case_events")
          .select("id, case_id, kind, actor_kind, human_action, body, metadata, created_at")
          .eq("organization_id", organizationId)
          .in("case_id", caseIds.slice(batch, batch + refBatchSize))
          .order("id")
          .range(offset, offset + pageSize - 1);
        if (error) {
          logger.warn("[lgpd-export-worker] case events load failed", {
            request_id: requestId,
            error: error.message,
          });
          break;
        }
        case_events.push(...(data ?? []));
        if (!data || data.length < pageSize) break;
      }
    }
    // Demanda tem FK direta para o contato (`contact_id` é `not null`).
    const { data, error } = await admin
      .from("demandas")
      .select(
        "id, agent_case_id, origem, assunto, estado, dono_kind, proximo_passo, desfecho, aberta_em, fechada_em",
      )
      .eq("organization_id", organizationId)
      .eq("contact_id", contactId)
      .order("aberta_em", { ascending: false })
      .limit(500);
    if (error) {
      logger.warn("[lgpd-export-worker] demandas load failed", {
        request_id: requestId,
        error: error.message,
      });
    } else if (data) {
      demandas = data;
    }
    // A conversa interna sobre o caso (migration 0281). FK direta para o
    // contato, então não passa pelos ids de conversa acima — e paginada, e não
    // com `limit`, porque uma deliberação longa num titular antigo não pode
    // sumir do relatório em silêncio.
    for (let offset = 0; ; offset += pageSize) {
      const { data: pagina, error: erro } = await admin
        .from("agent_case_chat_messages")
        .select("id, case_id, turn_id, author_kind, body, error_code, created_at")
        .eq("organization_id", organizationId)
        .eq("contact_id", contactId)
        .order("id")
        .range(offset, offset + pageSize - 1);
      if (erro) {
        logger.warn("[lgpd-export-worker] case chat messages load failed", {
          request_id: requestId,
          error: erro.message,
        });
        break;
      }
      case_chat_messages.push(...(pagina ?? []));
      if (!pagina || pagina.length < pageSize) break;
    }
    // As passagens para uma pessoa (migration 0291). FK direta para o contato,
    // como a de cima, e paginada pela mesma razão: um titular de dois anos pode
    // ter dezenas, e um `limit` faria as mais antigas sumirem do relatório sem
    // ninguém saber que sumiram.
    for (let offset = 0; ; offset += pageSize) {
      const { data: pagina, error: erro } = await admin
        .from("passagens_de_atendimento")
        // UM literal, sem concatenação: o supabase-js lê a lista de colunas do
        // TIPO da string para inferir a linha, e `"a" + "b"` vira `string` —
        // a linha volta como `GenericStringError` e o `push` não compila.
        .select("id, conversation_id, caso_id, motor, origem, motivo_codigo, title, body, notes, content, tentativas, cliente_avisado, aviso_motivo_codigo, criado_em, reconhecido_em")
        .eq("organization_id", organizationId)
        .eq("contact_id", contactId)
        .order("id")
        .range(offset, offset + pageSize - 1);
      if (erro) {
        logger.warn("[lgpd-export-worker] passagens load failed", {
          request_id: requestId,
          error: erro.message,
        });
        break;
      }
      passagens.push(...(pagina ?? []));
      if (!pagina || pagina.length < pageSize) break;
    }
    // O registro de entrega do aviso ao suporte (migration 0292). O escopo sai
    // dos CASOS já coletados, e não de uma segunda derivação pela conversa: um
    // `case_id` que não esteja em `cases` seria de outro titular.
    //
    // A cascata de LGPD zera `erro_detalhe` desta tabela, e é por isso que ela
    // entra aqui: `tests/unit/lgpd-exporta-o-que-redige.test.ts` deriva as duas
    // pontas da fonte e reprova quem redige e não exporta — o que se apaga a
    // pedido do titular é o que se entrega a pedido dele.
    for (let batch = 0; batch < caseIds.length; batch += refBatchSize) {
      for (let offset = 0; ; offset += pageSize) {
        const { data: pagina, error: erro } = await admin
          .from("entregas_de_aviso_de_caso")
          .select("id, case_id, destino, status, erro_codigo, tentativas, enviado_em, created_at")
          .eq("organization_id", organizationId)
          .in("case_id", caseIds.slice(batch, batch + refBatchSize))
          .order("id")
          .range(offset, offset + pageSize - 1);
        if (erro) {
          logger.warn("[lgpd-export-worker] avisos de caso load failed", {
            request_id: requestId,
            error: erro.message,
          });
          break;
        }
        for (const linha of pagina ?? []) {
          const { destino, ...resto } = linha;
          avisos_de_caso.push({ ...resto, destino_mascarado: maskPhone(destino) });
        }
        if (!pagina || pagina.length < pageSize) break;
      }
    }
  }

  const meeting_deliveries: MeetingDeliveryRow[] = [];
  const appointment_notices: AppointmentNoticeRow[] = [];
  if (contactId) {
    const appointmentIds = new Set<string>();
    const pageSize = 500;
    for (let offset = 0; ; offset += pageSize) {
      const { data, error } = await admin
        .from("calendar_appointments")
        .select("id")
        .eq("organization_id", organizationId)
        .eq("contact_id", contactId)
        .order("id")
        .range(offset, offset + pageSize - 1);
      if (error) {
        logger.warn("[lgpd-export-worker] meeting references load failed", {
          request_id: requestId,
        });
        break;
      }
      for (const appointment of data ?? []) appointmentIds.add(appointment.id);
      if (!data || data.length < pageSize) break;
    }
    for (let offset = 0; ; offset += pageSize) {
      const { data, error } = await admin
        .from("job_queue")
        .select("id,status,created_at,run_after,appointment_id:payload->>appointment_id")
        .eq("organization_id", organizationId)
        .eq("contact_id", contactId)
        .eq("kind", "transactional_delivery")
        .order("id")
        .range(offset, offset + pageSize - 1);
      if (error) {
        logger.warn("[lgpd-export-worker] meeting deliveries load failed", {
          request_id: requestId,
        });
        break;
      }
      for (const job of data ?? [])
        meeting_deliveries.push({
          id: job.id,
          status: job.status,
          created_at: job.created_at,
          run_after: job.run_after,
          appointment_id:
            typeof job.appointment_id === "string" && appointmentIds.has(job.appointment_id)
              ? job.appointment_id
              : null,
        });
      if (!data || data.length < pageSize) break;
    }
    const ids = [...appointmentIds];
    const refBatchSize = 100; // Mantém o filtro IN abaixo dos limites de URL dos proxies.
    for (let batch = 0; batch < ids.length; batch += refBatchSize) {
      for (let offset = 0; ; offset += pageSize) {
        const { data, error } = await admin
          .from("agent_inbox_items")
          .select("id,ref_id,title,body,status,created_at,resolved_at")
          .eq("organization_id", organizationId)
          .eq("ref_kind", "appointment")
          .in("kind", ["other", "appointment_outcome_required", "appointment_recovery_review"])
          .in("ref_id", ids.slice(batch, batch + refBatchSize))
          .order("id")
          .range(offset, offset + pageSize - 1);
        if (error) {
          logger.warn("[lgpd-export-worker] appointment notices load failed", {
            request_id: requestId,
          });
          break;
        }
        for (const notice of data ?? [])
          appointment_notices.push({
            id: notice.id,
            ref_id: notice.ref_id,
            title: notice.title,
            body: notice.body,
            status: notice.status,
            created_at: notice.created_at,
            resolved_at: notice.resolved_at,
          });
        if (!data || data.length < pageSize) break;
      }
    }
  }

  const perfil = perfilDoPais(controlador.country);

  return {
    request_id: requestId,
    organization_id: organizationId,
    organization_legal_name: controlador.legal_name,
    organization_display_name: controlador.display_name,
    dpo_email: controlador.dpo_email,
    lei_citada: citacaoDaLei(perfil),
    documento_rotulo: perfil.documento.rotulo,
    generated_at: new Date().toISOString(),
    no_local_footprint:
      !contact &&
      conversations.length === 0 &&
      orders.length === 0 &&
      prospecting_candidates.length === 0,
    contact,
    consents,
    conversations,
    messages_count_total,
    messages_recent,
    leads,
    orders,
    activities,
    checkpoints,
    appointments,
    sales,
    tasks,
    webhook_captures,
    audit_log_extract,
    reply_drafts,
    meeting_deliveries,
    appointment_notices,
    voice_calls,
    prospecting_candidates,
    cases,
    case_events,
    demandas,
    case_chat_messages,
    passagens,
    avisos_de_caso,
    campaign_recipients,
    campaign_suppressions,
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
    lei_citada: citacaoDaLei(perfilDoPais(controlador.country)),
    documento_rotulo: perfilDoPais(controlador.country).documento.rotulo,
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
    checkpoints: [],
    appointments: [],
    sales: [],
    tasks: [],
    webhook_captures: [],
    audit_log_extract: [],
    meeting_deliveries: [],
    appointment_notices: [],
    voice_calls: [],
    prospecting_candidates: [],
    cases: [],
    case_events: [],
    demandas: [],
    case_chat_messages: [],
    passagens: [],
    avisos_de_caso: [],
    campaign_recipients: [],
    campaign_suppressions: [],
  };
}
