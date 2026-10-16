"use client";

import { useT } from "@/hooks/i18n/useT";
import { formatarMoeda } from "@/lib/propostas/moeda";
import { Package, ShoppingBag, VideoCamera } from "@/lib/ui/icons";
import { cn } from "@/lib/utils";
import type { Message } from "@/lib/types/messaging";

interface Props {
  message: Message;
}

/** Card de produto do catálogo interativo do WhatsApp na bolha de mensagem. */
export function ProductCard({ message }: Props) {
  const t = useT();
  const meta = (message.metadata ?? {}) as Record<string, unknown>;

  const nome = (meta.product_name as string) || (message.body ?? t("Produto"));
  const sku = (meta.product_retailer_id as string) || (meta.retailer_id as string) || "";
  const precoCents = typeof meta.product_price_cents === "number" ? meta.product_price_cents : null;
  const preco = precoCents !== null ? formatarMoeda(precoCents, "BRL") : null;
  const precoDeCents = typeof meta.product_price_de_cents === "number" ? meta.product_price_de_cents : null;
  const precoDe = precoDeCents !== null ? formatarMoeda(precoDeCents, "BRL") : null;
  const videoUrl = (meta.product_video_url as string) || null;
  const imagemUrl = (meta.product_image_url as string) || null;

  const isOutbound = message.direction === "outbound";

  return (
    <div
      className={cn(
        "rounded-lg overflow-hidden border my-1 transition-all max-w-[280px]",
        isOutbound
          ? "border-primary-foreground/20 bg-background/15 text-primary-foreground"
          : "border-border bg-card text-card-foreground shadow-sm"
      )}
    >
      {/* Imagem do Produto */}
      {imagemUrl ? (
        <div className="w-full h-36 bg-muted overflow-hidden relative">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={imagemUrl}
            alt={nome}
            className="w-full h-full object-cover"
          />
          <div className="absolute top-2 right-2 bg-black/60 backdrop-blur-md rounded-full px-2 py-0.5 text-[10px] text-white flex items-center gap-1 font-medium">
            <ShoppingBag size={12} />
            <span>{t("Catálogo")}</span>
          </div>
        </div>
      ) : (
        <div className="w-full h-24 bg-muted/30 flex items-center justify-center gap-2 text-xs text-muted-foreground">
          <Package size={24} className="opacity-60" />
          <span>{t("Produto do catálogo")}</span>
        </div>
      )}

      {/* Detalhes do Produto */}
      <div className="p-3 space-y-1.5">
        <h4 className="font-semibold text-sm leading-tight line-clamp-2">
          {nome}
        </h4>

        <div className="flex items-center justify-between gap-2 pt-0.5">
          {precoDeCents && precoCents && precoDeCents > precoCents ? (
            <div className="flex flex-col items-start">
              <span className="text-[10px] opacity-75 line-through tabular-nums">
                {t("De")} {precoDe}
              </span>
              <div className="flex items-center gap-1.5">
                <span className="rounded bg-emerald-500/20 px-1 py-0.2 text-[9px] font-bold text-emerald-400">
                  -{Math.round(((precoDeCents - precoCents) / precoDeCents) * 100)}%
                </span>
                <span className="font-bold text-sm tracking-tight tabular-nums">
                  {preco}
                </span>
              </div>
            </div>
          ) : preco ? (
            <span className="font-bold text-sm tracking-tight">
              {preco}
            </span>
          ) : (
            <span className="text-xs opacity-75">{t("Preço sob consulta")}</span>
          )}

          {sku && (
            <span className="text-[11px] font-mono opacity-80 bg-current/10 px-1.5 py-0.5 rounded">
              {sku}
            </span>
          )}
        </div>

        {videoUrl && (
          <a
            href={videoUrl}
            target="_blank"
            rel="noreferrer"
            className="mt-2 flex items-center justify-center gap-1.5 rounded-md border border-current/20 bg-current/5 py-1 text-xs font-medium transition hover:bg-current/10"
          >
            <VideoCamera size={14} />
            <span>{t("Ver vídeo demonstrativo")}</span>
          </a>
        )}
      </div>
    </div>
  );
}
