/**
 * Adapter WAHA — o primeiro `ChannelAdapter`, e de propósito o mais burro
 * possível: cada método delega ao `lib/waha/*` que já existe e já é testado.
 * Reimplementar aqui é como se perde paridade de comportamento sem perceber.
 *
 * Nenhuma regra de negócio mora neste arquivo (ver `ChannelAdapter` em ../types).
 */
import { wahaContactPayload } from "@/lib/waha/contact-card";
import { fetchWahaMedia } from "@/lib/messaging/media/waha-source";
import { getWahaClient } from "@/lib/waha/client";
import { wahaSendPlanFor } from "@/lib/waha/media-send";
import {
  resolveCanonicalCusChatId,
  resolveWhatsappIdForContactCard,
} from "@/lib/waha/resolve-contact-whatsapp-id";
import { bareWaMessageId, parseWahaMessageId } from "@/lib/waha/message-id";
import { resolveWahaChatId } from "@/lib/waha/send";
import type { FetchedMedia } from "@/lib/messaging/media/types";
import { DETALHE_CREDENCIAL_RECUSADA } from "../health";
import type { ChannelAdapter, ChannelHealth, OutboundEnvelope, RecipientInput } from "../types";

/**
 * O HTTP que o WAHA devolveu, lido do PREFIXO da mensagem de erro.
 *
 * `lib/waha/client.ts` lança `waha_<status>` ou `waha_<operação>_<status>`, às
 * vezes seguido do corpo da resposta. Procurar `"404"` com `includes` — como
 * este arquivo fazia — varreria o CORPO junto: um `waha_stop_500: {"detail":
 * "upstream 404"}` viraria "sessão parada", dando um transporte quebrado por
 * explicado.
 *
 * Medido, e sem inflar: pelo caminho do `checkHealth` isso NÃO era alcançável
 * hoje — quem ele chama é `getSessionQr`, e essa lança `waha_<status>` seco,
 * sem corpo. A troca é robustez, não o conserto de um defeito observado; o que
 * conserta o defeito observado é o ramo 401/403 abaixo.
 */
export function statusHttpDoErroWaha(msg: string): number | null {
  const m = /^waha_(?:[a-z]+_)?(\d{3})\b/.exec(msg);
  return m ? Number(m[1]) : null;
}

export const wahaAdapter: ChannelAdapter = {
  provider: "waha",

  resolveRecipient(input: RecipientInput): string | null {
    return resolveWahaChatId(input);
  },

  /**
   * As duas pontas do mesmo id, porque os engines gravam lados opostos:
   *   NOWEB — o envio devolve o id cru (`3EB0…`) e o webhook manda o composto
   *           `true_<chatId>_3EB0…`
   *   WEBJS — os dois lados usam o `_serialized` completo
   *
   * Reduzir ao bare cobre o segundo caso; para o primeiro é preciso CONSTRUIR o
   * composto a partir do destinatário — daí o `recipient`. Sem ele o par nunca
   * contém a forma que o webhook realmente gravou.
   *
   * `true_` porque o eco de um envio nosso é sempre `fromMe`.
   */
  echoExternalIds(input: { externalId: string; recipient: string }): string[] {
    const bare = bareWaMessageId(input.externalId);
    return [...new Set([input.externalId, bare, `true_${input.recipient}_${bare}`])];
  },

  // Mesmo pre-check que o handler já fazia com `getWahaClient() !== null`,
  // movido para trás do seam. `getWahaClient` lê o env a cada chamada (não
  // memoiza), então o estado aqui é sempre o corrente.
  isConfigured(): boolean {
    return getWahaClient() !== null;
  },

  // `unknownError` é gravado em `messages.error_message` quando o throw não é
  // um `Error` — valor observável no banco, por isso ele ATRAVESSA o seam com o
  // literal intacto em vez de virar uma string neutra.
  codes: {
    notConfigured: "waha_not_configured",
    sendFailed: "waha_error",
    unknownError: "waha_unknown",
  },

  // A URL vem assinada pelo CDN do WhatsApp e EXPIRA (~9 dias, medido). Quem
  // chama baixa e persiste; guardar a URL faria a foto sumir sozinha depois.
  async fetchProfilePictureUrl(input: {
    sessionRef: string;
    recipient: string;
  }): Promise<string | null> {
    const client = getWahaClient();
    if (!client) return null;
    return client.getProfilePictureUrl(input.sessionRef, input.recipient);
  },

  /**
   * `lid:123…` → `+5959…`, quando a tabela de tradução do canal já souber.
   *
   * Só para identidade OPACA: `phone:` já traz o número, e perguntar seria
   * gastar uma chamada para receber de volta o que já se tem.
   */
  async resolvePhoneForIdentity(input: {
    sessionRef: string;
    identity: string;
  }): Promise<string | null> {
    if (!input.identity.startsWith("lid:")) return null;
    const client = getWahaClient();
    if (!client) return null;
    return client.resolvePhoneForLid(input.sessionRef, input.identity.slice("lid:".length));
  },

  /**
   * Pergunta ao transporte se a conexão está de pé.
   *
   * Três desfechos, e a diferença entre eles é o que o operador vai FAZER:
   *
   *   - respondeu com estado → é a verdade do momento;
   *   - 404 → a sessão não existe mais lá dentro. Não é erro de rede: é a
   *     resposta, e ela quer dizer parada. Sem este ramo o caso mais comum de
   *     desconexão (o transporte esqueceu a sessão) viraria "não deu para
   *     perguntar" e não alertaria ninguém;
   *   - qualquer outro erro → NÃO sabemos. Devolver um estado aqui seria
   *     inventar: uma oscilação de rede viraria "canal caído" e o operador
   *     aprenderia a ignorar o aviso.
   */
  async checkHealth(input: { sessionRef: string }): Promise<ChannelHealth> {
    const client = getWahaClient();
    if (!client) return { reachable: false, status: null, detail: "transporte_nao_configurado" };
    try {
      const r = await client.getSessionQr(input.sessionRef);
      return { reachable: true, status: r.status ?? null, detail: null };
    } catch (err) {
      const msg = err instanceof Error ? err.message : "erro_desconhecido";
      const http = statusHttpDoErroWaha(msg);

      // Sessão não existe no transporte → parada. É o único desfecho em que
      // dá para AFIRMAR o estado da sessão a partir de um erro.
      if (http === 404) return { reachable: true, status: "STOPPED", detail: null };

      // A chave foi recusada. Não é o estado da sessão que está em jogo — é o
      // acesso ao transporte inteiro, e enquanto durar NENHUMA conexão
      // funciona. Continua `reachable: false` porque de fato não se sabe o
      // estado da sessão; o que muda é o `detail`, que a Central lê para dizer
      // ao operador que escanear o QR não vai resolver.
      //
      // Sem isto, um 401 caía no ramo genérico e virava "Não foi possível
      // verificar a conexão" — um aviso `warn` que descreve oscilação de rede.
      // Numa VPS real isso durou TRÊS DIAS: a chave do WAHA tinha sido trocada
      // por uma segunda cópia do repo, nada funcionava, e a única pista visível
      // sugeria um soluço passageiro.
      if (http === 401 || http === 403) {
        return { reachable: false, status: null, detail: DETALHE_CREDENCIAL_RECUSADA };
      }

      return { reachable: false, status: null, detail: msg.slice(0, 200) };
    }
  },

  /**
   * Baixa o anexo que o cliente mandou.
   *
   * Delega em `fetchWahaMedia`, que o worker de persistência chamava FIXO — era
   * essa linha que fazia a mídia de qualquer outro canal virar linha sem bytes.
   * O comportamento aqui é idêntico ao de antes: mesma função, mesmos
   * argumentos. O que mudou é quem a escolhe.
   */
  async fetchInboundMedia(input: {
    sessionRef: string;
    url: string;
    hintMime?: string | null;
  }): Promise<FetchedMedia> {
    // Devolve o objeto INTEIRO, sem remontar campo a campo: `FetchedMedia` é o
    // mesmo tipo dos dois lados, e reconstruí-lo faria a próxima adição de
    // campo sumir em silêncio aqui no meio.
    return fetchWahaMedia(input.url, input.hintMime ?? null);
  },

  async send(envelope: OutboundEnvelope): Promise<{ externalId: string | null }> {
    const client = getWahaClient();
    // Sem env de WAHA o comportamento atual é NOOP, não erro: a UI mostra o
    // banner de "container não está no ar". Transformar em exceção mudaria o
    // comportamento visível — proibido nas Fases 0–2.
    if (!client) return { externalId: null };

    const to = await resolveCanonicalCusChatId(client, envelope.sessionRef, envelope.to);

    // A estrutura de três caminhos é do upstream (o cartão de contato entrou
    // depois da citação). O que se enxerta aqui é o `replyToExternalId` no
    // caminho de TEXTO — os outros dois não citam: o WAHA aceita `reply_to` só
    // no `sendText`, e mandá-lo nos outros seria pedir para a API ignorar em
    // silêncio, que é como se perde uma feature sem ninguém notar.
    let res: unknown;
    if (envelope.kind === "contact" && envelope.contact) {
      const resolvedId = await resolveWhatsappIdForContactCard(
        client,
        envelope.sessionRef,
        envelope.contact.phoneNumber,
      );
      const contact = wahaContactPayload(
        envelope.contact.fullName,
        envelope.contact.phoneNumber,
        resolvedId ?? envelope.contact.whatsappId,
      );
      await envelope.beforeSend?.();
      res = await client.sendContactVcard(envelope.sessionRef, to, [contact]);
    } else if (envelope.media) {
      await envelope.beforeSend?.();
      res = await client.sendMedia(
        envelope.sessionRef,
        to,
        wahaSendPlanFor(envelope.kind, envelope.media),
      );
    } else {
      await envelope.beforeSend?.();
      res = await client.sendMessage(
        envelope.sessionRef,
        to,
        envelope.body ?? "",
        // A citação é enfeite da conversa, nunca condição de envio: quando não
        // há, o envio segue igual. Ver `OutboundEnvelope.replyToExternalId`.
        envelope.replyToExternalId,
      );
    }

    return { externalId: parseWahaMessageId(res) };
  },
};
