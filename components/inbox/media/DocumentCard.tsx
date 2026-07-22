import { DownloadSimple, FileText } from "@/lib/ui/icons";
import { cn } from "@/lib/utils";

import { formatBytes, mediaFileLabel, mediaSrc } from "./media-utils";

interface Props {
  messageId: string;
  mime: string | null;
  sizeBytes: number | null;
  storagePath: string | null;
  isOutbound: boolean;
}

/** Card de documento: rótulo (PDF/MP4/…), tamanho e download. */
export function DocumentCard({ messageId, mime, sizeBytes, storagePath, isOutbound }: Props) {
  const label = mediaFileLabel(mime, storagePath);
  return (
    <a
      href={mediaSrc(messageId)}
      target="_blank"
      rel="noreferrer"
      aria-label="Baixar documento"
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
        <span className="block truncate text-sm font-medium">{label}</span>
        <span className="block text-xs opacity-70">{formatBytes(sizeBytes)}</span>
      </span>
      <DownloadSimple size={18} className="shrink-0 opacity-70" aria-hidden />
    </a>
  );
}
