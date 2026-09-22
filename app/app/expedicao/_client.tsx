"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

import { showApiError } from "@/components/feedback/ApiErrorToast";
import { nexusToast } from "@/components/nexus-ui/feedback/nexus-toast";
import { NexusEmptyState } from "@/components/nexus-ui/feedback/NexusEmptyState";
import { NexusPageHeader } from "@/components/nexus-ui/layout/NexusPageHeader";
import { Truck } from "@/lib/ui/icons";
import { useT } from "@/hooks/i18n/useT";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { apiClient } from "@/lib/api/client";
import {
  numeroDaCarga,
  ROTULO_DA_CARGA,
  type Carga,
  type StatusDaCarga,
} from "@/lib/schemas/expedicao";
import { type PedidoComercial } from "@/lib/schemas/pedidos";
import { comoMoeda, numeroDoPedido } from "@/lib/format/moeda";

interface Textos {
  titulo: string;
  subtitulo: string;
  nova: string;
  cargas: string;
  vazias: string;
  embarcaveis: string;
  nenhumEmbarcavel: string;
  placa: string;
  veiculo: string;
  motorista: string;
  criar: string;
  verRomaneio: string;
}

const VARIANTE_CARGA: Record<
  StatusDaCarga,
  NonNullable<React.ComponentProps<typeof Badge>["variant"]>
> = {
  montando: "warning",
  em_rota: "info",
  concluida: "success",
  cancelada: "error",
};

export function ExpedicaoClient({
  inicial,
  embarcaveis,
  podeCriar,
  textos,
}: {
  inicial: Carga[];
  embarcaveis: PedidoComercial[];
  podeCriar: boolean;
  textos: Textos;
}) {
  const t = useT();
  const router = useRouter();
  const [placa, setPlaca] = React.useState("");
  const [veiculo, setVeiculo] = React.useState("");
  const [motorista, setMotorista] = React.useState("");
  const [selecionados, setSelecionados] = React.useState<string[]>([]);
  const [enviando, setEnviando] = React.useState(false);

  function alternar(id: string) {
    setSelecionados((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));
  }

  async function criar() {
    if (selecionados.length === 0) {
      nexusToast.error(t("Selecione ao menos 1 pedido para embarcar."));
      return;
    }
    setEnviando(true);
    try {
      const corpo = await apiClient.post<{ data: { id: string; numero: number } | null }>(
        `/api/v1/shipments`,
        {
          ...(placa.trim() ? { placa: placa.trim() } : {}),
          ...(veiculo.trim() ? { veiculo_tipo: veiculo.trim() } : {}),
          ...(motorista.trim() ? { motorista_nome: motorista.trim() } : {}),
          order_ids: selecionados,
        },
      );
      const carga = corpo?.data;
      if (!carga) throw new Error(t("A carga foi criada mas o servidor não devolveu o resumo."));
      nexusToast.success(`${t("Carga criada")}: ${numeroDaCarga(carga.numero)}`);
      router.push(`/app/expedicao/${carga.id}`);
    } catch (e) {
      showApiError(e);
    } finally {
      setEnviando(false);
    }
  }

  return (
    <div className="space-y-6 p-6">
      <NexusPageHeader title={textos.titulo} subtitle={textos.subtitulo} />

      <div>
        <h2 className="mb-2 text-base font-medium text-text">{textos.cargas}</h2>
        {inicial.length === 0 ? (
          <NexusEmptyState icon={Truck} headline={textos.vazias} />
        ) : (
          <ul className="divide-y rounded-lg border">
            {inicial.map((c) => (
              <li key={c.id} className="flex flex-wrap items-center gap-x-4 gap-y-1 p-3 text-sm">
                <Link
                  href={`/app/expedicao/${c.id}`}
                  className="font-medium underline underline-offset-4"
                >
                  {numeroDaCarga(c.numero)}
                </Link>
                <Badge variant={VARIANTE_CARGA[c.status as StatusDaCarga] ?? "neutral"}>
                  {ROTULO_DA_CARGA[c.status as StatusDaCarga] ?? c.status}
                </Badge>
                <span className="min-w-0 flex-1 truncate text-muted-foreground">
                  {[c.placa, c.veiculo_tipo, c.motorista_nome].filter(Boolean).join(" · ")}
                </span>
                <span className="flex gap-3">
                  <Link
                    href={`/api/v1/shipments/${c.id}/romaneio`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="underline underline-offset-4"
                  >
                    {textos.verRomaneio}
                  </Link>
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>

      {podeCriar && (
        <div>
          <h2 className="mb-2 text-base font-medium text-text">{textos.nova}</h2>
          <div className="space-y-3 rounded-lg border p-4">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <div className="space-y-1.5">
                <Label htmlFor="placa">{textos.placa}</Label>
                <Input
                  id="placa"
                  value={placa}
                  onChange={(e) => setPlaca(e.target.value)}
                  placeholder="ABC1D23"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="veiculo">{textos.veiculo}</Label>
                <Input
                  id="veiculo"
                  value={veiculo}
                  onChange={(e) => setVeiculo(e.target.value)}
                  placeholder="Ex.: HR"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="motorista">{textos.motorista}</Label>
                <Input
                  id="motorista"
                  value={motorista}
                  onChange={(e) => setMotorista(e.target.value)}
                />
              </div>
            </div>
            <div>
              <p className="mb-2 text-sm font-medium">{textos.embarcaveis}</p>
              {embarcaveis.length === 0 ? (
                <p className="text-sm text-muted-foreground">{textos.nenhumEmbarcavel}</p>
              ) : (
                <ul className="max-h-64 space-y-1 overflow-y-auto">
                  {embarcaveis.map((p) => (
                    <li key={p.id}>
                      <label className="flex cursor-pointer items-center gap-3 rounded-2xl border px-3 py-2 text-sm hover:bg-muted/50">
                        <input
                          type="checkbox"
                          checked={selecionados.includes(p.id)}
                          onChange={() => alternar(p.id)}
                        />
                        <span className="font-medium">{numeroDoPedido(p.numero)}</span>
                        <span className="min-w-0 flex-1 truncate">{p.cliente_nome}</span>
                        <span className="font-medium">{comoMoeda(p.total_cents, p.moeda)}</span>
                      </label>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <Button disabled={enviando} onClick={criar}>
              {textos.criar}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
