/** Validação do upload outbound (Onda 2). Allowlist por categoria + cap 50MB. */
import { MAX_MEDIA_BYTES } from "@/lib/messaging/media/types";

export type MessageKind = "image" | "video" | "audio" | "document";

/**
 * Leitura por service role: a organização vem da autorização no backend.
 * Os escritores também guardam PDFs em `{org}/{proposta}.pdf`, então não se
 * exige pasta de conversa. O SDK concatena o path na URL de sign/download:
 * recuse escapes e separadores ambíguos, sem normalizar para outro objeto.
 */
export function isMediaPathInOrganization(path: string, orgId: string): boolean {
  const segmentos = path.split("/");
  if (segmentos.length < 2 || segmentos[0] !== orgId) return false;
  if (/[%\\?#\p{Cc}]/u.test(path) || path.endsWith(" ")) return false;
  return segmentos.every((segmento) => segmento !== "" && segmento !== "." && segmento !== "..");
}

/**
 * Posse do objeto para envio: o path DEVE estar sob {org}/{conversation}/.
 *
 * Morava dentro do módulo de transporte do provider legado e não tinha nada a
 * ver com o canal: valida um path do NOSSO Storage, antes de qualquer coisa
 * tocar um provider. Ficar lá obrigava o handler de envio a importar do módulo
 * do provider — o acoplamento que o invariante 1 de
 * `docs/doctrine/restricao-de-canal.md` proíbe.
 */
export function isMediaPathOwnedBy(path: string, orgId: string, conversationId: string): boolean {
  const prefixo = `${orgId}/${conversationId}/`;
  if (!path.startsWith(prefixo)) return false;
  // O prefixo sozinho não prova posse: `{org}/{conv}/../../{outra}/x` começa certo e,
  // se o Storage resolver o `..`, aponta para o arquivo de outra conversa ou organização.
  // Só segmento de nome comum depois do prefixo — nada de `..`, `.`, vazio ou barra invertida.
  const resto = path.slice(prefixo.length);
  if (resto.includes("\\")) return false;
  return resto.split("/").every((s) => s !== "" && s !== "." && s !== "..");
}

/**
 * A mesma régua para o anexo do negócio (#3229): o objeto mora sob
 * `{org}/leads/{lead}/…` no `internal-media`. Quem assina ou remove com o
 * cliente admin confere isto antes — o banco também prende o caminho
 * (`crm_lead_attachments_storage_path_check`), e as duas camadas não se
 * substituem.
 */
export function isLeadAttachmentPathOwnedBy(path: string, orgId: string, leadId: string): boolean {
  return isMediaPathOwnedBy(path, orgId, `leads/${leadId}`);
}

const DOCUMENT_MIMES = new Set([
  "application/pdf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-powerpoint",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "text/plain",
  "text/csv",
  "application/zip",
]);

/**
 * Classe de mídia a partir do MIME — o MESMO corte que a validação do upload
 * faz, exposto para o render.
 *
 * A nota interna (issue #1863, F3) guarda só o mime GRAVADO, sem coluna `type`
 * como `messages`: uma coluna que espelha esta função é coluna que pode divergir
 * da função. Quem renderiza o anexo da nota chama isto — e como é a mesma
 * função, um mime aceito no upload é necessariamente renderizado depois.
 *
 * `null` = mime que o upload NÃO aceita: quem renderiza cai em documento, que é
 * o fallback que sempre dá para baixar o arquivo.
 */
export function kindFromMime(mime: string): MessageKind | null {
  const base = (mime || "").split(";")[0]!.trim().toLowerCase();
  if (base.startsWith("image/")) return "image";
  if (base.startsWith("video/")) return "video";
  if (base.startsWith("audio/")) return "audio";
  if (DOCUMENT_MIMES.has(base)) return "document";
  return null;
}

type Ok = { ok: true; kind: MessageKind };
type Fail = { ok: false; code: "unsupported_media_type" | "payload_too_large" | "validation_failed"; message: string };

export function validateOutboundMedia(mime: string, sizeBytes: number): Ok | Fail {
  if (!sizeBytes || sizeBytes <= 0) {
    return { ok: false, code: "validation_failed", message: "Arquivo vazio." };
  }
  if (sizeBytes > MAX_MEDIA_BYTES) {
    return { ok: false, code: "payload_too_large", message: "Arquivo acima de 50MB." };
  }
  const kind = kindFromMime(mime);
  if (kind) return { ok: true, kind };
  return { ok: false, code: "unsupported_media_type", message: "Tipo de arquivo não suportado." };
}
