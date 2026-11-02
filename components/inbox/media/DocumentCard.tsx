"use client";
import { useT } from "@/hooks/i18n/useT";
import { DownloadSimple, FileText } from "@/lib/ui/icons";
import { cn } from "@/lib/utils";

import { extensaoDoDocumento, formatBytes, mediaDownloadSrc, mediaSrc } from "./media-utils";

interface Props {
  messageId: string;
  mime: string | null;
  sizeBytes: number | null;
  storagePath: string | null;
  isOutbound: boolean;
  /** Nome ORIGINAL do documento quando o payload o trouxer (#2613). Ausente/vazio → `Documento XLSX`. */
  fileName?: string | null;
  /** Fonte alternativa para mídia de NOTA interna (#1863, F3) — ver ImageMedia. */
  src?: string;
}

/**
 * Card de documento: nome original (ou `Documento XLSX`), tamanho e download.
 *
 * Dois links, dois destinos, de propósito (#2613):
 *
 *   · a ÁREA do cartão abre a mídia como sempre (`/media`) — o PDF abre em aba
 *     nova, o preview não vira download;
 *   · o ÍCONE de download pede `?baixar=1`, e é a rota que, tendo o nome
 *     original guardado, o devolve no `Content-Disposition`. Sem o nome ela não
 *     inventa: o arquivo sai como antes. Ver
 *     `app/api/v1/messages/[id]/media/route.ts`.
 *
 * O rótulo sem nome diz `Documento XLSX`, não `XLSX`: a extensão sozinha se lê
 * como título do arquivo, e era assim que o Inbox afirmava mais do que sabia
 * (anexo antigo, ou canal que não manda `filename`).
 */
export function DocumentCard({
  messageId,
  mime,
  sizeBytes,
  storagePath,
  isOutbound,
  fileName,
  src,
}: Props) {
  const t = useT();
  const nome = fileName?.trim() || null;
  const extensao = extensaoDoDocumento(mime, storagePath);
  const label =
    nome ?? (extensao ? t("Documento {ext}").replace("{ext}", extensao) : t("Documento"));
  const tamanho = formatBytes(sizeBytes);
  return (
    <div
      className={cn(
        "flex w-60 max-w-full items-center gap-1 rounded-lg transition-colors",
        isOutbound
          ? "bg-primary-foreground/10 hover:bg-primary-foreground/20"
          : "bg-background/60 hover:bg-background",
      )}
    >
      <a
        href={src ?? mediaSrc(messageId)}
        target="_blank"
        rel="noreferrer"
        aria-label={`${label} (${tamanho})`}
        className="flex min-w-0 flex-1 items-center gap-3 p-2"
      >
        <span
          className={cn(
            "flex h-10 w-10 shrink-0 items-center justify-center rounded-lg",
            isOutbound ? "bg-primary-foreground/20" : "bg-primary/10 text-primary",
          )}
        >
          <FileText size={20} weight="duotone" aria-hidden />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium" title={label}>
            {label}
          </span>
          <span className="block text-xs opacity-70">{tamanho}</span>
        </span>
      </a>
      <a
        href={src ?? mediaDownloadSrc(messageId)}
        target="_blank"
        rel="noreferrer"
        aria-label={`${t("Baixar")} ${label} (${tamanho})`}
        className="flex shrink-0 items-center justify-center p-2 opacity-70 transition-opacity hover:opacity-100 pointer-coarse:min-h-11 pointer-coarse:min-w-11"
      >
        <DownloadSimple size={18} aria-hidden />
      </a>
    </div>
  );
}
