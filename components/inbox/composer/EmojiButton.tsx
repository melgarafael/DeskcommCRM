"use client";
import { lazy, Suspense, useState } from "react";
import { useT } from "@/hooks/i18n/useT";

import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { Smiley } from "@/lib/ui/icons";

// Lazy: o picker (+dados) só carrega quando o usuário abre — zero peso no bundle do inbox.
const Picker = lazy(() => import("@emoji-mart/react"));

interface Props {
  disabled?: boolean;
  onPick: (emoji: string) => void;
}

export function EmojiButton({ disabled, onPick }: Props) {
  const t = useT();
  const [open, setOpen] = useState(false);
  return (
    // Provider LOCAL, como em MessageBubble.tsx: o painel do inbox não tem
    // TooltipProvider ancestral e o Radix lança sem ele — o throw derruba a
    // árvore inteira, não só a dica. Provider/Tooltip/Trigger não criam nó
    // nenhum: quem entra na linha de ações continua sendo o mesmo botão
    // size="icon", então a altura dela não muda.
    <TooltipProvider delayDuration={200}>
      <Popover open={open} onOpenChange={setOpen}>
        <Tooltip>
          <TooltipTrigger asChild>
            <PopoverTrigger asChild>
              <Button
                type="button"
                size="icon"
                variant="ghost"
                // Some no toque: o teclado do sistema já tem emoji, e o seletor de
                // 352px disputa largura num celular de 390.
                className="shrink-0 pointer-coarse:hidden"
                aria-label={t("Emoji")}
                disabled={disabled}
              >
                <Smiley size={18} weight="regular" aria-hidden />
              </Button>
            </PopoverTrigger>
          </TooltipTrigger>
          <TooltipContent>{t("Emoji")}</TooltipContent>
        </Tooltip>
        <PopoverContent align="start" side="top" className="w-auto border-none p-0 shadow-lg">
          {open && (
            <Suspense fallback={<Skeleton className="h-[420px] w-[352px]" />}>
              <EmojiPickerLazy onPick={onPick} />
            </Suspense>
          )}
        </PopoverContent>
      </Popover>
    </TooltipProvider>
  );
}

function EmojiPickerLazy({ onPick }: { onPick: (emoji: string) => void }) {
  return (
    <Picker
      data={async () => (await import("@emoji-mart/data")).default}
      locale="pt"
      previewPosition="none"
      onEmojiSelect={(e: { native: string }) => onPick(e.native)}
    />
  );
}
