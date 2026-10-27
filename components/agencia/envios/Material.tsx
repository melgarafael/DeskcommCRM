"use client";

import { useState } from "react";

/**
 * O material de um envio, DENTRO do sistema (SPEC-envios, E4): o vídeo toca no
 * player, a arte abre grande, o PDF embutido, o texto formatado. Serve à
 * agência (Envios) e ao cliente (/app/aprovacoes) — os textos passam por `t`.
 */
export interface MaterialDoEnvio {
  texto: string | null;
  url: string | null;
  mime: string | null;
  link: string | null;
  apagado: boolean;
}

export function Material({ m, titulo, t = (x) => x }: { m: MaterialDoEnvio; titulo: string; t?: (x: string) => string }) {
  const [grande, setGrande] = useState(false);
  const video = m.mime?.startsWith("video/");
  const imagem = m.mime?.startsWith("image/");
  return (
    <div className="space-y-2" data-testid="material-do-envio">
      {m.url && video && (
        <video
          controls
          preload="metadata"
          playsInline
          src={m.url}
          className="max-h-[70vh] w-full rounded-md bg-black"
          data-testid="video-do-envio"
          aria-label={titulo}
        />
      )}
      {m.url && imagem && (
        <button type="button" onClick={() => setGrande(!grande)} className="block w-full" aria-label={grande ? t("Diminuir a arte") : t("Ver a arte em tamanho grande")}>
          {/* eslint-disable-next-line @next/next/no-img-element -- URL assinada e temporária do Storage: o otimizador de imagem do Next não alcança */}
          <img src={m.url} alt={titulo} className={grande ? "w-full rounded-md" : "max-h-96 w-auto rounded-md object-contain"} data-testid="arte-do-envio" />
        </button>
      )}
      {m.url && m.mime === "application/pdf" && <iframe src={m.url} title={titulo} className="h-[70vh] w-full rounded-md border" />}
      {m.texto && (
        <div className="whitespace-pre-wrap rounded-md border bg-muted/30 p-3 text-sm leading-relaxed" data-testid="texto-do-envio">
          {m.texto}
        </div>
      )}
      {!m.url && m.apagado && (
        <p className="text-xs text-muted-foreground">{t("O arquivo aprovado foi guardado no Google Drive da agência.")}</p>
      )}
      {m.link && (
        <a href={m.link} target="_blank" rel="noreferrer" className="inline-block text-sm underline underline-offset-4">
          {t("Abrir o material")}
        </a>
      )}
    </div>
  );
}
