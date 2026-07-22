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

/**
 * Normaliza um id de mensagem WAHA para a "cauda" serializada (bare id).
 *
 * O WAHA 2026.x/NOWEB é assimétrico: a resposta de ENVIO devolve o id interno
 * cru (`3EB0…`), mas o webhook `message.ack` chega no formato completo
 * `{fromMe}_{chatId}_{3EB0…}` (ex.: `true_5511…@lid_3EB0…`). Como o envio grava
 * `external_id` = bare, casar o ack pelo id completo nunca acha a linha e o
 * status trava em `sent` (ack=0). Aqui reduzimos ambos ao trecho após o último
 * `_` — chatId (`@c.us`/`@lid`) e o serializado WA não contêm `_`, então a
 * cauda é sempre o bare id; um id já-bare passa intacto (sem `_`).
 */
export function bareWaMessageId(id: string): string {
  const cut = id.lastIndexOf('_');
  return cut === -1 ? id : id.slice(cut + 1);
}
