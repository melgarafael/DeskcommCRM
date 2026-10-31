"use client";
import { useState } from "react";
import { useHotkeys } from "react-hotkeys-hook";
import { MagnifyingGlass } from "@/lib/ui/icons";
import { Button } from "@/components/ui/button";
import { useT } from "@/hooks/i18n/useT";
import { CommandPalette } from "@/components/shell/CommandPalette";

/**
 * `lateral` / `icone`: o gatilho no topo da barra lateral (redesign kvgroup),
 * aberta ou recolhida. A paleta e o atalho são os mesmos.
 */
export function SearchTrigger({ variante = "barra" }: { variante?: "barra" | "lateral" | "icone" }) {
  const t = useT();
  const [open, setOpen] = useState(false);

  // `enableOnFormTags`: o atalho precisa funcionar com o cursor dentro do
  // composer do inbox, que é onde o operador passa o dia.
  useHotkeys("mod+k", () => setOpen(true), { preventDefault: true, enableOnFormTags: true });

  if (variante !== "barra") {
    return (
      <>
        <button
          type="button"
          onClick={() => setOpen(true)}
          aria-label={t("Buscar...")}
          title={variante === "icone" ? `${t("Buscar...")} ⌘K` : undefined}
          className={
            variante === "icone"
              ? "flex h-8 w-8 items-center justify-center rounded-[7px] text-text-muted transition-colors hover:bg-[var(--kv-hover)] hover:text-text"
              : "flex h-8 min-w-0 flex-1 items-center gap-2 rounded-[7px] border border-border-strong bg-[var(--kv-surface)] px-2.5 text-[13px] text-text-muted transition-colors hover:text-text"
          }
        >
          <MagnifyingGlass size={14} aria-hidden />
          {variante === "lateral" && (
            <>
              <span className="min-w-0 flex-1 truncate text-left">{t("Buscar...")}</span>
              <kbd className="rounded-[4px] border border-border bg-[var(--kv-surface-2)] px-1 text-[10px]">⌘K</kbd>
            </>
          )}
        </button>
        <CommandPalette open={open} onOpenChange={setOpen} />
      </>
    );
  }

  return (
    <>
      <Button
        variant="outline"
        size="sm"
        className="gap-2 text-muted-foreground"
        onClick={() => setOpen(true)}
      >
        <MagnifyingGlass size={14} aria-hidden />
        <span className="max-md:sr-only">{t("Buscar...")}</span>
        <kbd className="ml-2 hidden md:inline rounded-md border bg-muted px-1.5 py-0.5 text-[10px]">⌘K</kbd>
      </Button>
      <CommandPalette open={open} onOpenChange={setOpen} />
    </>
  );
}
