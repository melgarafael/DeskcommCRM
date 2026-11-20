/**
 * Mídia tem teto MAIOR, e por um motivo medível: `lib/waha/media-send.ts:28,31`
 * manda `convert: true` em `sendVideo` e `sendVoice`. O WAHA roda ffmpeg e BAIXA
 * a URL do Storage antes de responder.
 *
 * Um teto único calibrado para `sendText` cortaria envio de áudio legítimo — o
 * conserto do timeout viraria um defeito novo, e mais difícil de ver que o
 * original, porque a mensagem simplesmente não sai.
 *
 * 180s, e não os 30s da mídia de ENTRADA: com o `proxyClientMaxBodySize` do
 * `next.config.ts`, vídeo de até 50 MB chega inteiro ao WAHA com `convert`, e
 * um envio real de 86 MB levou 69s (#4422). Um abort nosso com o WAHA ainda
 * entregando marcaria "falhou" numa mensagem que saiu. Fica abaixo dos 5 min
 * do `recover-stuck-messages`.
 *
 * Módulo à parte, sem import nenhum, porque o NAVEGADOR também depende deste
 * número: o envio de mídia do inbox espera a resposta por mais que ele
 * (`hooks/inbox/useSendMessage.ts`). Importá-lo de `./client` levaria o logger
 * e o resto do cliente do WAHA para o bundle da tela.
 */
export const TETO_DE_MIDIA_MS = 180_000;
