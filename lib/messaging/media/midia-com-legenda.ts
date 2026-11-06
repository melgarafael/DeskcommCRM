/**
 * A MÍDIA QUE ACOMPANHA LEGENDA nos passos automáticos (ação `send_whatsapp_message`
 * das automações e passo de mensagem do follow-up).
 *
 * Aqui mora só a DECISÃO do que pode sair: imagem, vídeo, áudio ou documento —
 * e nada além de um arquivo identificável. O envio em si é o caminho de sempre —
 * `sendMessageHandler` (`app/api/v1/messages/_handler.ts`), o mesmo que o Inbox e
 * as campanhas usam. Este módulo não fala com canal nenhum: existe para que a
 * regra de tipo seja UMA, e não uma cópia por ação.
 *
 * ═══ Por que o tipo sai do MIME e, sem MIME, da EXTENSÃO URL ═══
 *
 * O campo do editor é uma URL (o upload pela tela é fatia seguinte), e a URL
 * raramente carrega o MIME. Sem uma pista do tipo, o envio teria de escolher
 * entre dois erros — mandar tudo como `octet-stream` (o que o WhatsApp entrega
 * como arquivo genérico, não como imagem) ou mandar tudo como imagem (o que
 * quebra o PDF). A extensão é a pista que o operador já dá ao colar o link; o
 * MIME declarado, quando existe, tem precedência porque é o dado mais forte.
 *
 * ═══ O recorte ampliado (#2972) ═══
 *
 * O #2734 aceitava imagem e PDF. A #2972 pede áudio (como mensagem de voz), vídeo
 * e documento QUALQUER — porque um `.xlsx` de preços ou um `.docx` de contrato
 * "recusado" é o operador voltando ao script externo que a issue quer aposentar.
 * O destino de cada tipo é o do transporte, decidido no plano de envio de mídia
 * do adapter do canal (nota de voz com conversão para áudio, vídeo para vídeo,
 * arquivo para documento) — este módulo só diz QUAL dos tipos é, e o caminho de
 * envio segue sendo o de sempre.
 *
 * Tipo que NÃO é identificável segue RECUSADO, nunca rebaixado a documento: sem
 * extensão conhecida e sem MIME declarado, escolher um tipo seria adivinhar. Um
 * `.webm` cai nesse caso de propósito — a MESMA extensão serve a áudio e a vídeo,
 * e mandar um como o outro é o envio errado que ninguém vê.
 */
import { kindFromMime } from "./upload-validation";

/** O que a legenda pode acompanhar. */
export type TipoDeMidiaComLegenda = "image" | "video" | "audio" | "document";

export type ClassificacaoDeMidia =
  | { ok: true; type: TipoDeMidiaComLegenda; mime: string }
  | { ok: false; motivo: string };

/** Extensão → MIME, só o que a régua aceita. Chave minúscula, sem o ponto. */
const MIME_POR_EXTENSAO: Record<string, string> = {
  // imagem
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  gif: "image/gif",
  // vídeo — MP4 primeiro: é o formato que o WhatsApp entrega e o que a tela
  // promete. `mov` do iPhone é aceito porque é o que sai da galeria.
  mp4: "video/mp4",
  "3gp": "video/3gpp",
  mov: "video/quicktime",
  // áudio — `ogg`/`opus` é o que o WhatsApp usa como NOTA DE VOZ; os outros
  // saem pela MESMA rota de nota de voz com conversão (o transporte converte).
  ogg: "audio/ogg",
  opus: "audio/ogg",
  mp3: "audio/mpeg",
  m4a: "audio/mp4",
  aac: "audio/aac",
  amr: "audio/amr",
  wav: "audio/wav",
  // documento — a lista é a MESMA que o upload do Inbox aceita
  // (`DOCUMENT_MIMES`, em `./upload-validation.ts`): o que a tela deixa subir
  // tem de poder sair pelo passo automático.
  pdf: "application/pdf",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ppt: "application/vnd.ms-powerpoint",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  txt: "text/plain",
  csv: "text/csv",
  zip: "application/zip",
};

/** Extensão da URL, minúscula e sem query/âncora. `null` quando não há ou a URL é inválida. */
function extensaoDaUrl(url: string): string | null {
  let caminho: string;
  try {
    caminho = new URL(url).pathname;
  } catch {
    return null;
  }
  const ultimo = caminho.split("/").pop() ?? "";
  const ponto = ultimo.lastIndexOf(".");
  if (ponto < 0) return null;
  const ext = ultimo.slice(ponto + 1).toLowerCase();
  return ext.length > 0 ? ext : null;
}

/**
 * Classifica a mídia de um passo automático. `mime` é opcional e, quando dado,
 * vence a extensão — quem declarou o tipo sabe mais que o nome do arquivo.
 *
 * Um MIME declarado que a allowlist do upload não nomeia (um tipo que a tela
 * ainda não conhece) sai como `document`: é um arquivo, e `sendFile` é o que
 * entrega um arquivo. Sem MIME e sem extensão conhecida, recusa.
 */
export function classificarMidiaComLegenda(
  url: string,
  mime?: string | null,
): ClassificacaoDeMidia {
  const declarado = (mime ?? "").split(";")[0]!.trim().toLowerCase();
  const daUrl = extensaoDaUrl(url);
  const efetivo = declarado || (daUrl ? (MIME_POR_EXTENSAO[daUrl] ?? "") : "");
  if (!efetivo) {
    return {
      ok: false,
      motivo:
        "A mídia do passo precisa ter um tipo identificável: uma imagem (jpg, png, webp, gif), um vídeo (mp4, 3gp, mov), um áudio (ogg, mp3, m4a…) ou um documento com extensão conhecida (PDF, docx, xlsx, zip…) — sem extensão reconhecida e sem MIME declarado não dá para saber o que é o arquivo, e ele não é enviado.",
    };
  }
  const kind = kindFromMime(efetivo);
  // `kind` já cobre imagem, vídeo, áudio e os documentos da allowlist.
  if (kind) return { ok: true, type: kind, mime: efetivo };
  // Tipo declarado que a allowlist do upload não nomeia: ainda é um arquivo, e
  // a entrega que não mente é `sendFile` — recusar um tipo que o operador
  // declarou de propósito seria barrar o envio dele.
  return { ok: true, type: "document", mime: efetivo };
}
