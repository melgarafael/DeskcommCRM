"use client";

import * as React from "react";

import { useT } from "@/hooks/i18n/useT";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { Produto } from "@/lib/schemas/produtos";
import { precoEfetivo } from "@/lib/schemas/precos";
import { comoMoeda } from "@/lib/format/moeda";

export interface PrecoDeTabela {
  desconto_pct: number;
  overrides: Map<string, number | null>;
}

export interface UltimoPreco {
  preco_cents: number;
  em: string;
}

/**
 * Busca de produto (§7–9): nome/SKU/código/EAN, parcial, com debounce.
 *
 * - EAN/SKU exato (código igual ao digitado) pula para o topo: bip de
 *   scanner vira Enter sem olhar a tela;
 * - Enter adiciona o destacado (qtd 1); ↑↓ navegam; Esc limpa;
 * - mostra preço efetivo da tabela aplicada + estoque + último preço do
 *   cliente (§19) quando houver histórico.
 */
export function ProductSearch({
  produtos,
  tabela,
  ultimosPrecos,
  inputRef,
  aoAdicionar,
  textos,
}: {
  produtos: Produto[];
  tabela: PrecoDeTabela | null;
  ultimosPrecos: Map<string, UltimoPreco>;
  inputRef: React.RefObject<HTMLInputElement | null>;
  aoAdicionar: (produto: Produto, quantidade: number) => void;
  textos: { produtos: string; buscarProduto: string };
}) {
  const t = useT();
  const [busca, setBusca] = React.useState("");
  const [debounced, setDebounced] = React.useState("");
  const [destaque, setDestaque] = React.useState(0);

  React.useEffect(() => {
    const timer = setTimeout(() => {
      setDebounced(busca);
      setDestaque(0);
    }, 150);
    return () => clearTimeout(timer);
  }, [busca]);

  const filtrados = React.useMemo(() => {
    const b = debounced.trim().toLowerCase();
    if (!b) return [];
    const exato = produtos.filter((p) => p.codigo.toLowerCase() === b);
    const resto = produtos.filter(
      (p) =>
        p.codigo.toLowerCase() !== b &&
        (p.nome.toLowerCase().includes(b) ||
          p.codigo.toLowerCase().includes(b) ||
          (p.marca ?? "").toLowerCase().includes(b)),
    );
    return [...exato, ...resto].slice(0, 8);
  }, [debounced, produtos]);

  function efetivo(p: Produto): { valor: number; origem: string } {
    if (!tabela) return { valor: p.preco_cents, origem: t("Base") };
    const v = precoEfetivo(p.preco_cents, tabela.desconto_pct, tabela.overrides.get(p.id) ?? null);
    if (v !== p.preco_cents) return { valor: v, origem: t("Tabela") };
    return { valor: v, origem: t("Base") };
  }

  function aoTeclar(e: React.KeyboardEvent) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setDestaque((d) => Math.min(d + 1, filtrados.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setDestaque((d) => Math.max(d - 1, 0));
    } else if (e.key === "Enter") {
      const alvo = filtrados[destaque];
      if (alvo) {
        e.preventDefault();
        aoAdicionar(alvo, 1);
        setBusca("");
      }
    } else if (e.key === "Escape") {
      setBusca("");
      (e.target as HTMLInputElement).blur();
    }
  }

  return (
    <div className="space-y-1.5">
      <Label htmlFor="busca-produto">{textos.produtos}</Label>
      <Input
        id="busca-produto"
        ref={inputRef}
        value={busca}
        onChange={(e) => setBusca(e.target.value)}
        onKeyDown={aoTeclar}
        placeholder={textos.buscarProduto}
        autoComplete="off"
      />
      {filtrados.length > 0 && (
        <ul className="rounded-lg border bg-background shadow-sm">
          {filtrados.map((p, i) => {
            const ef = efetivo(p);
            const ultimo = ultimosPrecos.get(p.id);
            return (
              <li key={p.id}>
                <button
                  type="button"
                  className={`flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-sm ${
                    i === destaque ? "bg-muted" : "hover:bg-muted/50"
                  }`}
                  onMouseEnter={() => setDestaque(i)}
                  onClick={() => {
                    aoAdicionar(p, 1);
                    setBusca("");
                  }}
                >
                  <span className="min-w-0">
                    <span className="block truncate font-medium">{p.nome}</span>
                    <span className="block text-xs text-muted-foreground">
                      {p.codigo}
                      {p.controla_estoque ? ` · ${t("estoque")}: ${p.quantidade}` : ""}
                      {` · ${ef.origem}`}
                    </span>
                    {ultimo && (
                      <span className="block text-xs text-muted-foreground">
                        {t("Último")}: {comoMoeda(ultimo.preco_cents, p.moeda)}
                        {ultimo.preco_cents !== ef.valor && (
                          <> ({ef.valor > ultimo.preco_cents ? "↑" : "↓"})</>
                        )}
                      </span>
                    )}
                  </span>
                  <span className="shrink-0 text-xs font-medium">{comoMoeda(ef.valor, p.moeda)}</span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
