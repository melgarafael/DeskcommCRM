"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

import { showApiError } from "@/components/feedback/ApiErrorToast";
import { useT } from "@/hooks/i18n/useT";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { apiClient } from "@/lib/api/client";
import {
  MOTIVOS_DEVOLUCAO,
  numeroDaCarga,
  ROTULO_DA_CARGA,
  ROTULO_MOTIVO_DEVOLUCAO,
  ROTULO_NA_CARGA,
  type MotivoDevolucao,
  type PedidoNaCarga,
  type StatusDaCarga,
  type StatusNaCarga,
} from "@/lib/schemas/expedicao";
import { comoMoeda, numeroDoPedido } from "@/lib/format/moeda";

import { ModoMotorista } from "./_motorista";
import { Roteirizador } from "./_roteirizador";

interface Textos {
  voltar: string;
  rota: string;
  romaneio: string;
  totalMercadorias: string;
  aCobrar: string;
  paradasConcluidas: string;
  sairRota: string;
  concluir: string;
  entregue: string;
  devolvido: string;
  semEndereco: string;
  verComprovante: string;
  escolherFoto: string;
  excluirCarga: string;
  confirmarExcluir: string;
  tirarDaCarga: string;
  mapaRota: string;
  modoOperador: string;
  modoMotorista: string;
  cheguei: string;
  motivo: string;
  confirmar: string;
  cancelar: string;
}

interface Detalhe {
  carga: {
    id: string;
    numero: number;
    placa: string | null;
    veiculo_tipo: string | null;
    motorista_nome: string | null;
    status: StatusDaCarga;
  };
  itens: (PedidoNaCarga & { tem_comprovante: boolean; pago_cents: number })[];
}

export function CargaClient({
  cargaId,
  podeOperar,
  podeExcluir,
  textos,
}: {
  cargaId: string;
  podeOperar: boolean;
  podeExcluir: boolean;
  textos: Textos;
}) {
  const t = useT();
  const router = useRouter();
  const [detalhe, setDetalhe] = React.useState<Detalhe | null>(null);
  const [modo, setModo] = React.useState<"operador" | "motorista">("operador");
  const [motivoPara, setMotivoPara] = React.useState<string | null>(null);
  const [motivo, setMotivo] = React.useState<MotivoDevolucao>("cliente_ausente");

  const recarregar = React.useCallback(async () => {
    try {
      const corpo = await apiClient.get<{ data: Detalhe }>(`/api/v1/shipments/${cargaId}`);
      const d = corpo?.data;
      if (d && Array.isArray(d.itens)) {
        setDetalhe({ ...d, itens: d.itens });
      } else {
        setDetalhe(null);
        showApiError(new Error(t("Resposta inesperada do servidor.")));
      }
    } catch (e) {
      showApiError(e);
    }
  }, [cargaId, t]);

  // Carregar o detalhe ao montar é sincronização com o servidor (fetch),
  // não estado derivado — o caso de uso que a regra manda para useEffect.
  React.useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void recarregar();
  }, [recarregar]);

  async function mudarStatus(status: string) {
    // Sair/concluir passam pela rota (carimba início/fim); o resto, direto.
    const rota = status === "em_rota" ? "iniciar" : status === "concluida" ? "finalizar" : null;
    try {
      if (rota) await apiClient.post(`/api/v1/shipments/${cargaId}/rota/${rota}`, {});
      else await apiClient.patch(`/api/v1/shipments/${cargaId}`, { status });
      await recarregar();
    } catch (e) {
      showApiError(e);
    }
  }

  async function desfecho(
    orderId: string,
    status: "em_atendimento" | "entregue" | "devolvido",
    motivoDev?: MotivoDevolucao,
  ) {
    try {
      // Na entrega, carimba onde o aparelho está (best-effort: sem GPS, vale igual).
      let geo: { latitude?: number; longitude?: number } = {};
      if (status === "entregue" && "geolocation" in navigator) {
        try {
          const pos = await new Promise<GeolocationPosition>((ok, falha) =>
            navigator.geolocation.getCurrentPosition(ok, falha, { timeout: 8000 }),
          );
          geo = { latitude: pos.coords.latitude, longitude: pos.coords.longitude };
        } catch {
          // Sem GPS, a entrega vale igual — só sem coordenada.
        }
      }
      await apiClient.patch(`/api/v1/shipments/${cargaId}/orders/${orderId}`, {
        status,
        ...(status === "devolvido" ? { motivo: motivoDev ?? motivo } : {}),
        ...geo,
      });
      setMotivoPara(null);
      await recarregar();
    } catch (e) {
      showApiError(e);
    }
  }

  async function tirarDaCarga(orderId: string) {
    try {
      await apiClient.delete(`/api/v1/shipments/${cargaId}/orders/${orderId}`);
      toast.success(t("Pedido de volta na fila de embarque."));
      await recarregar();
    } catch (e) {
      showApiError(e);
    }
  }

  async function excluirCarga() {
    if (!window.confirm(textos.confirmarExcluir)) return;
    try {
      await apiClient.delete(`/api/v1/shipments/${cargaId}`);
      toast.success(t("Romaneio excluído."));
      router.push("/app/expedicao");
    } catch (e) {
      showApiError(e);
    }
  }

  async function anexarFoto(orderId: string, arquivo: File | undefined) {
    if (!arquivo) {
      toast.error(t("Escolha a foto primeiro."));
      return;
    }
    try {
      const form = new FormData();
      form.append("file", arquivo);
      const res = await fetch(`/api/v1/shipments/${cargaId}/orders/${orderId}/proof`, {
        method: "POST",
        body: form,
      });
      if (!res.ok) {
        const corpo = (await res.json().catch(() => null)) as {
          error?: { message?: string };
        } | null;
        toast.error(corpo?.error?.message ?? t("Não consegui enviar a foto."));
        return;
      }
      toast.success(t("Comprovante anexado"));
      await recarregar();
    } catch {
      toast.error(t("Não consegui enviar a foto."));
    }
  }

  if (!detalhe) {
    return (
      <div className="space-y-3 p-6">
        <Skeleton className="h-8 w-56" />
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-40 w-full" />
      </div>
    );
  }

  const { carga, itens } = detalhe;
  // em_atendimento é pendência: chegou ≠ entregue.
  const pendentes = itens.filter((i) =>
    ["na_carga", "em_rota", "em_atendimento"].includes(i.status),
  ).length;
  const concluidas = itens.filter((i) => ["entregue", "devolvido"].includes(i.status)).length;
  const totalMercadorias = itens.reduce((s, i) => s + (i.pedido.total_cents || 0), 0);
  const aCobrar = itens
    .filter((i) => i.status !== "devolvido")
    .reduce((s, i) => s + Math.max(0, (i.pedido.total_cents || 0) - (i.pago_cents || 0)), 0);

  return (
    <div className="space-y-6 p-6">
      {/* Cabeçalho fixo: na página longa (mapa + paradas + pedidos), voltar
        e ações acompanham a rolagem em vez de sumirem para cima — gruda
        logo abaixo da TopBar (h-14), com fundo para o conteúdo passar
        por baixo sem vazar por cima. */}
      <div className="sticky top-14 z-10 -mx-6 -mt-6 space-y-3 border-b bg-background/95 px-6 py-3 backdrop-blur">
        <Link href="/app/expedicao" className="text-sm underline underline-offset-4">
          ← {textos.voltar}
        </Link>

        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="grid gap-2 sm:grid-cols-3">
            <Card className="p-3">
              <p className="text-xs tracking-wide text-muted-foreground uppercase">
                {textos.totalMercadorias}
              </p>
              <p className="text-lg font-semibold tabular-nums">
                {comoMoeda(totalMercadorias, "BRL")}
              </p>
            </Card>
            <Card className="p-3">
              <p className="text-xs tracking-wide text-muted-foreground uppercase">
                {textos.aCobrar}
              </p>
              <p className="text-lg font-semibold tabular-nums">{comoMoeda(aCobrar, "BRL")}</p>
            </Card>
            <Card className="p-3">
              <p className="text-xs tracking-wide text-muted-foreground uppercase">
                {textos.paradasConcluidas}
              </p>
              <p className="text-lg font-semibold tabular-nums">
                {concluidas}/{itens.length}
              </p>
            </Card>
          </div>

          <div>
            <h1 className="text-2xl font-medium tracking-tight text-text">
              {numeroDaCarga(carga.numero)}
            </h1>
            <p className="text-sm text-muted-foreground">
              {ROTULO_DA_CARGA[carga.status] ?? carga.status}
              {[carga.placa, carga.veiculo_tipo, carga.motorista_nome].filter(Boolean).length > 0 &&
                ` · ${[carga.placa, carga.veiculo_tipo, carga.motorista_nome].filter(Boolean).join(" · ")}`}
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" asChild>
              <Link
                href={`/api/v1/shipments/${carga.id}/romaneio`}
                target="_blank"
                rel="noopener noreferrer"
              >
                {textos.romaneio}
              </Link>
            </Button>
            {podeOperar && carga.status === "montando" && (
              <Button onClick={() => void mudarStatus("em_rota")}>{textos.sairRota}</Button>
            )}
            {podeOperar && carga.status === "em_rota" && (
              <Button onClick={() => void mudarStatus("concluida")} disabled={pendentes > 0}>
                {textos.concluir}
              </Button>
            )}
            {podeExcluir && (carga.status === "montando" || carga.status === "em_rota") && (
              <Button variant="destructive" onClick={() => void excluirCarga()}>
                {textos.excluirCarga}
              </Button>
            )}
          </div>
        </div>
      </div>

      <div>
        <div className="mb-2 flex items-center gap-2">
          <h2 className="text-base font-medium text-text">{textos.mapaRota}</h2>
          <span className="ml-auto flex gap-1 rounded-full border p-0.5 text-xs">
            <button
              type="button"
              className={`rounded-full px-2 py-1 ${modo === "operador" ? "bg-primary text-primary-foreground" : "hover:bg-muted"}`}
              onClick={() => setModo("operador")}
            >
              {textos.modoOperador}
            </button>
            <button
              type="button"
              className={`rounded-full px-2 py-1 ${modo === "motorista" ? "bg-primary text-primary-foreground" : "hover:bg-muted"}`}
              onClick={() => setModo("motorista")}
            >
              {textos.modoMotorista}
            </button>
          </span>
        </div>
        {modo === "operador" ? (
          <Roteirizador
            cargaId={cargaId}
            podeOperar={podeOperar}
            aoMudar={() => void recarregar()}
          />
        ) : (
          <ModoMotorista
            cargaId={cargaId}
            podeOperar={podeOperar}
            aoMudar={() => void recarregar()}
          />
        )}
      </div>

      <div>
        <h2 className="mb-2 text-base font-medium text-text">
          {textos.rota} ({itens.length})
        </h2>
        {itens.length === 0 ? (
          <Card className="p-6 text-center text-sm text-muted-foreground">
            {t("Nenhum pedido embarcado.")}
          </Card>
        ) : (
          <ul className="space-y-2">
            {itens.map((i) => (
              <li key={i.id} className="rounded-lg border p-3">
                <div className="flex flex-wrap items-center gap-3 text-sm">
                  <span className="text-lg font-bold text-primary">{i.sequencia}</span>
                  <div className="min-w-0 flex-1">
                    <p className="font-medium">
                      {numeroDoPedido(i.pedido.numero)} · {i.pedido.cliente_nome}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {i.pedido.endereco_entrega ?? textos.semEndereco}
                    </p>
                  </div>
                  <span className="font-medium">{comoMoeda(i.pedido.total_cents, "BRL")}</span>
                  <span className="text-xs text-muted-foreground">
                    {ROTULO_NA_CARGA[i.status as StatusNaCarga] ?? i.status}
                  </span>
                </div>
                {podeOperar && ["na_carga", "em_rota", "em_atendimento"].includes(i.status) && (
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => void desfecho(i.order_id, "em_atendimento")}
                    >
                      {textos.cheguei}
                    </Button>
                    <Button size="sm" onClick={() => void desfecho(i.order_id, "entregue")}>
                      {textos.entregue}
                    </Button>
                    {motivoPara === i.order_id ? (
                      <>
                        <select
                          className="rounded-lg border bg-background px-2 py-1 text-sm"
                          value={motivo}
                          onChange={(e) => setMotivo(e.target.value as MotivoDevolucao)}
                          aria-label={textos.motivo}
                        >
                          {MOTIVOS_DEVOLUCAO.map((m) => (
                            <option key={m} value={m}>
                              {ROTULO_MOTIVO_DEVOLUCAO[m]}
                            </option>
                          ))}
                        </select>
                        <Button
                          size="sm"
                          variant="destructive"
                          onClick={() => void desfecho(i.order_id, "devolvido")}
                        >
                          {textos.confirmar}
                        </Button>
                        <Button size="sm" variant="ghost" onClick={() => setMotivoPara(null)}>
                          {textos.cancelar}
                        </Button>
                      </>
                    ) : (
                      <Button size="sm" variant="outline" onClick={() => setMotivoPara(i.order_id)}>
                        {textos.devolvido}
                      </Button>
                    )}
                    <Button size="sm" variant="ghost" onClick={() => void tirarDaCarga(i.order_id)}>
                      {textos.tirarDaCarga}
                    </Button>
                  </div>
                )}
                {i.status === "entregue" && (
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    {i.tem_comprovante ? (
                      <Link
                        href={`/api/v1/shipments/${carga.id}/orders/${i.order_id}/proof`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-sm underline underline-offset-4"
                      >
                        {textos.verComprovante}
                      </Link>
                    ) : (
                      podeOperar && (
                        <>
                          <input
                            type="file"
                            accept="image/jpeg,image/png,image/webp"
                            className="text-sm"
                            aria-label={textos.escolherFoto}
                            onChange={(e) => void anexarFoto(i.order_id, e.target.files?.[0])}
                          />
                        </>
                      )
                    )}
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
