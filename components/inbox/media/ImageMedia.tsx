"use client";
import { useState } from "react";
import { useT } from "@/hooks/i18n/useT";

import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

import { MediaUnavailable } from "./MediaUnavailable";
import { mediaSrc } from "./media-utils";

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
 * O lightbox abre a imagem AJUSTADA ao espaço (`object-contain`, 85vh) e o
 * primeiro clique na imagem ampliada não serve para nada além de ampliar — é
 * o que resolve o caso da #4149: foto de cupom, print de comprovante, contrato
 * fotografado. Sem zoom, texto pequeno fica ilegível e a única saída é baixar
 * o arquivo.
 *
 * O clique alterna DOIS estados, e não um `scale` de CSS: ajustada (`w-full`,
 * cabe inteira) e ampliada (`w-[200%]`, rolagem no quadro). `scale` não muda o
 * layout, então a imagem ampliada passaria por cima da tela sem barra de
 * rolagem e sem como chegar no canto que interessa. Quem carrega o estado é o
 * `data-ampliada` no botão e na imagem — classe e rótulo mudam junto.
 */
export function ImageMedia({ messageId, alt, src: fonte }: Props) {
  const t = useT();
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [open, setOpen] = useState(false);
  // O zoom vive por abertura do lightbox: fechar e reabrir a mesma imagem começa
  // ajustado, senão a próxima abertura de um print pequeno já entra no canto
  // ampliado e o operador não sabe por quê.
  const [ampliada, setAmpliada] = useState(false);
  const src = fonte ?? mediaSrc(messageId);

  if (state === "error")
    return (
      <div className="w-64 max-w-full aspect-[4/3]">
        <MediaUnavailable kind="Imagem" className="h-full w-full" />
      </div>
    );

  return (
    <>
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
      <Dialog
        open={open}
        onOpenChange={(aberto) => {
          setOpen(aberto);
          if (!aberto) setAmpliada(false);
        }}
      >
        {/* `overflow-hidden` no diálogo: a rolagem da imagem ampliada é do quadro
            interno, e sem isto o `overflow-y-auto` do DialogContent deixaria o
            documento do modal rolar junto (a barra de fora e a de dentro
            disputando o mesmo gesto). */}
        <DialogContent className="max-w-4xl overflow-hidden border-none bg-transparent p-0 shadow-none">
          <DialogTitle className="sr-only">{alt}</DialogTitle>
          {/* Alvo do clique de ampliar. É um `button` de verdade — não uma div
              com onClick — para que Enter e Espaço façam o mesmo que o clique e
              o leitor de tela anuncie o rótulo. O `alt` continua na imagem: o
              botão tem rótulo de AÇÃO, a imagem tem descrição de CONTEÚDO. */}
          <div className="max-h-[85vh] w-full overflow-auto rounded-lg">
            <button
              type="button"
              data-testid="lightbox-zoom"
              data-ampliada={ampliada ? "true" : "false"}
              aria-label={ampliada ? t("Reduzir imagem") : t("Ampliar imagem")}
              onClick={() => setAmpliada((v) => !v)}
              className={cn(
                "block w-full rounded-lg focus-visible:outline-2 focus-visible:outline-ring",
                ampliada ? "cursor-zoom-out" : "cursor-zoom-in",
              )}
            >
              <img
                src={src}
                alt={alt}
                data-testid="lightbox-imagem"
                data-ampliada={ampliada ? "true" : "false"}
                className={cn(
                  "rounded-lg object-contain",
                  // Ajustada: cabe na largura do modal e em 85vh. Ampliada: o
                  // dobro da largura do quadro, altura livre — a imagem cresce
                  // e o `overflow-auto` do quadro leva até os cantos.
                  ampliada ? "max-h-none w-[200%] max-w-none" : "max-h-[85vh] w-full",
                )}
              />
            </button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
