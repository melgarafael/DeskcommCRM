/**
 * O nome do arquivo quando o atendente clica em "Baixar".
 *
 * O nome ORIGINAL sempre vence (#2613): é o que o cliente mandou e o que a
 * equipe procura depois na pasta. Mas a API oficial da Meta só manda `filename`
 * em documento — foto, vídeo e áudio chegam sem nome. Sem um nome, a rota não
 * pedia download nenhum, e o navegador abria a foto em vez de salvá-la: era por
 * isso que a foto não tinha botão de baixar (relato de 09/11/2026).
 *
 * Para mídia sem nome, este arquivo dá um nome que se lê na pasta de Downloads:
 * o tipo, a data e a hora em que a mensagem foi enviada (no fuso da
 * organização, o mesmo relógio da tela) e o começo do id da mensagem. O pedaço
 * do id existe porque três fotos mandadas no mesmo minuto teriam o mesmo nome,
 * e o navegador as salvaria como `foto (1).jpg`, `foto (2).jpg`, sem ordem.
 *
 * Função pura: não lê banco nem relógio. Quem chama passa o fuso já resolvido.
 */
import { extFromMime } from "@/lib/messaging/media/types";

export interface MidiaParaBaixar {
  /** O id da mensagem. */
  id: string;
  /** `nomeOriginalDaMensagem(metadata)` — `null` quando o canal não mandou nome. */
  nomeOriginal: string | null;
  media_mime: string | null;
  media_storage_path: string | null;
  /** O instante do envio, ISO-8601. */
  sent_at: string | null;
}

function prefixoDoTipo(mime: string): string {
  if (mime.startsWith("image/")) return "foto";
  if (mime.startsWith("video/")) return "video";
  if (mime.startsWith("audio/")) return "audio";
  return "arquivo";
}

function extensao(mime: string, storagePath: string | null): string | null {
  const doPath = storagePath?.split("/").pop()?.split(".");
  const ext = doPath && doPath.length > 1 ? doPath.pop()?.toLowerCase() : undefined;
  if (ext && ext !== "bin" && /^[a-z0-9]{1,8}$/.test(ext)) return ext;
  const peloMime = extFromMime(mime);
  return peloMime && peloMime !== "bin" ? peloMime : null;
}

/** `2026-11-09-14h14` no fuso pedido; `null` se o instante ou o fuso não servirem. */
function carimbo(sentAt: string | null, fuso: string): string | null {
  if (!sentAt) return null;
  const instante = new Date(sentAt);
  if (Number.isNaN(instante.getTime())) return null;
  try {
    const partes = Object.fromEntries(
      new Intl.DateTimeFormat("en-CA", {
        timeZone: fuso,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        hourCycle: "h23",
      })
        .formatToParts(instante)
        .map((p) => [p.type, p.value]),
    ) as Record<string, string>;
    return `${partes.year}-${partes.month}-${partes.day}-${partes.hour}h${partes.minute}`;
  } catch {
    return null;
  }
}

export function nomeParaBaixar(midia: MidiaParaBaixar, fuso: string): string {
  if (midia.nomeOriginal) return midia.nomeOriginal;
  const mime = (midia.media_mime ?? "").toLowerCase();
  const partes = [prefixoDoTipo(mime), carimbo(midia.sent_at, fuso), midia.id.replace(/-/g, "").slice(0, 6)]
    .filter(Boolean)
    .join("-");
  const ext = extensao(mime, midia.media_storage_path);
  return ext ? `${partes}.${ext}` : partes;
}
