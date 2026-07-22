import { ImageIcon } from "@/lib/ui/icons";

/** Fallback compartilhado quando a mídia não carrega (expirada/removida). */
export function MediaUnavailable({ kind }: { kind: string }) {
  return (
    <div className="flex h-24 w-56 flex-col items-center justify-center gap-1 rounded-lg bg-background/40 text-muted-foreground">
      <ImageIcon size={20} weight="duotone" aria-hidden />
      <span className="text-xs">Mídia indisponível</span>
      <span className="sr-only">{kind}</span>
    </div>
  );
}
