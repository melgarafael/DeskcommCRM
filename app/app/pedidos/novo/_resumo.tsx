"use client";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { comoMoeda } from "@/lib/format/moeda";
import type { Parcela } from "@/lib/schemas/pedidos";

export interface TotaisDoResumo {
  subtotal: number;
  descontoCents: number;
  freteCents: number;
  total: number;
  qtdItens: number;
  qtdUnidades: number;
  margemPct: number | null;
  comissaoCents: number | null;
  parcelas: Parcela[];
  aprovacaoNecessaria: boolean;
}

/**
 * O RESUMO (§27–29): sempre visível no desktop, sticky bar no mobile.
 *
 * Margem e comissão só aparecem quando há dado (custo no produto +
 * papel com permissão): número ausente não vira zero — some com explicação
 * no código, não na tela do vendedor sem acesso.
 */
export function OrderSummary({
  totais,
  descontoTexto,
  aoDesconto,
  descontoPctTexto,
  aoDescontoPct,
  freteTexto,
  aoFrete,
  enviando,
  aoSalvar,
  aoFinalizar,
  textos,
}: {
  totais: TotaisDoResumo;
  descontoTexto: string;
  aoDesconto: (v: string) => void;
  descontoPctTexto: string;
  aoDescontoPct: (v: string) => void;
  freteTexto: string;
  aoFrete: (v: string) => void;
  enviando: boolean;
  aoSalvar: () => void;
  aoFinalizar: () => void;
  textos: {
    subtotal: string;
    desconto: string;
    frete: string;
    total: string;
    salvarRascunho: string;
    finalizar: string;
    margem: string;
    comissao: string;
    aguardandoAprovacao: string;
    revisar: string;
    itensUnidades: (itens: number, un: number) => string;
  };
}) {
  return (
    <>
      <Card className="space-y-3 p-4 lg:sticky lg:top-4" id="resumo">
        {totais.aprovacaoNecessaria && (
          <p role="alert" className="rounded-lg border border-warning/40 bg-warning-bg px-3 py-2 text-sm text-warning-fg">
            ⚠ {textos.aguardandoAprovacao}
          </p>
        )}
        <dl className="space-y-2 text-sm">
          <div className="flex justify-between">
            <dt className="text-muted-foreground">{textos.subtotal}</dt>
            <dd className="tabular-nums">{comoMoeda(totais.subtotal, "BRL")}</dd>
          </div>
          <div className="flex items-center justify-between gap-2">
            <dt className="text-muted-foreground">{textos.desconto} (R$)</dt>
            <dd>
              <Input
                className="w-28 text-right"
                value={descontoTexto}
                onChange={(e) => aoDesconto(e.target.value)}
                placeholder="0,00"
              />
            </dd>
          </div>
          <div className="flex items-center justify-between gap-2">
            <dt className="text-muted-foreground">{textos.desconto} (%)</dt>
            <dd>
              <Input
                className="w-28 text-right"
                type="number"
                min={0}
                max={100}
                value={descontoPctTexto}
                onChange={(e) => aoDescontoPct(e.target.value)}
                placeholder="0"
              />
            </dd>
          </div>
          <div className="flex items-center justify-between gap-2">
            <dt className="text-muted-foreground">{textos.frete} (R$)</dt>
            <dd>
              <Input
                className="w-28 text-right"
                value={freteTexto}
                onChange={(e) => aoFrete(e.target.value)}
                placeholder="0,00"
              />
            </dd>
          </div>
          {totais.margemPct !== null && (
            <div className="flex justify-between">
              <dt className="text-muted-foreground">{textos.margem}</dt>
              <dd className="tabular-nums">{totais.margemPct.toLocaleString("pt-BR")}%</dd>
            </div>
          )}
          {totais.comissaoCents !== null && (
            <div className="flex justify-between">
              <dt className="text-muted-foreground">{textos.comissao}</dt>
              <dd className="tabular-nums">{comoMoeda(totais.comissaoCents, "BRL")}</dd>
            </div>
          )}
          <div className="flex justify-between border-t pt-2 text-base font-semibold">
            <dt>{textos.total}</dt>
            <dd className="tabular-nums">{comoMoeda(totais.total, "BRL")}</dd>
          </div>
        </dl>
        {totais.parcelas.length > 0 && (
          <ul className="space-y-1 text-xs text-muted-foreground">
            {totais.parcelas.map((p) => (
              <li key={p.n} className="flex justify-between">
                <span>
                  {p.n}ª · {p.vencimento}
                </span>
                <span className="tabular-nums">{comoMoeda(p.valor_cents, "BRL")}</span>
              </li>
            ))}
          </ul>
        )}
        <div className="flex flex-col gap-2">
          <Button variant="outline" disabled={enviando} onClick={aoSalvar}>
            {textos.salvarRascunho}
          </Button>
          <Button disabled={enviando} onClick={aoFinalizar}>
            {textos.finalizar}
          </Button>
        </div>
      </Card>

      {/* Barra mobile (§41): o resumo viaja com o vendedor. */}
      <div className="fixed inset-x-0 bottom-0 z-30 border-t bg-background p-3 lg:hidden">
        <div className="flex items-center justify-between gap-3">
          <p className="text-sm text-muted-foreground">{textos.itensUnidades(totais.qtdItens, totais.qtdUnidades)}</p>
          <p className="text-lg font-semibold tabular-nums">{comoMoeda(totais.total, "BRL")}</p>
          <Button
            size="sm"
            onClick={() => document.getElementById("resumo")?.scrollIntoView({ behavior: "smooth" })}
          >
            {textos.revisar}
          </Button>
        </div>
      </div>
    </>
  );
}
