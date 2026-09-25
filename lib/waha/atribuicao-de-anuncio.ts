/**
 * Extrator de atribuição de anúncio da mensagem crua do transporte por QR.
 *
 * Mora em `lib/waha/` pelo mesmo motivo do irmão em `lib/channels/`: nomear o
 * provider aqui é legítimo (é o próprio canal), e fora daqui o
 * `pnpm lint:channels` reprova. O formato agnóstico e a gravação estão em
 * `lib/leads/atribuicao-de-anuncio.ts`.
 */
import type { AtribuicaoDeAnuncio, Bruto } from "@/lib/leads/atribuicao-de-anuncio";
import { obj, str } from "@/lib/leads/atribuicao-de-anuncio";

/**
 * `contextInfo.externalAdReply` (observado em mensagens reais do WAHA NOWEB)
 * ou `contextInfo.externalAdReplyInfo` (forma legada do Baileys) — o dado do anúncio,
 * embutido na PRÓPRIA mensagem que o app do cliente manda ao clicar num
 * anúncio "Clique para o WhatsApp". `messageRaw` é `_data.message` do payload
 * do WAHA (NOWEB) — a forma bruta do Baileys, sem normalização.
 *
 * O ad-reply pode chegar em qualquer tipo de mensagem com `contextInfo`
 * (o clique manda texto na maioria dos casos, daí `extendedTextMessage` vir
 * primeiro na lista de candidatos), então a busca varre os tipos comuns em
 * vez de assumir um só.
 */
export function extrairAtribuicaoWaha(messageRaw: unknown): AtribuicaoDeAnuncio | null {
  const m = obj(messageRaw);
  if (!m) return null;

  const candidatos = [
    obj(m.extendedTextMessage)?.contextInfo,
    obj(m.imageMessage)?.contextInfo,
    obj(m.videoMessage)?.contextInfo,
    obj(m.conversation) ? null : m.contextInfo,
  ];
  const ad = candidatos
    .map(obj)
    .map((contextInfo) => obj(contextInfo?.externalAdReply) ?? obj(contextInfo?.externalAdReplyInfo))
    .find((candidate): candidate is Bruto => candidate !== null);
  if (!ad) return null;

  // O mesmo filtro que o irmão da API oficial aplica, e que aqui faltava: post
  // ORGÂNICO compartilhado não é anúncio pago. Sem esta linha, o primeiro
  // compartilhamento de um post carimba `meta_ads` no contato — e a guarda de
  // primeiro toque torna isso IRREVERSÍVEL pelo caminho normal.
  const tipo = str(ad.sourceType) ?? str(ad.source_type);
  if (tipo && tipo !== "ad") return null;

  const sourceId = str(ad.ctwaClid) ?? str(ad.ctwa_clid);
  // Mesma separação do irmão da API oficial: o clique é `ctwaClid`, o anúncio é
  // `sourceId`, e quem traz os dois não pode perder um.
  const adId = str(ad.sourceId) ?? str(ad.source_id);
  const titulo = str(ad.title);
  const sourceUrl = str(ad.sourceUrl);
  if (!sourceId && !adId && !titulo && !sourceUrl) return null;

  return {
    plataforma: "meta_ads",
    sourceId,
    adId,
    titulo,
    corpo: str(ad.body),
    sourceUrl,
    bruto: ad,
  };
}
