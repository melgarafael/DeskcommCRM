/** Decisões explícitas da revisão; não faz deduplicação por nome ou telefone. */
import { migrationId, TARGET_ORGANIZATION } from './core.mjs';

export const APPROVED_CONTACT_MERGE = [
  '96ae75ce-4dc1-4f5b-9e09-004dc0f748c9',
  'b8b9072c-c388-484e-b159-631317168909',
];

export function buildIdentityMap({ contacts, conversations, approvedMerge = APPROVED_CONTACT_MERGE }) {
  const byId = new Map(contacts.map(row => [row.id, row]));
  if (byId.size !== contacts.length) throw new Error('Contato repetido no lote');
  const parents = new Map();
  for (const row of contacts) {
    if (row.merged_into_id) {
      if (!byId.has(row.merged_into_id)) throw new Error('Destino de unificação ausente');
      parents.set(row.id, row.merged_into_id);
    }
  }
  function root(id) {
    if (!byId.has(id)) throw new Error('Contato referenciado ausente');
    const seen = new Set();
    while (parents.has(id)) {
      if (seen.has(id)) throw new Error('Ciclo de unificação');
      seen.add(id); id = parents.get(id);
    }
    return id;
  }
  for (const id of byId.keys()) root(id);
  if (approvedMerge.length) {
    if (approvedMerge.length !== 2 || approvedMerge.some(id => !byId.has(id))) throw new Error('Revisão não corresponde ao lote');
    // Escolha estável de representante; ambos os cadastros ficam no arquivo de origem.
    const roots = [...new Set(approvedMerge.map(root))].sort();
    if (roots.length === 2) parents.set(roots[1], roots[0]);
  }
  const contactGroups = new Map(), contactMap = new Map();
  for (const row of contacts) {
    const canonical = root(row.id);
    if (!contactGroups.has(canonical)) contactGroups.set(canonical, []);
    contactGroups.get(canonical).push(row.id);
    contactMap.set(row.id, migrationId(TARGET_ORGANIZATION, 'contacts', canonical));
  }
  const conversationGroups = new Map(), conversationMap = new Map();
  const seenConversations = new Set();
  for (const row of conversations) {
    if (seenConversations.has(row.id)) throw new Error('Conversa repetida no lote');
    seenConversations.add(row.id);
    if (!contactMap.has(row.contact_id)) throw new Error('Conversa sem contato conhecido');
    // Canal sem identidade permanece separado por rede, jamais associado por suposição.
    const key = JSON.stringify([contactMap.get(row.contact_id), row.channel, row.channel_id ?? null]);
    if (!conversationGroups.has(key)) conversationGroups.set(key, []);
    conversationGroups.get(key).push(row.id);
  }
  for (const ids of conversationGroups.values()) {
    ids.sort();
    const target = migrationId(TARGET_ORGANIZATION, 'conversations', ids[0]);
    for (const id of ids) conversationMap.set(id, target);
  }
  for (const ids of contactGroups.values()) ids.sort();
  return { contactMap, conversationMap, contactGroups, conversationGroups };
}

export function verifyReferences(tables, mapping) {
  const contactFields = new Set(['contact_id', 'source_contact_id', 'target_contact_id', 'merged_into_id']);
  const conversationFields = new Set(['conversation_id', 'merged_from_conversation_id']);
  const dangling = [];
  for (const [table, rows] of Object.entries(tables)) for (const row of rows) {
    for (const [key, value] of Object.entries(row)) {
      if (!value) continue;
      // Chat interno tem namespace próprio; não é uma conversa de cliente.
      if (table.startsWith('internal_') && key === 'conversation_id') {
        if (!(tables.internal_conversations ?? []).some(parent => parent.id === value)) dangling.push({ table, source_id: row.id, field: key, referenced_id: value });
        continue;
      }
      const map = contactFields.has(key) ? mapping.contactMap : conversationFields.has(key) ? mapping.conversationMap : null;
      if (map && !map.has(value)) dangling.push({ table, source_id: row.id, field: key, referenced_id: value });
    }
  }
  return dangling;
}
