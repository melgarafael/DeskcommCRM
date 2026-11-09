"use client";
import { useState } from "react";
import { useT } from "@/hooks/i18n/useT";

import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

import { MediaUnavailable } from "./MediaUnavailable";
import { DownloadSimple } from "@/lib/ui/icons";

import { mediaDownloadSrc, mediaSrc } from "./media-utils";

interface Props {
  messageId: string;
  alt: string;
  /**
   * Fonte alternativa: a mídia da NOTA interna (#1863, F3) é servida pela rota
   * da nota, não pela de mensagem — `messageId` não existe lá. Quando ausente,
   * o caminho é o de sempre (`/api/v1/messages/{id}/media`).
   */
  src?: string;
}

/**
 * Miniatura na bolha + lightbox (Dialog) no clique. Padrão WhatsApp Web.
 *
 * "Baixar" aparece nos dois lugares (miniatura e foto ampliada): até 09/11/2026
 * a foto não tinha download em ponto nenhum do CRM, só o documento. O link é o
 * `?baixar=1` da rota, que dá nome ao arquivo mesmo quando o canal não mandou
 * (`nomeParaBaixar`). A mídia da NOTA interna (`src`) é servida por outra rota,
 * sem esse parâmetro — ali o botão não aparece.
 */
export function ImageMedia({ messageId, alt, src: fonte }: Props) {
  const t = useT();
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [open, setOpen] = useState(false);
  const src = fonte ?? mediaSrc(messageId);
  const baixar = fonte ? null : mediaDownloadSrc(messageId);

  if (state === "error")
    return (
      <div className="w-64 max-w-full aspect-[4/3]">
        <MediaUnavailable kind="Imagem" className="h-full w-full" />
      </div>
    );

  return (
    <>
      <div className="relative w-64 max-w-full">
      <button
        type="button"
        aria-label={t("Ampliar imagem")}
        onClick={() => setOpen(true)}
        disabled={state !== "ready"}
        aria-disabled={state !== "ready"}
        className={cn(
          "relative block w-64 max-w-full aspect-[4/3] overflow-hidden rounded-lg focus-visible:outline-2 focus-visible:outline-ring",
          state === "ready" ? "cursor-zoom-in" : "cursor-not-allowed opacity-50",
        )}
      >
        {state === "loading" && <Skeleton className="absolute inset-0 h-full w-full" />}
        <img src={src} alt={alt} loading="lazy" onLoad={() => setState("ready")} onError={() => setState("error")} className="h-full w-full object-cover" />
      </button>
      {baixar && state === "ready" && (
        <a
          href={baixar}
          download
          aria-label={t("Baixar imagem")}
          title={t("Baixar imagem")}
          className="absolute bottom-1.5 right-1.5 flex items-center justify-center rounded-full bg-black/55 p-1.5 text-white transition-opacity hover:bg-black/75 focus-visible:outline-2 focus-visible:outline-ring pointer-coarse:min-h-11 pointer-coarse:min-w-11"
        >
          <DownloadSimple size={16} aria-hidden />
        </a>
      )}
      </div>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-4xl border-none bg-transparent p-0 shadow-none">
          <DialogTitle className="sr-only">{alt}</DialogTitle>
          <img src={src} alt={alt} className="max-h-[80vh] w-full rounded-lg object-contain" />
          {baixar && (
            <a
              href={baixar}
              download
              className="mx-auto mt-2 flex w-fit items-center gap-2 rounded-md bg-background px-4 py-2 text-sm font-medium text-foreground shadow-sm hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring"
            >
              <DownloadSimple size={16} aria-hidden />
              {t("Baixar")}
            </a>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
