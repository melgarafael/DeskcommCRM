"use client";
import { useT } from "@/hooks/i18n/useT";
import { DownloadSimple, FileText } from "@/lib/ui/icons";
import { cn } from "@/lib/utils";

import { formatBytes, mediaFileLabel, mediaSrc } from "./media-utils";

interface Props {
  messageId: string;
  mime: string | null;
  sizeBytes: number | null;
  storagePath: string | null;
  isOutbound: boolean;
  /** Nome ORIGINAL do documento quando o payload o trouxer (#2613). Ausente/vazio → rótulo de extensão. */
  fileName?: string | null;
  /** Fonte alternativa para mídia de NOTA interna (#1863, F3) — ver ImageMedia. */
  src?: string;
}

/** Card de documento: nome original (ou PDF/MP4/…), tamanho e download. */
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
  const label = mediaFileLabel(mime, storagePath, fileName);
  return (
    <a
      href={src ?? mediaSrc(messageId)}
      target="_blank"
      rel="noreferrer"
      aria-label={`${t("Baixar")} ${label} (${formatBytes(sizeBytes)})`}
      className={cn(
        "flex w-60 items-center gap-3 rounded-lg p-2 transition-colors",
        isOutbound
          ? "bg-primary-foreground/10 hover:bg-primary-foreground/20"
          : "bg-background/60 hover:bg-background",
      )}
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
        <span className="block text-xs opacity-70">{formatBytes(sizeBytes)}</span>
      </span>
      <DownloadSimple size={18} className="shrink-0 opacity-70" aria-hidden />
    </a>
  );
}
