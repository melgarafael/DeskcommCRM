"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

import { showApiError } from "@/components/feedback/ApiErrorToast";
import { useT } from "@/hooks/i18n/useT";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { apiClient } from "@/lib/api/client";
import { precoParaCentavos, type Produto } from "@/lib/schemas/produtos";
import type { ItemDeTabelaSalvo, TabelaDePreco } from "@/lib/schemas/precos";
import { comoMoeda } from "@/lib/format/moeda";

/**
 * As tabelas de preço da loja (atacado, varejo, cliente X).
 *
 * A tabela aberta mostra os produtos com o preço efetivo (item > desconto >
 * base); clicar no preço vira campo editável. "Salvar preços" grava a lista
 * inteira de uma vez (PUT substitui o conjunto).
 */
export function TabelasClient({
  inicial,
  produtos,
  podeEditar,
}: {
  inicial: TabelaDePreco[];
  produtos: Produto[];
  podeEditar: boolean;
}) {
  const t = useT();
  const router = useRouter();
  const [aberta, setAberta] = React.useState<string | null>(inicial.find((x) => x.padrao)?.id ?? inicial[0]?.id ?? null);
  const [nome, setNome] = React.useState("");
  const [desconto, setDesconto] = React.useState("");
  const [criando, setCriando] = React.useState(false);
  const [precos, setPrecos] = React.useState<Record<string, string>>({});
  const [carregandoItens, setCarregandoItens] = React.useState(false);
  const [salvando, setSalvando] = React.useState(false);

  const tabela = inicial.find((x) => x.id === aberta) ?? null;

  async function abrir(id: string) {
    setAberta(id);
    setCarregandoItens(true);
    try {
      const corpo = await apiClient.get<{ data: { itens: ItemDeTabelaSalvo[] } }>(`/api/v1/price-tables/${id}`);
      const mapa: Record<string, string> = {};
      for (const item of corpo?.data?.itens ?? []) {
        if (item.preco_cents !== null) {
          mapa[item.product_id] = (item.preco_cents / 100).toLocaleString("pt-BR", {
            minimumFractionDigits: 2,
          });
        }
      }
      setPrecos(mapa);
    } catch (e) {
      showApiError(e);
    } finally {
      setCarregandoItens(false);
    }
  }

  // Carga inicial dos preços: sincronização com o servidor (fetch), não
  // estado derivado.
  React.useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (aberta) void abrir(aberta);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function criar() {
    if (nome.trim().length < 2) {
      toast.error(t("O nome precisa de ao menos 2 letras"));
      return;
    }
    setCriando(true);
    try {
      const nova = await apiClient.post<TabelaDePreco>("/api/v1/price-tables", {
        nome: nome.trim(),
        desconto_pct: Number(desconto) || 0,
      });
      toast.success(t("Tabela criada"));
      setNome("");
      setDesconto("");
      router.refresh();
      setAberta(nova.id);
    } catch (e) {
      showApiError(e);
    } finally {
      setCriando(false);
    }
  }

  async function salvarPrecos() {
    if (!tabela) return;
    const itens = [];
    for (const [productId, texto] of Object.entries(precos)) {
      if (texto.trim() === "") continue;
      const cents = precoParaCentavos(texto);
      if (cents === null) {
        toast.error(t("Preço inválido em um dos produtos. Escreva assim: 5.499,00"));
        return;
      }
      itens.push({ product_id: productId, preco_cents: cents });
    }
    setSalvando(true);
    try {
      await apiClient.put(`/api/v1/price-tables/${tabela.id}/items`, { itens });
      toast.success(t("Preços salvos"));
      router.refresh();
    } catch (e) {
      showApiError(e);
    } finally {
      setSalvando(false);
    }
  }

  function efetivo(p: Produto): number {
    const texto = precos[p.id];
    if (texto !== undefined && texto.trim() !== "") {
      return precoParaCentavos(texto) ?? p.preco_cents;
    }
    const d = tabela?.desconto_pct ?? 0;
    return Math.round(p.preco_cents * (1 - Number(d) / 100));
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-2">
        {inicial.map((x) => (
          <Button
            key={x.id}
            variant={x.id === aberta ? "default" : "outline"}
            size="sm"
            onClick={() => void abrir(x.id)}
          >
            {x.nome}
            {x.padrao ? " ★" : ""}
          </Button>
        ))}
      </div>

      {podeEditar && (
        <div className="flex flex-wrap items-end gap-2">
          <div className="space-y-1.5">
            <Label htmlFor="nova-tabela">{t("Nova tabela")}</Label>
            <Input
              id="nova-tabela"
              value={nome}
              onChange={(e) => setNome(e.target.value)}
              placeholder={t("Ex.: Atacado")}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="desconto-tabela">{t("Desconto %")}</Label>
            <Input
              id="desconto-tabela"
              type="number"
              min={0}
              max={100}
              className="w-28"
              value={desconto}
              onChange={(e) => setDesconto(e.target.value)}
              placeholder="0"
            />
          </div>
          <Button onClick={criar} disabled={criando}>
            {t(criando ? "Salvando…" : "Criar tabela")}
          </Button>
        </div>
      )}

      {!tabela ? (
        <p className="rounded-2xl border bg-muted/40 px-4 py-8 text-center text-sm text-muted-foreground">
          {t("Nenhuma tabela ainda — crie a primeira acima.")}
        </p>
      ) : carregandoItens ? (
        <p className="text-sm text-muted-foreground">{t("Carregando…")}</p>
      ) : (
        <div className="space-y-2">
          <p className="text-sm text-muted-foreground">
            {t("Clique no preço para sobrescrever. Vazio = vale o desconto da tabela.")}
          </p>
          <ul className="divide-y rounded-lg border">
            {produtos.map((p) => (
              <li key={p.id} className="flex items-center gap-4 p-3">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{p.nome}</p>
                  <p className="text-xs text-muted-foreground">
                    {t("Base")}: {comoMoeda(p.preco_cents, p.moeda)}
                  </p>
                </div>
                {podeEditar ? (
                  <Input
                    className="w-28 text-right"
                    value={precos[p.id] ?? ""}
                    onChange={(e) => setPrecos((m) => ({ ...m, [p.id]: e.target.value }))}
                    placeholder={(efetivo(p) / 100).toLocaleString("pt-BR", {
                      minimumFractionDigits: 2,
                    })}
                  />
                ) : (
                  <span className="text-sm font-medium">{comoMoeda(efetivo(p), p.moeda)}</span>
                )}
              </li>
            ))}
          </ul>
          {podeEditar && (
            <Button onClick={salvarPrecos} disabled={salvando}>
              {t(salvando ? "Salvando…" : "Salvar preços")}
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
