"use client";

import * as React from "react";

import { showApiError } from "@/components/feedback/ApiErrorToast";
import { useT } from "@/hooks/i18n/useT";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { apiClient } from "@/lib/api/client";

/**
 * Aba MERCADO — análise e penetração (§§22–24 do plano).
 *
 * Números medidos: clientes = contatos com pedido (não declarados). Barras
 * proporcionais ao maior — comparação a olho, sem gráfico pesado.
 */
interface Mercado {
  totais: {
    empresas: number;
    com_telefone: number;
    com_website: number;
    prospects: number;
    clientes_vinculados: number;
    clientes_extras_por_telefone: number;
  };
  por_cidade: { cidade: string; empresas: number; clientes: number; penetracao_pct: number; potencial: number }[];
  por_categoria: { categoria: string; empresas: number }[];
}

export function MercadoTab() {
  const t = useT();
  const [cidade, setCidade] = React.useState("");
  const [dados, setDados] = React.useState<Mercado | null>(null);

  const carregar = React.useCallback(async (c: string) => {
    try {
      const qs = c.trim() ? `?cidade=${encodeURIComponent(c.trim())}` : "";
      const corpo = await apiClient.get<{ data: Mercado | null }>(`/api/v1/prospecting/mercado${qs}`);
      setDados(corpo?.data ?? null);
    } catch (e) {
      showApiError(e);
    }
  }, []);

  React.useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void carregar("");
  }, [carregar]);

  const maxCidade = Math.max(1, ...(dados?.por_cidade.map((c) => c.empresas) ?? [1]));
  const maxCat = Math.max(1, ...(dados?.por_categoria.map((c) => c.empresas) ?? [1]));

  return (
    <div className="space-y-4">
      <div className="max-w-sm space-y-1.5">
        <Label htmlFor="m-cidade">{t("Filtrar cidade (opcional)")}</Label>
        <div className="flex gap-2">
          <Input id="m-cidade" value={cidade} onChange={(e) => setCidade(e.target.value)} placeholder="Joinville" />
          <button
            type="button"
            className="rounded-full border px-3 py-2 text-sm"
            onClick={() => void carregar(cidade)}
          >
            {t("Filtrar")}
          </button>
        </div>
      </div>

      {!dados ? (
        <p className="text-sm text-muted-foreground">{t("Carregando…")}</p>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
            <Card className="p-4">
              <p className="text-sm text-muted-foreground">{t("Empresas")}</p>
              <p className="mt-1 text-2xl font-semibold tabular-nums">{dados.totais.empresas}</p>
            </Card>
            <Card className="p-4">
              <p className="text-sm text-muted-foreground">{t("Telefones")}</p>
              <p className="mt-1 text-2xl font-semibold tabular-nums">{dados.totais.com_telefone}</p>
            </Card>
            <Card className="p-4">
              <p className="text-sm text-muted-foreground">{t("Clientes")}</p>
              <p className="mt-1 text-2xl font-semibold tabular-nums">
                {dados.totais.clientes_vinculados + dados.totais.clientes_extras_por_telefone}
              </p>
            </Card>
            <Card className="p-4">
              <p className="text-sm text-muted-foreground">{t("Prospects")}</p>
              <p className="mt-1 text-2xl font-semibold tabular-nums">{dados.totais.prospects}</p>
            </Card>
            <Card className="p-4">
              <p className="text-sm text-muted-foreground">{t("Com website")}</p>
              <p className="mt-1 text-2xl font-semibold tabular-nums">{dados.totais.com_website}</p>
            </Card>
          </div>

          <Card className="p-4">
            <h2 className="mb-3 text-base font-medium text-text">{t("Potencial por cidade")}</h2>
            {dados.por_cidade.length === 0 ? (
              <p className="text-sm text-muted-foreground">{t("Sem dados ainda — rode uma busca.")}</p>
            ) : (
              <ul className="space-y-2">
                {dados.por_cidade.slice(0, 15).map((c) => (
                  <li key={c.cidade} className="text-sm">
                    <div className="flex justify-between gap-2">
                      <span className="font-medium">{c.cidade}</span>
                      <span className="text-muted-foreground">
                        {c.clientes}/{c.empresas} · {c.penetracao_pct}% · {t("potencial")} {c.potencial}
                      </span>
                    </div>
                    <div className="mt-1 h-2 overflow-hidden rounded-full bg-muted">
                      <div className="h-full bg-primary" style={{ width: `${(c.empresas / maxCidade) * 100}%` }} />
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <Card className="p-4">
            <h2 className="mb-3 text-base font-medium text-text">{t("Por categoria")}</h2>
            <ul className="space-y-2">
              {dados.por_categoria.slice(0, 15).map((c) => (
                <li key={c.categoria} className="text-sm">
                  <div className="flex justify-between gap-2">
                    <span className="font-medium">{c.categoria}</span>
                    <span className="text-muted-foreground tabular-nums">{c.empresas}</span>
                  </div>
                  <div className="mt-1 h-2 overflow-hidden rounded-full bg-muted">
                    <div className="h-full bg-primary" style={{ width: `${(c.empresas / maxCat) * 100}%` }} />
                  </div>
                </li>
              ))}
            </ul>
          </Card>
          <p className="text-xs text-muted-foreground">
            {t("Penetração = clientes com pedido ÷ empresas descobertas. Medido, não declarado.")}
          </p>
        </>
      )}
    </div>
  );
}
