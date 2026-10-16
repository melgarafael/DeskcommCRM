"use client";
import { useRef } from "react";
import { useT } from "@/hooks/i18n/useT";

import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
import { FileText, ImageSquare, Plus, ShoppingBag, UserCircle } from "@/lib/ui/icons";

interface Props {
  disabled?: boolean;
  onPick: (file: File) => void;
  onPickFiles?: (files: File[]) => void;
  onPickContact?: () => void;
  onPickProduct?: () => void;
}

/** Menu "+" do composer (padrão WhatsApp): Fotos e vídeos / Documento / Contato / Produto. */
export function AttachMenu({ disabled, onPick, onPickFiles, onPickContact, onPickProduct }: Props) {
  const t = useT();
  const mediaRef = useRef<HTMLInputElement | null>(null);
  const docRef = useRef<HTMLInputElement | null>(null);

  const handle = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    if (files.length > 0) {
      if (onPickFiles) {
        onPickFiles(files);
      } else {
        const first = files[0];
        if (first) onPick(first);
      }
    }
    e.target.value = ""; // permite re-selecionar o mesmo arquivo
  };

  return (
    <>
      <Popover>
        <PopoverTrigger asChild>
          <Button
            type="button"
            size="icon"
            variant="ghost"
            className="h-9 w-9 shrink-0"
            aria-label={t("Anexar")}
            disabled={disabled}
          >
            <Plus size={18} weight="regular" aria-hidden />
          </Button>
        </PopoverTrigger>
        <PopoverContent align="start" side="top" className="w-52 p-1">
          <button
            type="button"
            className="flex w-full items-center gap-2 rounded-md px-2 py-2 text-sm hover:bg-muted"
            onClick={() => mediaRef.current?.click()}
          >
            <ImageSquare size={18} weight="duotone" className="text-primary" aria-hidden />
            {t("Fotos e vídeos")}
          </button>
          <button
            type="button"
            className="flex w-full items-center gap-2 rounded-md px-2 py-2 text-sm hover:bg-muted"
            onClick={() => docRef.current?.click()}
          >
            <FileText size={18} weight="duotone" className="text-primary" aria-hidden />
            {t("Documento")}
          </button>
          {onPickProduct && (
            <button
              type="button"
              className="flex w-full items-center gap-2 rounded-md px-2 py-2 text-sm hover:bg-muted"
              onClick={onPickProduct}
            >
              <ShoppingBag size={18} weight="duotone" className="text-primary" aria-hidden />
              {t("Produto do catálogo")}
            </button>
          )}
          {onPickContact && (
            <button
              type="button"
              className="flex w-full items-center gap-2 rounded-md px-2 py-2 text-sm hover:bg-muted"
              onClick={onPickContact}
            >
              <UserCircle size={18} weight="duotone" className="text-primary" aria-hidden />
              {t("Contato")}
            </button>
          )}
        </PopoverContent>
      </Popover>
      {/* Os inputs vivem FORA do PopoverContent: o Radix desmonta o conteúdo do
          popover ao fechar, e um input desmontado no meio do clique perde o
          file picker ("nada acontece"). Aqui os refs seguem válidos após o
          fechamento — o .click() síncrono no onClick preserva o user-gesture. */}
      <input
        ref={mediaRef}
        type="file"
        accept="image/*,video/*"
        multiple
        className="hidden"
        onChange={handle}
      />
      <input
        ref={docRef}
        type="file"
        accept=".pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.txt,.csv,.zip"
        multiple
        className="hidden"
        onChange={handle}
      />
    </>
  );
}
