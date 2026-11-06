"use client";
import { useRef } from "react";
import { useT } from "@/hooks/i18n/useT";

import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { FileText, ImageSquare, Plus, UserCircle } from "@/lib/ui/icons";

interface Props {
  disabled?: boolean;
  onPick: (file: File) => void;
  onPickContact?: () => void;
}

/** Menu "+" do composer (padrão WhatsApp): Fotos e vídeos / Documento / Contato. */
export function AttachMenu({ disabled, onPick, onPickContact }: Props) {
  const t = useT();
  const mediaRef = useRef<HTMLInputElement | null>(null);
  const docRef = useRef<HTMLInputElement | null>(null);

  const handle = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) onPick(file);
    e.target.value = ""; // permite re-selecionar o mesmo arquivo
  };

  return (
    <>
      {/* Provider LOCAL, como em MessageBubble.tsx: o painel do inbox não tem
          TooltipProvider ancestral e o Radix lança sem ele — o throw derruba a
          árvore inteira, não só a dica. Os wrappers (Provider/Tooltip/Trigger)
          não criam nó nenhum no DOM: quem entra na linha de ações continua
          sendo o mesmo botão size="icon", e a altura dela não muda. */}
      <TooltipProvider delayDuration={200}>
        <Popover>
          <Tooltip>
            <TooltipTrigger asChild>
              <PopoverTrigger asChild>
                <Button
                  type="button"
                  size="icon"
                  variant="ghost"
                  className="shrink-0"
                  aria-label={t("Anexar")}
                  disabled={disabled}
                >
                  <Plus size={18} weight="regular" aria-hidden />
                </Button>
              </PopoverTrigger>
            </TooltipTrigger>
            <TooltipContent>{t("Anexar")}</TooltipContent>
          </Tooltip>
          <PopoverContent align="start" side="top" className="w-52 p-1">
            <button
              type="button"
              className="flex min-h-11 w-full items-center gap-2 rounded-md px-2 py-2 text-sm hover:bg-muted lg:min-h-0"
              onClick={() => mediaRef.current?.click()}
            >
              <ImageSquare size={18} weight="duotone" className="text-primary" aria-hidden />
              {t("Fotos e vídeos")}
            </button>
            <button
              type="button"
              className="flex min-h-11 w-full items-center gap-2 rounded-md px-2 py-2 text-sm hover:bg-muted lg:min-h-0"
              onClick={() => docRef.current?.click()}
            >
              <FileText size={18} weight="duotone" className="text-primary" aria-hidden />
              {t("Documento")}
            </button>
            {onPickContact && (
              <button
                type="button"
                className="flex min-h-11 w-full items-center gap-2 rounded-md px-2 py-2 text-sm hover:bg-muted lg:min-h-0"
                onClick={onPickContact}
              >
                <UserCircle size={18} weight="duotone" className="text-primary" aria-hidden />
                {t("Contato")}
              </button>
            )}
          </PopoverContent>
        </Popover>
      </TooltipProvider>
      {/* Os inputs vivem FORA do PopoverContent: o Radix desmonta o conteúdo do
          popover ao fechar, e um input desmontado no meio do clique perde o
          file picker ("nada acontece"). Aqui os refs seguem válidos após o
          fechamento — o .click() síncrono no onClick preserva o user-gesture. */}
      <input ref={mediaRef} type="file" accept="image/*,video/*" className="hidden" onChange={handle} />
      <input
        ref={docRef}
        type="file"
        accept=".pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.txt,.csv,.zip"
        className="hidden"
        onChange={handle}
      />
    </>
  );
}
