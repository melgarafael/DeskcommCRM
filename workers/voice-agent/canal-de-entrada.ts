/**
 * Correlação entre o canal NATIVO do Asterisk e a linha de `voice_calls` de
 * uma ligação RECEBIDA.
 *
 * Na entrada quem escolhe o `channel.id` é o Asterisk ("<epoch>.<seq>", ex.:
 * "1789081888.0"), e ele não serve de UUID para o AudioSocket (o
 * `app_audiosocket.c` recusa com "Failed to parse UUID"). Por isso a linha é
 * gravada com um UUID próprio em `asterisk_channel_id`.
 *
 * Esse UUID era SORTEADO (`randomUUID()`), e o efeito era que nada mais
 * conseguia voltar do canal para a linha: o `ChannelDestroyed` chega com o
 * `channel.id` nativo e procurava por ele, sem nunca achar. Toda ligação
 * recebida que caía antes de o AudioSocket conectar — quem liga desiste, o
 * serviço de voz fora do ar, "Name does not resolve" — ficava `ringing` PARA
 * SEMPRE, e a tela do CRM mostrava o banner de "ligação chegando" a cada
 * carregamento, dias depois (medido em produção em 2026-11-04: 5 linhas de
 * 02/11 tocando, recusar não resolvia).
 *
 * Derivado do `channel.id` por hash, o UUID se recalcula a partir do evento —
 * sem mapa em memória, então vale também depois de o worker reiniciar.
 * Não é segredo nem autorização: é só correlação, e o AudioSocket só é
 * alcançável pela rede interna do compose.
 */
import { createHash } from "node:crypto";

/** Prefixo fixo: o mesmo `channel.id` sempre dá o mesmo UUID. */
const ESPACO = "voice-agent/audiosocket-de-entrada:";

/** UUID (formato v5: SHA-1 + versão/variante) do AudioSocket de uma ligação recebida. */
export function uuidDoAudioSocketDeEntrada(channelId: string): string {
  const b = createHash("sha1")
    .update(ESPACO + channelId)
    .digest()
    .subarray(0, 16);
  b[6] = (b[6]! & 0x0f) | 0x50;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const h = b.toString("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

/**
 * Valores de `asterisk_channel_id` que podem pertencer a um canal que o
 * Asterisk acabou de destruir: o próprio id (ligação FEITA, em que o
 * `route.ts` escolhe um UUID e o passa como `channelId` no originate) e o
 * derivado (ligação RECEBIDA).
 */
export function idsDaLinhaDoCanal(channelId: string): string[] {
  return [channelId, uuidDoAudioSocketDeEntrada(channelId)];
}
