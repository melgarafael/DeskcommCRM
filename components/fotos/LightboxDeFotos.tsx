"use client";

import * as React from "react";

import { useT } from "@/hooks/i18n/useT";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";

export interface FotoVisivel {
  url: string;
  rotulo?: string;
}

/**
 * Lightbox de fotos — a foto grande em janela flutuante.
 *
 * Abre no índice clicado e navega entre todas (setas do teclado e
 * botões). Esc e clique fora fecham (o Dialog já cuida). Imagem com
 * `object-contain`: aparece inteira, nunca cortada.
 */
export function LightboxDeFotos({
  fotos,
  indiceInicial,
  aberto,
  onFechar,
}: {
  fotos: FotoVisivel[];
  indiceInicial: number;
  aberto: boolean;
  onFechar: () => void;
}) {
  const t = useT();

  return (
    <Dialog open={aberto} onOpenChange={(v) => !v && onFechar()}>
      <DialogContent className="max-w-3xl border-0 bg-black/90 p-2 sm:p-4">
        <DialogTitle className="sr-only">{t("Foto do produto")}</DialogTitle>
        {/* Monta do zero a cada abertura: o índice inicial vale sem efeito. */}
        {aberto && <Conteudo fotos={fotos} indiceInicial={indiceInicial} />}
      </DialogContent>
    </Dialog>
  );
}

function Conteudo({ fotos, indiceInicial }: { fotos: FotoVisivel[]; indiceInicial: number }) {
  const t = useT();
  const [indice, setIndice] = React.useState(() =>
    Math.min(Math.max(0, indiceInicial), Math.max(0, fotos.length - 1)),
  );

  const anterior = React.useCallback(() => {
    setIndice((i) => (i - 1 + fotos.length) % Math.max(1, fotos.length));
  }, [fotos.length]);
  const proxima = React.useCallback(() => {
    setIndice((i) => (i + 1) % Math.max(1, fotos.length));
  }, [fotos.length]);

  React.useEffect(() => {
    if (fotos.length < 2) return;
    function tecla(e: KeyboardEvent) {
      if (e.key === "ArrowLeft") anterior();
      if (e.key === "ArrowRight") proxima();
    }
    window.addEventListener("keydown", tecla);
    return () => window.removeEventListener("keydown", tecla);
  }, [fotos.length, anterior, proxima]);

  const atual = fotos[indice];

  if (!atual) {
    return <p className="p-8 text-center text-sm text-white">{t("Sem foto.")}</p>;
  }
  return (
    <figure className="space-y-2">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={atual.url}
        alt={atual.rotulo ?? t("Foto do produto")}
        className="mx-auto max-h-[75vh] w-auto max-w-full rounded-md object-contain"
      />
      <figcaption className="flex items-center justify-between gap-2 px-1 text-sm text-white">
        <span className="truncate">{atual.rotulo ?? ""}</span>
        {fotos.length > 1 && (
          <span className="flex shrink-0 items-center gap-2">
            <Button size="sm" variant="secondary" onClick={anterior} aria-label={t("Foto anterior")}>
              ←
            </Button>
            <span className="tabular-nums">
              {indice + 1}/{fotos.length}
            </span>
            <Button size="sm" variant="secondary" onClick={proxima} aria-label={t("Próxima foto")}>
              →
            </Button>
          </span>
        )}
      </figcaption>
    </figure>
  );
}
