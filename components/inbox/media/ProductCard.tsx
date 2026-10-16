"use client";

import { useT } from "@/hooks/i18n/useT";
import { formatarMoeda } from "@/lib/propostas/moeda";
import { Package, ShoppingBag } from "@/lib/ui/icons";
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
          {preco ? (
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
      </div>
    </div>
  );
}
