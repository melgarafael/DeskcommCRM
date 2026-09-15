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

/**
 * As formas que o ECO de uma mensagem que nós mandamos pode ter gravado em
 * `messages.external_id` — para achar e apagar a linha que o webhook criou antes
 * de o envio conhecer o próprio id.
 *
 * Os engines gravam lados opostos:
 *   NOWEB — o envio devolve o id cru (`3EB0…`) e o webhook grava o composto
 *           `true_<chatId>_3EB0…`
 *   WEBJS — os dois lados usam o `_serialized` completo
 *
 * Reduzir ao bare cobre o segundo caso; para o primeiro é preciso CONSTRUIR o
 * composto a partir do destinatário, porque sem ele a lista nunca contém a forma
 * que o webhook realmente gravou. `true_` porque o eco de um envio nosso é sempre
 * `fromMe`.
 *
 * Mora aqui, e não no adaptador, porque tem DOIS usuários que precisam da mesma
 * resposta: o envio normal (`wahaAdapter.echoExternalIds`, chamado por
 * `app/api/v1/messages/_handler.ts`) e o reenvio do watchdog
 * (`lib/agent-engine/edge/crm/session-reconciler.ts`), que roda noutro processo,
 * com `pg` cru e sem o seam de canal. Duas cópias desta regra divergem, e a
 * divergência não quebra nada à vista: ela só faz o eco sumir por um caminho e
 * ficar pelo outro — que é como a mensagem duplicada "voltava".
 *
 * ⚠️ LIMITE CONHECIDO, o mesmo nos dois caminhos: se o engine ecoar com um chat
 * diferente do que usamos para enviar (`@lid` de um lado, `@c.us` do outro), o
 * composto construído não casa e a duplicata fica. O conserto de raiz é canonizar
 * o id nas duas pontas — desenho na issue #196 do DeskcommCRM.
 */
export function wahaEchoExternalIds(externalId: string, recipient: string): string[] {
  const bare = bareWaMessageId(externalId);
  return [...new Set([externalId, bare, `true_${recipient}_${bare}`])];
}

/**
 * Extrai o chatId do id composto do WAHA (`{fromMe}_{chatId}_{bareId}`).
 *
 * Existe porque o NOWEB **não manda `to`** no payload de mensagem `fromMe=true`
 * (a que o dono digitou no celular): o chat vai em `from`, e `to` simplesmente
 * não vem. Payload real capturado numa instalação:
 *
 *   { "id": "true_250302204792918@lid_2A1B890FB8AA87730CBC",
 *     "from": "250302204792918@lid", "fromMe": true, "source": "app" }
 *
 * Como o id JÁ carrega o chatId, dá para recuperá-lo sem depender do engine.
 * Mesmo raciocínio de `bareWaMessageId`: chatId (`@c.us`/`@lid`) e o serializado
 * WA não contêm `_`, então as fatias entre o primeiro e o último `_` são o chat.
 *
 * Devolve null quando o id não é composto (id "bare" do envio) ou quando o
 * miolo não parece um chatId — assim quem chama cai no próximo fallback em vez
 * de inventar um contato a partir de lixo.
 */
export function chatIdFromWaMessageId(id: string): string | null {
  const first = id.indexOf('_');
  const last = id.lastIndexOf('_');
  if (first === -1 || last === first) return null;
  const chat = id.slice(first + 1, last);
  return chat.includes('@') ? chat : null;
}
