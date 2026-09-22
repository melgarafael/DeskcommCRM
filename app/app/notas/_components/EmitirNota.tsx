"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

import { showApiError } from "@/components/feedback/ApiErrorToast";
import { useT } from "@/hooks/i18n/useT";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { apiClient } from "@/lib/api/client";
import type { ConfigFiscalSalva } from "@/lib/schemas/fiscal";
import { type PedidoComercial } from "@/lib/schemas/pedidos";
import { comoMoeda, numeroDoPedido } from "@/lib/format/moeda";
import { Receipt } from "@/lib/ui/icons";

import type { Textos } from "./textos";

/**
 * Aba "Emitir" — uma tarefa por tela, como nos emissores dedicados: escolhe
 * o pedido faturado, vê o resumo (cliente + valor), valida e emite. O
 * resultado cai na grade (aba Notas) via refresh.
 */
export function EmitirNota({
  faturados,
  configInicial,
  textos,
}: {
  faturados: PedidoComercial[];
  configInicial: ConfigFiscalSalva | null;
  textos: Textos;
}) {
  const t = useT();
  const router = useRouter();
  const [pedidoId, setPedidoId] = React.useState("");
  const [emitindo, setEmitindo] = React.useState(false);
  const [pendencias, setPendencias] = React.useState<{ campo: string; mensagem: string; onde: string }[] | null>(null);

  const escolhido = faturados.find((p) => p.id === pedidoId) ?? null;

  async function emitir() {
    if (!pedidoId) {
      toast.error(t("Escolha o pedido faturado."));
      return;
    }
    setEmitindo(true);
    setPendencias(null);
    try {
      // Pré-validação: a SEFAZ nunca é a primeira a dizer que falta NCM.
      const prev = await apiClient.post<{ ok: boolean; pendencias: { campo: string; mensagem: string; onde: string }[] }>(
        "/api/v1/invoices/validar",
        { order_id: pedidoId },
      );
      if (!prev.ok) {
        setPendencias(prev.pendencias);
        return;
      }
      await apiClient.post("/api/v1/invoices", { order_id: pedidoId });
      toast.success(t("Nota enfileirada para emissão"));
      setPedidoId("");
      router.push("/app/notas?aba=notas");
      router.refresh();
    } catch (e) {
      showApiError(e);
    } finally {
      setEmitindo(false);
    }
  }

  return (
    <Card className="space-y-4 p-4 sm:p-5">
      <div>
        <div className="flex items-center gap-2">
          <Receipt size={18} className="text-muted-foreground" />
          <h2 className="text-base font-medium text-text">{textos.emitir}</h2>
        </div>
        <p className="mt-0.5 text-sm text-muted-foreground">{textos.subtituloEmitir}</p>
      </div>

      {!configInicial && (
        <p className="rounded-lg border border-warning/40 bg-warning-bg p-3 text-sm text-warning-fg">
          {textos.semConfig}
        </p>
      )}

      {faturados.length === 0 ? (
        <div className="rounded-lg border border-border bg-muted/30 p-4 text-sm text-muted-foreground">
          {textos.semFaturados}
        </div>
      ) : (
        <div className="space-y-3">
          <div className="max-w-xl space-y-1.5">
            <Label htmlFor="pedido-nota">{textos.escolherPedido}</Label>
            <select
              id="pedido-nota"
              className="h-10 w-full rounded-lg border border-border bg-background px-3 text-sm"
              value={pedidoId}
              onChange={(e) => {
                setPedidoId(e.target.value);
                setPendencias(null);
              }}
            >
              <option value="">{textos.selecione}</option>
              {faturados.map((p) => (
                <option key={p.id} value={p.id}>
                  {numeroDoPedido(p.numero)} · {p.cliente_nome} · {comoMoeda(p.total_cents, p.moeda)}
                </option>
              ))}
            </select>
          </div>

          {escolhido && (
            <div className="grid max-w-xl grid-cols-3 gap-3 rounded-lg border border-border bg-muted/30 p-3 text-sm">
              <div>
                <p className="text-xs text-muted-foreground">{textos.escolherPedido}</p>
                <p className="font-medium tabular-nums">{numeroDoPedido(escolhido.numero)}</p>
              </div>
              <div>
                <p className="text-xs text-muted-foreground">{textos.cliente}</p>
                <p className="truncate font-medium" title={escolhido.cliente_nome}>
                  {escolhido.cliente_nome}
                </p>
              </div>
              <div>
                <p className="text-xs text-muted-foreground">{textos.valor}</p>
                <p className="font-medium tabular-nums">{comoMoeda(escolhido.total_cents, escolhido.moeda)}</p>
              </div>
            </div>
          )}

          <div>
            <Button onClick={() => void emitir()} disabled={emitindo || !configInicial || !pedidoId}>
              {emitindo ? t("Enviando…") : textos.emitir}
            </Button>
          </div>
        </div>
      )}

      {pendencias !== null && pendencias.length > 0 && (
        <div className="rounded-lg border border-warning/40 bg-warning-bg p-3 text-sm" role="alert">
          <p className="font-medium">
            {pendencias.length} {textos.pendencias}
          </p>
          <ul className="mt-1 space-y-1">
            {pendencias.map((p, i) => (
              <li key={i}>
                <Link href={p.onde} className="underline underline-offset-4">
                  {p.mensagem}
                </Link>
              </li>
            ))}
          </ul>
        </div>
      )}
    </Card>
  );
}
