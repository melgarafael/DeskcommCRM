"use client";
import { useRef } from "react";
import { useT } from "@/hooks/i18n/useT";

import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
import {
  ClockCountdown,
  FileText,
  ImageSquare,
  Plus,
  QrCode,
  UserCircle,
} from "@/lib/ui/icons";

interface Props {
  disabled?: boolean;
  onPick: (file: File) => void;
  onPickContact?: () => void;
  /** Abre o fluxo Pix (chave ou cobrança). Só em modo reply. */
  onPickPix?: () => void;
  /** Abre o agendamento da mensagem atual. Só em modo reply. */
  onPickSchedule?: () => void;
}

/** Menu "+" do composer: mídia, documento, contato, Pix e agendar. */
export function AttachMenu({
  disabled,
  onPick,
  onPickContact,
  onPickPix,
  onPickSchedule,
}: Props) {
  const t = useT();
  const mediaRef = useRef<HTMLInputElement | null>(null);
  const docRef = useRef<HTMLInputElement | null>(null);

  const handle = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) onPick(file);
    e.target.value = "";
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
        <PopoverContent align="start" side="top" className="w-56 p-1">
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
          {onPickPix && (
            <button
              type="button"
              className="flex w-full items-center gap-2 rounded-md px-2 py-2 text-sm hover:bg-muted"
              onClick={onPickPix}
            >
              <QrCode size={18} weight="duotone" className="text-orange-500" aria-hidden />
              {t("Pix")}
            </button>
          )}
          {onPickSchedule && (
            <button
              type="button"
              className="flex w-full items-center gap-2 rounded-md px-2 py-2 text-sm hover:bg-muted"
              onClick={onPickSchedule}
            >
              <ClockCountdown size={18} weight="duotone" className="text-primary" aria-hidden />
              {t("Agendar mensagem")}
            </button>
          )}
        </PopoverContent>
      </Popover>
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
