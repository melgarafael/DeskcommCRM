"use client";

import { useT } from "@/hooks/i18n/useT";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NexusQuantityStepper } from "@/components/nexus-ui/forms/NexusQuantityStepper";

export interface LinhaDoPedido {
  key: string;
  product_id: string;
  codigo: string;
  nome: string;
  quantidade: number;
  /** Fração permitida quando o produto vende a granel (v1: inteiro). */
  permite_fracao: boolean;
  precoTexto: string;
  descontoPct: number;
  estoque: number | null;
}

/**
 * A lista de itens (§10–11): edição inline, steppers −/+, preço e desconto
 * por linha, subtotal vivo. Linha é compacta de propósito: vendedor com 50
 * itens não rola maratona.
 */
export function OrderItems({
  linhas,
  aoMudar,
  aoRemover,
}: {
  linhas: LinhaDoPedido[];
  aoMudar: (key: string, patch: Partial<LinhaDoPedido>) => void;
  aoRemover: (key: string) => void;
}) {
  const t = useT();
  if (linhas.length === 0) {
    return (
      <p className="rounded-2xl border bg-muted/40 px-4 py-8 text-center text-sm text-muted-foreground">
        {t("Nenhum item ainda — busque e adicione.")}
      </p>
    );
  }
  return (
    <ul className="space-y-2">
      {linhas.map((l) => (
        <li key={l.key} className="rounded-2xl border p-3">
          <div className="flex items-center justify-between gap-2">
            <p className="min-w-0 flex-1 truncate text-sm font-medium">{l.nome}</p>
            <button
              type="button"
              className="text-xs text-destructive underline"
              onClick={() => aoRemover(l.key)}
              aria-label={t("Remover item")}
            >
              {t("remover")}
            </button>
          </div>
          <div className="mt-2 grid grid-cols-4 items-end gap-2">
            <div>
              <Label>{t("Qtd")}</Label>
              <NexusQuantityStepper
                value={l.quantidade}
                onChange={(qtd) => aoMudar(l.key, { quantidade: qtd })}
                label={t("Quantidade")}
              />
              {l.estoque !== null && (
                <p
                  className={`mt-1 text-xs ${l.estoque < l.quantidade ? "text-orange-600" : "text-muted-foreground"}`}
                >
                  {t("estoque")}: {l.estoque}
                  {l.estoque < l.quantidade && ` ⚠`}
                </p>
              )}
            </div>
            <div>
              <Label>{t("Preço")}</Label>
              <Input
                className="h-9"
                value={l.precoTexto}
                onChange={(e) => aoMudar(l.key, { precoTexto: e.target.value })}
              />
            </div>
            <div>
              <Label>{t("Desc. %")}</Label>
              <Input
                type="number"
                min={0}
                max={100}
                className="h-9"
                value={l.descontoPct}
                onChange={(e) =>
                  aoMudar(l.key, {
                    descontoPct: Math.min(100, Math.max(0, Number(e.target.value) || 0)),
                  })
                }
              />
            </div>
          </div>
        </li>
      ))}
    </ul>
  );
}
