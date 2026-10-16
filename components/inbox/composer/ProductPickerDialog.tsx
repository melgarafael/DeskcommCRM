"use client";

import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiClient } from "@/lib/api/client";
import { useT } from "@/hooks/i18n/useT";
import { formatarMoeda } from "@/lib/propostas/moeda";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { MagnifyingGlass, Package, ShoppingBag } from "@/lib/ui/icons";
import { cn } from "@/lib/utils";
import type { Produto } from "@/lib/schemas/produtos";

export interface ProductPickPayload {
  codigo: string;
  nome: string;
  body?: string;
  preco_cents?: number;
  preco_de_cents?: number | null;
  video_url?: string | null;
  imagem_url?: string | null;
}

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  sending?: boolean;
  onPick: (payload: ProductPickPayload) => void;
}

export function ProductPickerDialog({ open, onOpenChange, sending, onPick }: Props) {
  const t = useT();
  const [search, setSearch] = useState("");
  const [debounced, setDebounced] = useState("");
  const [selectedProduct, setSelectedProduct] = useState<Produto | null>(null);
  const [customText, setCustomText] = useState("");

  useEffect(() => {
    if (!open) {
      setSearch("");
      setDebounced("");
      setSelectedProduct(null);
      setCustomText("");
      return;
    }
    const timer = setTimeout(() => setDebounced(search.trim()), 250);
    return () => clearTimeout(timer);
  }, [search, open]);

  const { data: produtos = [], isLoading } = useQuery<Produto[]>({
    queryKey: ["products", "picker", debounced],
    queryFn: async () => {
      const qs = new URLSearchParams();
      if (debounced) qs.set("busca", debounced);
      const res = await apiClient.get<{ data: Produto[] }>(`/api/v1/products?${qs.toString()}`);
      return res.data ?? [];
    },
    enabled: open,
  });

  const handleConfirm = () => {
    if (!selectedProduct) return;
    onPick({
      codigo: selectedProduct.codigo,
      nome: selectedProduct.nome,
      body: customText.trim() || undefined,
      preco_cents: Number(selectedProduct.preco_cents),
      preco_de_cents: selectedProduct.preco_de_cents ? Number(selectedProduct.preco_de_cents) : null,
      video_url: selectedProduct.video_url,
      imagem_url: selectedProduct.imagem_url,
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl max-h-[85vh] flex flex-col p-6">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ShoppingBag className="size-5 text-primary" weight="duotone" />
            {t("Enviar produto do catálogo")}
          </DialogTitle>
          <DialogDescription>
            {t("Selecione um produto do catálogo Meta da sua organização para enviar o card interativo ao cliente.")}
          </DialogDescription>
        </DialogHeader>

        {/* Campo de Busca */}
        <div className="relative my-2">
          <MagnifyingGlass
            className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground"
            size={16}
          />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t("Buscar por nome ou código (SKU)...")}
            className="pl-9"
            autoFocus
          />
        </div>

        {/* Lista de Produtos */}
        <div className="flex-1 overflow-y-auto min-h-[220px] max-h-[320px] divide-y border rounded-lg bg-card/50">
          {isLoading ? (
            <div className="p-8 text-center text-sm text-muted-foreground">
              {t("Carregando catálogo...")}
            </div>
          ) : produtos.length === 0 ? (
            <div className="p-8 text-center text-sm text-muted-foreground flex flex-col items-center gap-2">
              <Package size={32} weight="duotone" className="text-muted-foreground/60" />
              <span>{t("Nenhum produto ativo encontrado no catálogo.")}</span>
            </div>
          ) : (
            produtos.map((prod) => {
              const isSelected = selectedProduct?.id === prod.id;
              const preco = formatarMoeda(Number(prod.preco_cents), prod.moeda || "BRL");
              const semEstoque = prod.controla_estoque && prod.quantidade <= 0;

              return (
                <div
                  key={prod.id}
                  onClick={() => setSelectedProduct(prod)}
                  className={cn(
                    "flex items-center gap-3 p-3 cursor-pointer transition-colors hover:bg-muted/60",
                    isSelected && "bg-primary/10 border-l-4 border-l-primary"
                  )}
                >
                  {/* Foto do Produto */}
                  <div className="size-12 shrink-0 rounded-md border bg-muted flex items-center justify-center overflow-hidden">
                    {prod.imagem_url ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={prod.imagem_url}
                        alt={prod.nome}
                        className="size-full object-cover"
                      />
                    ) : (
                      <Package size={20} className="text-muted-foreground/60" />
                    )}
                  </div>

                  {/* Informações */}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center justify-between gap-2">
                      <div className="flex items-center gap-1.5 min-w-0">
                        <h4 className="text-sm font-medium truncate text-foreground">{prod.nome}</h4>
                        {prod.video_url ? (
                          <span className="shrink-0 rounded bg-sky-500/10 px-1 py-0.2 text-[9px] font-semibold text-sky-600 dark:text-sky-400">
                            Vídeo
                          </span>
                        ) : null}
                      </div>
                      <div className="shrink-0 text-right">
                        {prod.preco_de_cents && prod.preco_de_cents > prod.preco_cents ? (
                          <div className="flex flex-col items-end">
                            <span className="text-[10px] text-muted-foreground line-through">
                              {formatarMoeda(Number(prod.preco_de_cents), prod.moeda || "BRL")}
                            </span>
                            <div className="flex items-center gap-1">
                              <span className="rounded bg-emerald-500/15 px-1 text-[9px] font-bold text-emerald-600 dark:text-emerald-400">
                                -{Math.round(((prod.preco_de_cents - prod.preco_cents) / prod.preco_de_cents) * 100)}%
                              </span>
                              <span className="text-sm font-semibold text-emerald-600 dark:text-emerald-400">
                                {preco}
                              </span>
                            </div>
                          </div>
                        ) : (
                          <span className="text-sm font-semibold text-primary">{preco}</span>
                        )}
                      </div>
                    </div>
                    <div className="flex items-center gap-2 mt-1 text-xs text-muted-foreground">
                      <span className="font-mono">SKU: {prod.codigo}</span>
                      <span>•</span>
                      {prod.controla_estoque ? (
                        semEstoque ? (
                          <Badge variant="destructive" className="h-4 px-1.5 text-[10px]">
                            {t("Esgotado")}
                          </Badge>
                        ) : (
                          <span>{t("Estoque: ")}{prod.quantidade}</span>
                        )
                      ) : (
                        <span>{t("Disponível")}</span>
                      )}
                    </div>
                  </div>
                </div>
              );
            })
          )}
        </div>

        {/* Mensagem Opcional de Acompanhamento */}
        {selectedProduct && (
          <div className="mt-3 space-y-1.5">
            <Label htmlFor="custom-body" className="text-xs text-muted-foreground">
              {t("Mensagem de acompanhamento (opcional):")}
            </Label>
            <Textarea
              id="custom-body"
              value={customText}
              onChange={(e) => setCustomText(e.target.value)}
              placeholder={t("Ex.: Dá uma olhada nesse item que combinamos:")}
              rows={2}
              className="resize-none text-sm"
            />
          </div>
        )}

        <DialogFooter className="mt-4 flex items-center justify-between sm:justify-between">
          <Button
            type="button"
            variant="ghost"
            onClick={() => onOpenChange(false)}
            disabled={sending}
          >
            {t("Cancelar")}
          </Button>
          <Button
            type="button"
            onClick={handleConfirm}
            disabled={!selectedProduct || sending}
            className="gap-2"
          >
            <ShoppingBag size={16} />
            {sending ? t("Enviando...") : t("Enviar produto")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
