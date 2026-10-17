"use client";

import { useState } from "react";

import { useT } from "@/hooks/i18n/useT";
import { ArrowSquareOut, Megaphone } from "@/lib/ui/icons";
import { cn } from "@/lib/utils";

export interface AnuncioParaMostrar {
  titulo: string | null;
  texto: string | null;
  url?: string | null;
  miniatura?: string | null;
}

/**
 * O anúncio que trouxe a pessoa — o mesmo cartão na bolha e no painel ao lado.
 *
 * Os dois endereços chegam já filtrados para `https:` (`urlSegura`, em
 * `lib/leads/atribuicao-de-anuncio.ts`); este componente não lê payload de
 * anúncio, só o resumo validado.
 *
 * A miniatura é da Meta e EXPIRA (o endereço é assinado e vence em dias). Quando
 * ela não carrega, o cartão segue com o ícone no lugar: título, texto e link
 * continuam dizendo de qual anúncio a pessoa veio.
 */
export function AnuncioCard({
  anuncio,
  compacto = false,
  className,
}: {
  anuncio: AnuncioParaMostrar;
  /** Na bolha: texto em duas linhas e miniatura menor. */
  compacto?: boolean;
  className?: string;
}) {
  const t = useT();
  const [semImagem, setSemImagem] = useState(false);
  const miniatura = !semImagem ? anuncio.miniatura : null;

  return (
    <div
      data-testid="anuncio-card"
      className={cn("flex gap-2 rounded-md border border-current/15 bg-current/5 p-2 text-xs", className)}
    >
      {miniatura ? (
        // eslint-disable-next-line @next/next/no-img-element -- imagem externa e efêmera da Meta; o otimizador do Next não ajuda e exigiria liberar o domínio
        <img
          src={miniatura}
          alt=""
          loading="lazy"
          referrerPolicy="no-referrer"
          onError={() => setSemImagem(true)}
          className={cn("shrink-0 rounded-sm object-cover", compacto ? "h-10 w-10" : "h-14 w-14")}
        />
      ) : (
        <span
          aria-hidden
          className={cn(
            "flex shrink-0 items-center justify-center rounded-sm bg-current/10",
            compacto ? "h-10 w-10" : "h-14 w-14",
          )}
        >
          <Megaphone size={compacto ? 16 : 20} weight="duotone" />
        </span>
      )}
      <div className="min-w-0 flex-1 space-y-0.5">
        <div className="text-[10px] font-medium uppercase tracking-wide opacity-70">
          {t("Anúncio da Meta")}
        </div>
        {anuncio.titulo && <div className="truncate font-semibold">{anuncio.titulo}</div>}
        {anuncio.texto && (
          <p className={cn("wrap-anywhere whitespace-pre-line opacity-80", compacto ? "line-clamp-2" : "line-clamp-4")}>
            {anuncio.texto}
          </p>
        )}
        {anuncio.url && (
          <a
            href={anuncio.url}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 font-medium underline underline-offset-2"
          >
            {t("Ver anúncio")}
            <ArrowSquareOut size={11} aria-hidden />
          </a>
        )}
      </div>
    </div>
  );
}
