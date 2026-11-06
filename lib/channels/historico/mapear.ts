/**
 * Do payload do acervo (GET /chats/{id}/messages do WAHA) à linha de `messages`
 * do CRM. Função pura: não toca em banco nem em rede.
 *
 * O `external_id` sai das MESMAS funções que o caminho ao vivo usa
 * (`externalIdDeEntrada` / `externalIdDeSaida`), para a unique
 * (organization_id, external_id) recusar a mensagem que o webhook já gravou.
 */
import {
  bodyOf,
  dataDoTimestamp,
  externalIdDeEntrada,
  externalIdDeSaida,
  mediaMimeOf,
  parseChatId,
  resolveMessageType,
  telefoneAlternativoDe,
  type ChatIdentity,
  type WahaPayload,
} from "@/lib/waha/ingest";
import { chatIdFromWaMessageId } from "@/lib/waha/message-id";

export type MediaStatus = "pendente" | "fora_do_escopo";

export interface LinhaDeMensagemImportada {
  external_id: string;
  direction: "inbound" | "outbound";
  type: string;
  body: string | null;
  sent_at: string;
  status: "delivered" | "sent";
  sent_via: "external_device";
  media_mime: string | null;
  /**
   * `importacao_id` é posto pela rodada (não por este mapeador): diz que a linha
   * veio DESTA importação, para a página refeita não a contar como existente.
   */
  metadata: { historico_importado: "true"; media_status?: MediaStatus; importacao_id?: string };
  organization_id: string;
  conversation_id: string;
  channel_session_id: string;
  contact_id: string;
}

export interface ContextoDaImportacao {
  orgId: string;
  sessionId: string;
  contactId: string;
  conversationId: string;
}

const COM_MIDIA_BAIXADA = new Set(["image", "audio"]);
const COM_MIDIA_FORA = new Set(["video", "document", "sticker"]);

function statusDeMidia(tipo: string): MediaStatus | null {
  if (COM_MIDIA_BAIXADA.has(tipo)) return "pendente";
  if (COM_MIDIA_FORA.has(tipo)) return "fora_do_escopo";
  return null;
}

export function mapearMensagemDoAcervo(
  p: WahaPayload,
  ctx: ContextoDaImportacao,
): LinhaDeMensagemImportada {
  const saida = p.fromMe === true;
  const tipo = resolveMessageType(p);
  const midia = statusDeMidia(tipo);
  const externalId = saida ? externalIdDeSaida(p) : externalIdDeEntrada(p);
  if (!externalId) throw new Error("mensagem do acervo sem id");
  return {
    external_id: externalId,
    direction: saida ? "outbound" : "inbound",
    type: tipo,
    body: bodyOf(p),
    // Sem timestamp válido o `agora` do helper seria inventar data: o acervo
    // sempre traz timestamp, e o epoch deixa a falha visível em vez de plausível.
    sent_at: dataDoTimestamp(p.timestamp, new Date(0).toISOString()),
    status: saida ? "sent" : "delivered",
    sent_via: "external_device",
    media_mime: mediaMimeOf(p),
    metadata: {
      historico_importado: "true",
      ...(midia ? { media_status: midia } : {}),
    },
    organization_id: ctx.orgId,
    conversation_id: ctx.conversationId,
    channel_session_id: ctx.sessionId,
    contact_id: ctx.contactId,
  };
}

/**
 * Todas as formas em que a MESMA mensagem pode já ter sido gravada em
 * `messages.external_id` pelo caminho ao vivo. A importação consulta
 * `external_id in (candidatos)` antes de inserir, porque o chat dentro do id pode
 * mudar de sufixo entre o acervo e o webhook (`@s.whatsapp.net` x `@c.us`).
 * Saída: o bare primeiro (forma que o ao vivo grava) e o completo. Entrada: o
 * completo, as variantes de sufixo de telefone e o bare. Sem duplicatas.
 */
export function candidatosDeExternalId(p: WahaPayload): string[] {
  const id = p.id;
  if (!id) return [];
  const bare = externalIdDeSaida(p) as string;
  const lista: string[] = [];
  if (p.fromMe === true) {
    lista.push(bare, id);
  } else {
    lista.push(externalIdDeEntrada(p) as string);
    if (id.includes("@s.whatsapp.net_")) lista.push(id.replace("@s.whatsapp.net_", "@c.us_"));
    else if (id.includes("@c.us_")) lista.push(id.replace("@c.us_", "@s.whatsapp.net_"));
    lista.push(bare);
  }
  return [...new Set(lista)];
}

/**
 * Com quem é o chat. O chat vem do id (`{fromMe}_{chat}_{bare}`), igual nas duas direções: na
 * saída `from` é o número do operador no acervo. Sem id composto, `from` (entrada)
 * ou `to`/`from` (saída).
 * No `@lid`, o telefone real vem de `_data.key.remoteJidAlt`.
 * O telefone sai cru (E.164): o chamador deve canonicalizá-lo com
 * `canonicalPhoneBR`, como o ingest ao vivo faz, antes de buscar ou criar contato.
 */
export interface IdentidadeDoChat {
  kind: ChatIdentity["kind"];
  phone: string | null;
  lid: string | null;
  chatId: string;
}

export function identidadeDoChat(p: WahaPayload): IdentidadeDoChat {
  const chatId =
    chatIdFromWaMessageId(p.id ?? "") ?? (p.fromMe === true ? (p.to ?? p.from) : p.from) ?? "";
  const parsed = parseChatId(chatId);
  const phone = parsed.kind === "lid" ? telefoneAlternativoDe(p) : parsed.phone;
  return { kind: parsed.kind, phone, lid: parsed.lid, chatId };
}
