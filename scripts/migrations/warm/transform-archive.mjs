import { createHash } from 'node:crypto';
import { BATCH_ID } from './transform.mjs';
import { migrationId, TARGET_ORGANIZATION } from './core.mjs';

const destinations = { contacts: 'contacts', crm_channels: 'channel_sessions', crm_conversations: 'conversations', crm_messages: 'messages', pipelines: 'crm_pipelines', pipeline_stages: 'crm_stages', deals: 'crm_leads', crm_notes: 'conversation_notes', crm_tasks: 'crm_tasks', appointments: 'calendar_appointments' };
export function archiveRecordId(table, sourceId) {
  const hash = createHash('sha256').update(`${BATCH_ID}:${table}:${sourceId}`).digest('hex');
  return `${hash.slice(0,8)}-${hash.slice(8,12)}-5${hash.slice(13,16)}-a${hash.slice(17,20)}-${hash.slice(20,32)}`;
}

/** Mantém todo registro e deriva arestas por IDs/identidades exatos, nunca por nomes. */
export function transformArchive(tables, mapping, mediaManifest) {
  const media = new Map((mediaManifest?.references ?? []).filter(row => row.table === 'crm_files').map(row => [row.source_id, row]));
  const references = new Map();
  const add = (value, contacts) => {
    if (typeof value !== 'string' || !value || !contacts.length) return;
    if (!references.has(value)) references.set(value, new Set());
    for (const contact of contacts) references.get(value).add(contact);
  };
  const contactFor = id => mapping.contactMap.get(id);
  for (const [sourceId, targetId] of mapping.contactMap) add(sourceId, [targetId]);
  const conversationContacts = new Map(tables.crm_conversations.map(row => [row.id, contactFor(row.contact_id)]));
  for (const row of tables.crm_conversations) add(row.id, [contactFor(row.contact_id)]);
  for (const row of tables.crm_messages) {
    const contact = conversationContacts.get(row.conversation_id);
    add(row.id, [contact]); add(row.external_message_id, [contact]);
  }
  for (const row of tables.contact_identities ?? []) {
    const contact = contactFor(row.contact_id);
    if (!contact) throw new Error('Identidade sem contato');
    for (const field of ['id','external_id','value','normalized_value']) add(row[field], [contact]);
  }
  const result = [], edges = [];
  const visit = (value, found) => {
    if (typeof value === 'string') {
      for (const contact of references.get(value) ?? []) found.add(contact);
    } else if (Array.isArray(value)) {
      for (const item of value) visit(item, found);
    } else if (value && typeof value === 'object') {
      for (const item of Object.values(value)) visit(item, found);
    }
  };
  for (const [table, rows] of Object.entries(tables)) for (const row of rows) {
    const sourceId = row.id ?? row.workspace_id;
    if (!sourceId) throw new Error('Registro sem identidade de origem');
    const id = archiveRecordId(table, sourceId), found = new Set();
    visit(row, found);
    const contact = contactFor(row.contact_id) ?? conversationContacts.get(row.conversation_id) ?? (table === 'contacts' ? contactFor(row.id) : null);
    if (contact) found.add(contact);
    const destination = destinations[table] ?? null;
    const targetId = table === 'contacts' ? contactFor(row.id) : table === 'crm_conversations' ? mapping.conversationMap.get(row.id) : destination ? migrationId(TARGET_ORGANIZATION, destination, row.id) : null;
    const binary = table === 'crm_files' ? media.get(row.id) : null;
    if (table === 'crm_files' && !binary) throw new Error('Arquivo não auditado');
    const available = binary?.status === 'downloaded';
    result.push({ id, organization_id: TARGET_ORGANIZATION, batch_id: BATCH_ID, source_table: table, source_id: String(sourceId), source_data: row,
      storage_path: available ? `${TARGET_ORGANIZATION}/${contact ?? 'archive'}/imports/${BATCH_ID}/${binary.sha256}.bin` : null,
      file_name: binary ? row.file_name : null, file_availability: binary ? available ? 'available' : 'unavailable' : null,
      target_table: destination, target_id: targetId, contact_id: contact ?? null,
      conversation_id: table.startsWith('internal_') ? null : mapping.conversationMap.get(row.conversation_id) ?? (table === 'crm_conversations' ? mapping.conversationMap.get(row.id) : null),
      occurred_at: row.created_at ?? row.captured_at ?? null });
    for (const contactId of found) edges.push({ organization_id: TARGET_ORGANIZATION, record_id: id, contact_id: contactId });
  }
  return { data_import_records: result, data_import_record_contacts: edges };
}
