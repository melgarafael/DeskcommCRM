"use client";

import * as React from "react";
import Link from "next/link";

import { showApiError } from "@/components/feedback/ApiErrorToast";
import { useT } from "@/hooks/i18n/useT";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { apiClient } from "@/lib/api/client";
import {
  linkWhatsAppRecuperacao,
  ROTULO_DA_FAIXA,
  type ClienteInativo,
  type FaixaDeInatividade,
} from "@/lib/comercial/inatividade";
import { comoMoeda } from "@/lib/format/moeda";

interface Textos {
  titulo: string;
  subtitulo: string;
  periodo: string;
  aplicar: string;
  vazio: string;
  semBase: string;
  chamar: string;
  ficha: string;
  novoPedido: string;
  ultimaCompra: string;
  dias: string;
  totalHistorico: string;
  pedidos: string;
}

const COR_DA_FAIXA: Record<FaixaDeInatividade, string> = {
  atencao: "bg-yellow-100 text-yellow-800",
  morno: "bg-orange-100 text-orange-800",
  frio: "bg-red-100 text-red-800",
};

export function RecuperacaoClient({ temBase, textos }: { temBase: boolean; textos: Textos }) {
  const t = useT();
  const [dias, setDias] = React.useState("60");
  const [lista, setLista] = React.useState<ClienteInativo[] | null>(null);

  const buscar = React.useCallback(async (d: string) => {
    try {
      const corpo = await apiClient.get<{ data: ClienteInativo[] }>(`/api/v1/comercial/inativos?dias=${d || "60"}`);
      setLista(Array.isArray(corpo?.data) ? corpo.data : []);
    } catch (e) {
      showApiError(e);
    }
  }, []);

  React.useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void buscar("60");
  }, [buscar]);

  if (!temBase) {
    return (
      <div className="space-y-6 p-6">
        <h1 className="text-2xl font-medium tracking-tight text-text">{textos.titulo}</h1>
        <Card className="p-8 text-center text-sm text-muted-foreground">{textos.semBase}</Card>
      </div>
    );
  }

  return (
    <div className="space-y-6 p-6">
      <div>
        <h1 className="text-2xl font-medium tracking-tight text-text">{textos.titulo}</h1>
        <p className="text-sm text-muted-foreground">{textos.subtitulo}</p>
      </div>

      <div className="flex items-end gap-2">
        <div className="space-y-1.5">
          <Label htmlFor="dias">{textos.periodo}</Label>
          <Input
            id="dias"
            type="number"
            min={1}
            className="w-28"
            value={dias}
            onChange={(e) => setDias(e.target.value)}
          />
        </div>
        <Button onClick={() => void buscar(dias)}>{textos.aplicar}</Button>
      </div>

      {lista === null ? (
        <p className="text-sm text-muted-foreground">{t("Carregando…")}</p>
      ) : lista.length === 0 ? (
        <Card className="p-8 text-center text-sm text-muted-foreground">{textos.vazio}</Card>
      ) : (
        <ul className="space-y-2">
          {lista.map((c) => {
            const zap = linkWhatsAppRecuperacao(c.telefone, c.nome, c.dias_sem_compra);
            return (
              <li key={c.contact_id} className="rounded-lg border p-3">
                <div className="flex flex-wrap items-center gap-3 text-sm">
                  <span className="text-lg font-bold tabular-nums">{c.score}</span>
                  <div className="min-w-0 flex-1">
                    <p className="font-medium">{c.nome}</p>
                    <p className="text-xs text-muted-foreground">
                      {textos.ultimaCompra} {c.dias_sem_compra} {textos.dias} ·{" "}
                      {comoMoeda(c.total_historico_cents, "BRL")} {textos.totalHistorico} ·{" "}
                      {c.qtd_pedidos} {textos.pedidos}
                    </p>
                  </div>
                  <span
                    className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${COR_DA_FAIXA[c.faixa]}`}
                  >
                    {ROTULO_DA_FAIXA[c.faixa]}
                  </span>
                </div>
                <div className="mt-2 flex flex-wrap gap-2">
                  {zap && (
                    <Button size="sm" asChild>
                      <a href={zap} target="_blank" rel="noopener noreferrer">
                        {textos.chamar}
                      </a>
                    </Button>
                  )}
                  <Button size="sm" variant="outline" asChild>
                    <Link href={`/app/contacts/${c.contact_id}`}>{textos.ficha}</Link>
                  </Button>
                  <Button size="sm" variant="outline" asChild>
                    <Link href="/app/pedidos/novo">{textos.novoPedido}</Link>
                  </Button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
