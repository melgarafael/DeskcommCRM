/**
 * Extração do id externo da resposta de envio do WAHA (Fase 4A-3 da fusão).
 *
 * O shape do `id` varia por engine/versão do WAHA:
 *   - string plana ("ABCD...")
 *   - WAMessageKey do WEBJS: { id: { _serialized: "..." } }
 *   - NOWEB: { id: { id: "..." } } ou { key: { id: "..." } }
 * Sem casar o shape, `messages.external_id` fica null e o ack do webhook nunca
 * encontra a linha — insere duplicata em vez de atualizar (bug real da Fase 1).
 */
export function parseWahaMessageId(raw: unknown): string | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as { id?: unknown; key?: { id?: unknown } };
  if (typeof r.id === 'string') return r.id;
  if (typeof r.id === 'object' && r.id !== null) {
    const serialized = (r.id as { _serialized?: unknown })._serialized;
    if (typeof serialized === 'string') return serialized;
    const innerId = (r.id as { id?: unknown }).id;
    if (typeof innerId === 'string') return innerId;
  }
  if (typeof r.key === 'object' && r.key !== null && typeof r.key.id === 'string') return r.key.id;
  return null;
}
