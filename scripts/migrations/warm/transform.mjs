/** Conversão pura: não acessa banco, não envia mensagens e não cria usuários. */
import { createHash } from 'node:crypto';
import { buildIdentityMap, verifyReferences } from './identity-map.mjs';
import { migrationId, moneyToCents, SOURCE_WORKSPACE, TARGET_ORGANIZATION } from './core.mjs';

export const BATCH_ID = migrationId(TARGET_ORGANIZATION, 'data_import_batches', SOURCE_WORKSPACE);
const base = (table, row) => ({ id: migrationId(TARGET_ORGANIZATION, table, row.id), organization_id: TARGET_ORGANIZATION });
const dates = row => ({ created_at: row.created_at, updated_at: row.updated_at ?? row.created_at });
const sorted = rows => [...rows].sort((a, b) => String(b.updated_at ?? b.created_at).localeCompare(String(a.updated_at ?? a.created_at)) || a.id.localeCompare(b.id));
const first = (rows, key) => rows.find(row => row[key] !== null && row[key] !== undefined && row[key] !== '')?.[key] ?? null;
const latest = values => values.filter(Boolean).sort().at(-1) ?? null;
const earliest = values => values.filter(Boolean).sort()[0] ?? null;
const metadata = (table, rows) => ({ import_batch_id: BATCH_ID, warm: { source_table: table, source_ids: rows.map(row => row.id).sort() } });
const mediaType = mime => ['image', 'video', 'audio'].includes(mime?.split('/')[0]) ? mime.split('/')[0] : 'document';

export function transform(tables, mediaManifest) {
  const mapping = buildIdentityMap({ contacts: tables.contacts, conversations: tables.crm_conversations });
  const dangling = verifyReferences(tables, mapping);
  if (dangling.length) throw new Error(`Referências sem destino: ${dangling.length}`);
  const out = { contacts: [], channel_sessions: [], conversations: [], messages: [], message_attachments: [], crm_pipelines: [], crm_stages: [], crm_leads: [], conversation_notes: [], crm_tasks: [], calendar_appointments: [] };
  const sourceContacts = new Map(tables.contacts.map(row => [row.id, row]));
  const sourceConversations = new Map(tables.crm_conversations.map(row => [row.id, row]));
  const contactId = id => id ? mapping.contactMap.get(id) : null;
  const conversationId = id => id ? mapping.conversationMap.get(id) : null;
  for (const [canonical, ids] of mapping.contactGroups) {
    const rows = sorted(ids.map(id => sourceContacts.get(id)));
    const active = rows.filter(row => !row.deleted_at && !row.merged_into_id);
    const preferred = active.length ? active : rows;
    const phone = first(preferred, 'phone_e164') ?? first(preferred, 'phone');
    const validPhone = /^\+\d{8,15}$/.test(phone ?? '') ? phone : null;
    out.contacts.push({ id: contactId(canonical), organization_id: TARGET_ORGANIZATION,
      name: first(preferred, 'name'), display_name: first(preferred, 'name'), email: first(preferred, 'email'),
      phone_number: validPhone, locale: first(preferred, 'preferred_language'), force_human: true,
      is_blocked: !active.length, blocked_reason: active.length ? null : 'Cadastro excluído na origem',
      blocked_at: active.length ? null : latest(rows.map(row => row.deleted_at)),
      source: 'warm_import', source_metadata: { ...metadata('contacts', rows), identities: (tables.contact_identities ?? []).filter(row => ids.includes(row.contact_id)), original_phone_pending_review: phone && !validPhone ? phone : null },
      created_at: earliest(rows.map(row => row.created_at)), updated_at: latest(rows.map(row => row.updated_at ?? row.created_at)) });
  }
  const channelMap = new Map();
  for (const row of tables.crm_channels) {
    const target = base('channel_sessions', row); channelMap.set(row.id, target.id);
    out.channel_sessions.push({ ...target, ...dates(row), provider: 'historical', status: 'STOPPED', display_name: `${row.name} — histórico Warm`, status_reason: 'Importado para consulta; conexão e envios desativados', webhook_secret_encrypted: '\\x', metadata: metadata('crm_channels', [row]) });
  }
  for (const row of tables.crm_conversations.filter(row => !row.channel_id)) {
    const key = `unknown:${row.channel}`;
    if (!channelMap.has(key)) {
      const id = migrationId(TARGET_ORGANIZATION, 'historical_channel', row.id); channelMap.set(key, id);
      out.channel_sessions.push({ id, organization_id: TARGET_ORGANIZATION, provider: 'historical', status: 'STOPPED', display_name: `${row.channel} — canal não identificado na origem`, status_reason: 'Somente consulta', webhook_secret_encrypted: '\\x', metadata: metadata('crm_conversations', [row]), ...dates(row) });
    }
  }
  const targetChannel = row => {
    const result = channelMap.get(row.channel_id ?? `unknown:${row.channel}`);
    if (!result) throw new Error('Canal não encontrado');
    return result;
  };
  const convByTarget = new Map();
  for (const ids of mapping.conversationGroups.values()) {
    const rows = sorted(ids.map(id => sourceConversations.get(id))), row = rows[0];
    const target = { id: conversationId(row.id), organization_id: TARGET_ORGANIZATION, contact_id: contactId(row.contact_id), channel_session_id: targetChannel(row), channel: row.channel,
      status: row.status, status_changed_at: row.updated_at ?? row.created_at,
      created_at: earliest(rows.map(r => r.created_at)), updated_at: latest(rows.map(r => r.updated_at ?? r.created_at)),
      bot_silenced_until: 'infinity', usable_for_rag: false, metadata: metadata('crm_conversations', rows),
      last_inbound_at: null, last_outbound_at: null, last_message_at: null, last_message_preview: null };
    out.conversations.push(target); convByTarget.set(target.id, target);
  }
  const media = new Map((mediaManifest.references ?? []).map(row => [`${row.table}:${row.source_id}:${row.index}`, row]));
  if (mediaManifest.workspace_id !== SOURCE_WORKSPACE) throw new Error('Manifesto de mídia fora do escopo');
  for (const row of tables.crm_messages) {
    const conv = convByTarget.get(conversationId(row.conversation_id));
    if (!conv) throw new Error('Mensagem sem conversa');
    const attachments = row.attachments ?? [], primary = attachments[0];
    const target = { ...base('messages', row), ...dates(row), conversation_id: conv.id, contact_id: conv.contact_id, channel_session_id: conv.channel_session_id,
      external_id: row.external_message_id, direction: row.direction, body: row.content, type: primary ? mediaType(primary.type) : 'text',
      status: row.delivery_status ?? (row.direction === 'inbound' ? 'received' : 'unknown'), sent_via: 'external_device', sent_at: row.created_at,
      error_message: row.error_message, media_derived_text: row.transcription, metadata: { ...metadata('crm_messages', [row]), warm_delivery_status: row.delivery_status ?? null, warm_sender_id: row.sender_id ?? null } };
    for (const [position, item] of attachments.entries()) {
      const binary = media.get(`crm_messages:${row.id}:${position}`);
      if (!binary) throw new Error('Anexo não auditado');
      const available = binary.status === 'downloaded';
      const path = available ? `${TARGET_ORGANIZATION}/${conv.contact_id}/imports/${BATCH_ID}/${binary.sha256}.bin` : null;
      const attachmentId = createHash('sha256').update(`${target.id}:${position}`).digest('hex');
      out.message_attachments.push({ id: `${attachmentId.slice(0,8)}-${attachmentId.slice(8,12)}-5${attachmentId.slice(13,16)}-a${attachmentId.slice(17,20)}-${attachmentId.slice(20,32)}`, organization_id: TARGET_ORGANIZATION, message_id: target.id, position, file_name: item.filename ?? item.name ?? 'Anexo importado', mime_type: binary.mime ?? item.type ?? null, size_bytes: binary.bytes ?? item.size ?? null, storage_path: path, availability: available ? 'available' : 'unavailable', created_at: row.created_at });
      if (position === 0) { target.media_storage_path = path; target.media_mime = binary.mime ?? item.type; target.media_size_bytes = binary.bytes ?? null; }
    }
    out.messages.push(target);
    const field = row.direction === 'inbound' ? 'last_inbound_at' : 'last_outbound_at';
    if (!conv[field] || row.created_at > conv[field]) conv[field] = row.created_at;
    if (!conv.last_message_at || row.created_at > conv.last_message_at) { conv.last_message_at = row.created_at; conv.last_message_preview = row.content?.slice(0, 250) ?? null; }
  }
  for (const row of tables.pipelines) out.crm_pipelines.push({ ...base('crm_pipelines', row), ...dates(row), name: row.name, slug: `warm-${row.id.replaceAll('-', '')}`, description: row.description, is_archived: !row.is_active });
  const stages = new Map(tables.pipeline_stages.map(row => [row.id, row]));
  for (const row of tables.pipeline_stages) {
    if (row.stage_semantic_type !== 'open' || row.is_closed_stage) throw new Error('Semântica de estágio exige revisão');
    out.crm_stages.push({ ...base('crm_stages', row), ...dates(row), pipeline_id: migrationId(TARGET_ORGANIZATION, 'crm_pipelines', row.pipeline_id), name: row.name, slug: `warm-${row.id.replaceAll('-', '')}`, position: row.position, color: /^#[a-f0-9]{6}$/i.test(row.stage_color ?? '') ? row.stage_color : null });
  }
  for (const row of tables.deals) out.crm_leads.push({ ...base('crm_leads', row), ...dates(row), pipeline_id: migrationId(TARGET_ORGANIZATION, 'crm_pipelines', stages.get(row.stage_id).pipeline_id), stage_id: migrationId(TARGET_ORGANIZATION, 'crm_stages', row.stage_id), contact_id: contactId(row.contact_id), title: row.title, value_cents: moneyToCents(row.value, 'USD'), currency: 'USD', source: 'warm_import', source_metadata: metadata('deals', [row]), external_id: row.id, stage_changed_at: row.updated_at ?? row.created_at });
  const profiles = new Map((tables.profiles ?? []).map(row => [row.id, row]));
  for (const row of tables.crm_notes) out.conversation_notes.push({ ...base('conversation_notes', row), conversation_id: conversationId(row.conversation_id), body: row.content, visibility_scope: row.visibility_scope, created_by_name: profiles.get(row.author_id)?.full_name ?? null, created_at: row.created_at });
  for (const row of tables.crm_tasks) out.crm_tasks.push({ ...base('crm_tasks', row), ...dates(row), title: row.title, description: row.description, due_date: row.due_at, status: row.status === 'done' ? 'done' : 'pending', contact_id: contactId(row.contact_id), conversation_id: conversationId(row.conversation_id), lead_id: row.deal_id ? migrationId(TARGET_ORGANIZATION, 'crm_leads', row.deal_id) : null });
  for (const row of tables.appointments) {
    const cancelledAt = latest((tables.appointment_event_history ?? []).filter(event => event.appointment_id === row.id && event.event_type === 'cancelled').map(event => event.created_at));
    if (row.status === 'cancelled' && !cancelledAt) throw new Error('Cancelamento sem evidência temporal');
    out.calendar_appointments.push({ ...base('calendar_appointments', row), ...dates(row), title: row.title, description: row.description,
      contact_id: contactId(row.contact_id), conversation_id: conversationId(row.conversation_id), starts_at: row.scheduled_start, ends_at: row.scheduled_end,
      // A origem só preserva instantes com offset, sem zona IANA; UTC não presume uma zona local.
      time_zone: 'UTC', status: row.status === 'scheduled' ? 'pending' : row.status, cancelled_at: row.status === 'cancelled' ? cancelledAt : null,
      location_kind: row.location_type, location_details: row.location_data == null ? null : typeof row.location_data === 'string' ? row.location_data : JSON.stringify(row.location_data), meeting_url: row.meeting_link,
      source: 'import', created_by_kind: 'system', confirmation_next_at: 'infinity', google_local_revision: 1, google_synced_local_revision: 1,
      revision_started_at: row.created_at });
  }
  return { tables: out, mapping, batch_id: BATCH_ID };
}
