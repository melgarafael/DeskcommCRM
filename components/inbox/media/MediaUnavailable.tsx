"use client";
import { useT } from "@/hooks/i18n/useT";
import { cn } from "@/lib/utils";
import { ImageIcon } from "@/lib/ui/icons";

/**
 * Fallback compartilhado quando a mídia não carrega (expirada/removida).
 *
 * `detalhe` é o motivo ESCRITO, já traduzido por quem chama, e aparece na tela
 * no lugar do "Mídia indisponível" genérico. Até o #3756 o aviso da retenção
 * entrava em `kind`, que só vai para o leitor de tela: quem enxerga via o
 * genérico e nunca o porquê nem os dias.
 */
export function MediaUnavailable({
  kind,
  detalhe,
  className,
}: {
  kind?: string;
  detalhe?: string;
  className?: string;
}) {
  const t = useT();
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center gap-1 rounded-lg bg-background/40 text-muted-foreground",
        detalhe ? "px-3 py-2 text-center" : null,
        className || (detalhe ? "min-h-24 w-56" : "h-24 w-56"),
      )}
    >
      <ImageIcon size={20} weight="duotone" aria-hidden />
      <span className="text-xs">{detalhe ?? t("Mídia indisponível")}</span>
      {!detalhe && kind && <span className="sr-only">{t(kind)}</span>}
    </div>
  );
}
