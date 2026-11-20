/**
 * Quais mensagens do cliente ESTA resposta lê — a lista que vai em
 * `OutboundEnvelope.readExternalIds` para o canal marcá-las como lidas (#5015).
 *
 * ─── Por que existe ─────────────────────────────────────────────────────────
 *
 * O visto azul (#2981) pedia ao canal "li esta conversa", sem dizer quais
 * mensagens. No NOWEB com "Guardar histórico" desligado — o padrão desde o #999 —
 * o WAHA só sabe marcar por mensagem e recusa o pedido sem ids com 400. O adapter
 * não lê banco (`docs/doctrine/restricao-de-canal.md`), então a lista é resolvida
 * aqui, por quem monta o envelope, como já é o `external_id` da citada.
 *
 * ─── A régua ────────────────────────────────────────────────────────────────
 *
 * "Respondi, então li" = as mensagens que o cliente mandou DEPOIS do último envio
 * nosso que saiu de verdade. Um envio que falhou ou ainda está na fila não
 * respondeu nada, então não fecha a régua. A linha do próprio envio em curso
 * (já inserida pelo handler) fica de fora pelo id.
 *
 * Reação e mensagem de sistema ficam de fora, como em `ultimaMensagemDoCliente`
 * (`lib/messaging/presenca.ts`): são registros do cliente, mas não mensagens que
 * alguém responde. Linha sem `external_id` não tem como ser endereçada.
 *
 * Teto de 30: o mesmo que o WAHA aplica ao "li a conversa" numa conversa
 * individual. Devolve da mais antiga para a mais nova.
 *
 * ─── Falha ──────────────────────────────────────────────────────────────────
 *
 * Erro de leitura devolve `undefined`, que o canal entende como "ninguém
 * procurou": volta ao pedido de antes (a conversa inteira), que segue valendo
 * para quem tem o store ligado. O visto é enfeite da resposta e nunca a segura.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

/** Quantas linhas da conversa olhar, da mais nova para trás. */
const LINHAS_OLHADAS = 60;
/** O teto do próprio WAHA para "li a conversa" numa conversa individual. */
const MAXIMO_DE_IDS = 30;
/** Status de saída em que a mensagem chegou ao transporte — a resposta existiu. */
const SAIU = new Set(["sent", "delivered", "read", "replied"]);
/** Tipos de entrada que não são mensagem que alguém responde. */
const NAO_E_MENSAGEM = new Set(["reaction", "system"]);

interface LinhaDaConversa {
  id: string;
  direction: string | null;
  type: string | null;
  status: string | null;
  external_id: string | null;
  sent_at: string | null;
  created_at: string | null;
}

export interface RecebidasALerInput {
  /** De FONTE CONFIÁVEL (`ctx`), nunca do corpo: o client pode ser de service role. */
  organizationId: string;
  conversationId: string;
  /** A linha do envio em curso, que não conta como resposta anterior. */
  envioId: string;
}

const momento = (l: LinhaDaConversa) => Date.parse(l.sent_at ?? l.created_at ?? "") || 0;

export async function recebidasQueARespostaLe(
  supabase: SupabaseClient,
  input: RecebidasALerInput,
): Promise<string[] | undefined> {
  try {
    const { data, error } = await supabase
      .from("messages")
      .select("id, direction, type, status, external_id, sent_at, created_at")
      .eq("organization_id", input.organizationId)
      .eq("conversation_id", input.conversationId)
      .order("sent_at", { ascending: false, nullsFirst: false })
      .order("created_at", { ascending: false })
      .limit(LINHAS_OLHADAS);
    if (error || !Array.isArray(data)) return undefined;

    // A ordem é refeita aqui: a régua depende dela, e `sent_at` nulo (linha em
    // fila) cai na hora em que a linha nasceu.
    const linhas = (data as LinhaDaConversa[]).slice().sort((a, b) => momento(b) - momento(a));

    const lidas: string[] = [];
    for (const l of linhas) {
      if (l.id === input.envioId) continue;
      if (l.direction === "outbound") {
        if (l.status && SAIU.has(l.status)) break;
        continue;
      }
      if (l.direction !== "inbound") continue;
      if (l.type && NAO_E_MENSAGEM.has(l.type)) continue;
      if (!l.external_id) continue;
      lidas.push(l.external_id);
      if (lidas.length >= MAXIMO_DE_IDS) break;
    }
    return lidas.reverse();
  } catch {
    return undefined;
  }
}
