"use client";
import { useState } from "react";
import { useHotkeys } from "react-hotkeys-hook";
import { Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useT } from "@/hooks/i18n/useT";
import { CommandPalette } from "@/components/shell/CommandPalette";

export function SearchTrigger() {
  const t = useT();
  const [open, setOpen] = useState(false);

  // `enableOnFormTags`: o atalho precisa funcionar com o cursor dentro do
  // composer do inbox, que é onde o operador passa o dia.
  useHotkeys("mod+k", () => setOpen(true), { preventDefault: true, enableOnFormTags: true });

  return (
    <>
      <Button
        variant="outline"
        size="sm"
        aria-label={t("Buscar telas")}
        className="w-full max-w-sm justify-start gap-2 rounded-xl border-transparent bg-card/70 text-muted-foreground shadow-none"
        onClick={() => setOpen(true)}
      >
        <Search size={14} aria-hidden />
        <span className="hidden md:inline">{t("Buscar...")}</span>
        <kbd className="ml-2 hidden rounded-md border bg-muted px-1.5 py-0.5 text-[10px] md:inline">
          ⌘K
        </kbd>
      </Button>
      <CommandPalette open={open} onOpenChange={setOpen} />
    </>
  );
}
