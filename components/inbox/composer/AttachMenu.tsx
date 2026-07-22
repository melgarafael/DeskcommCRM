"use client";
import { useRef } from "react";

import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
import { FileText, ImageSquare, Plus } from "@/lib/ui/icons";

interface Props {
  disabled?: boolean;
  onPick: (file: File) => void;
}

/** Menu "+" do composer (padrão WhatsApp): Fotos e vídeos / Documento. */
export function AttachMenu({ disabled, onPick }: Props) {
  const mediaRef = useRef<HTMLInputElement | null>(null);
  const docRef = useRef<HTMLInputElement | null>(null);

  const handle = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) onPick(file);
    e.target.value = ""; // permite re-selecionar o mesmo arquivo
  };

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          type="button"
          size="icon"
          variant="ghost"
          className="h-9 w-9 shrink-0"
          aria-label="Anexar"
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
          Fotos e vídeos
        </button>
        <button
          type="button"
          className="flex w-full items-center gap-2 rounded-md px-2 py-2 text-sm hover:bg-muted"
          onClick={() => docRef.current?.click()}
        >
          <FileText size={18} weight="duotone" className="text-primary" aria-hidden />
          Documento
        </button>
        <input ref={mediaRef} type="file" accept="image/*,video/*" className="hidden" onChange={handle} />
        <input
          ref={docRef}
          type="file"
          accept=".pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.txt,.csv,.zip"
          className="hidden"
          onChange={handle}
        />
      </PopoverContent>
    </Popover>
  );
}
