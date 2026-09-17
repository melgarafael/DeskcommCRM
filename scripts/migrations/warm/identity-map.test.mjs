import { test } from 'vitest';
import assert from 'node:assert/strict';
import { buildIdentityMap, verifyReferences } from './identity-map.mjs';

const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const contact = (n, parent = null) => ({ id: id(n), merged_into_id: parent && id(parent) });
const conversation = (n, c, ch = id(50)) => ({ id: id(n), contact_id: id(c), channel: 'whatsapp', channel_id: ch });

test('unificação aprovada preserva mapeamento dos dois contatos e todas as conversas', () => {
  const result = buildIdentityMap({ contacts: [contact(1), contact(2), contact(3, 2)], conversations: [conversation(10, 1), conversation(11, 2), conversation(12, 3)], approvedMerge: [id(1), id(2)] });
  assert.equal(result.contactMap.size, 3);
  assert.equal(new Set(result.contactMap.values()).size, 1);
  assert.equal(result.conversationMap.size, 3);
  assert.equal(new Set(result.conversationMap.values()).size, 1);
  assert.deepEqual([...result.contactGroups.values()][0], [id(1), id(2), id(3)]);
  assert.deepEqual(verifyReferences({ messages: [{ id: id(99), conversation_id: id(12) }], tasks: [{ id: id(98), contact_id: id(3) }] }, result), []);
});

test('telefone ou nome iguais não autorizam outras unificações', () => {
  const result = buildIdentityMap({ contacts: [{ ...contact(1), name: 'Mesmo nome', phone: '+15555555555' }, { ...contact(2), name: 'Mesmo nome', phone: '+15555555555' }], conversations: [], approvedMerge: [] });
  assert.equal(result.contactGroups.size, 2);
});

test('canais distintos e canal sem identificação não se misturam', () => {
  const result = buildIdentityMap({ contacts: [contact(1)], conversations: [conversation(10, 1), conversation(11, 1, id(51)), conversation(12, 1, null)], approvedMerge: [] });
  assert.equal(result.conversationGroups.size, 3);
});

test('ordem de extração não altera IDs de destino', () => {
  const input = { contacts: [contact(2), contact(1)], conversations: [conversation(11, 2), conversation(10, 1)], approvedMerge: [id(2), id(1)] };
  const a = buildIdentityMap(input);
  const b = buildIdentityMap({ ...input, contacts: input.contacts.toReversed(), conversations: input.conversations.toReversed() });
  for (const [key, value] of a.contactMap) assert.equal(b.contactMap.get(key), value);
  for (const [key, value] of a.conversationMap) assert.equal(b.conversationMap.get(key), value);
});

test('falha fechada em ciclo, pai ausente, decisão fora do lote e conversa órfã', () => {
  for (const input of [
    { contacts: [contact(1, 2), contact(2, 1)], conversations: [], approvedMerge: [] },
    { contacts: [contact(1, 2)], conversations: [], approvedMerge: [] },
    { contacts: [contact(1)], conversations: [], approvedMerge: [id(1), id(2)] },
    { contacts: [contact(1)], conversations: [conversation(10, 2)], approvedMerge: [] },
  ]) assert.throws(() => buildIdentityMap(input));
});

test('referência não resolvida exige revisão, não é descartada silenciosamente', () => {
  const map = buildIdentityMap({ contacts: [contact(1)], conversations: [], approvedMerge: [] });
  assert.deepEqual(verifyReferences({ crm_tasks: [{ id: id(7), contact_id: id(2) }] }, map), [{ table: 'crm_tasks', source_id: id(7), field: 'contact_id', referenced_id: id(2) }]);
});
