"use client";
/**
 * Contratos de honorários — o modelo de cobrança do caso.
 *
 * Módulo opcional (ADR-0002): antes de instalado, toda leitura devolve 409
 * `module_not_installed`. A tela não trata isso como erro genérico — mostra o
 * mesmo texto que a rota manda (quem resolve é o administrador da instalação,
 * em Configurações da instalação › Módulos, não quem está nesta tela).
 */
import { useState } from "react";
import { useQuery, useQueryClient, useMutation } from "@tanstack/react-query";

import { Button } from "@/components/ui/button";
import { showApiError } from "@/components/feedback/ApiErrorToast";
import { useT } from "@/hooks/i18n/useT";
import { apiClient } from "@/lib/api/client";
import { ApiError } from "@/lib/api/types";
import { formatCents } from "@/lib/money";

import { Parcelas } from "./_parcelas";

type Modelo = "fixo" | "exito" | "misto";

export type Contrato = {
  id: string;
  lead_id: string | null;
  modelo: Modelo;
  valor_fixo_cents: number | null;
  percentual_exito: number | null;
  repasse_advogado_pct: number | null;
  created_at: string;
};

function rotuloDoModelo(modelo: Modelo, t: (s: string) => string): string {
  if (modelo === "fixo") return t("Fixo");
  if (modelo === "exito") return t("Êxito");
  return t("Misto");
}

function resumoDoValor(c: Contrato, t: (s: string) => string): string {
  const partes: string[] = [];
  if (c.valor_fixo_cents != null) partes.push(formatCents(c.valor_fixo_cents, "BRL"));
  if (c.percentual_exito != null) partes.push(`${c.percentual_exito}% ${t("de êxito")}`);
  return partes.join(" + ") || "—";
}

export function Honorarios({ podeGerenciar }: { podeGerenciar: boolean }) {
  const t = useT();
  const qc = useQueryClient();
  const [selecionado, setSelecionado] = useState<string | null>(null);

  const contratos = useQuery({
    queryKey: ["honorarios", "contratos"],
    queryFn: async () => (await apiClient.get<{ data: Contrato[] }>("/api/v1/honorarios/contratos")).data,
    retry: false,
  });

  const criar = useMutation({
    mutationFn: (corpo: Record<string, unknown>) =>
      apiClient.post<{ data: Contrato }>("/api/v1/honorarios/contratos", corpo),
    onSuccess: (res) => {
      void qc.invalidateQueries({ queryKey: ["honorarios", "contratos"] });
      setSelecionado(res.data.id);
    },
    onError: showApiError,
  });

  const naoInstalado =
    contratos.error instanceof ApiError && contratos.error.code === "module_not_installed";

  if (naoInstalado) {
    return (
      <p className="rounded-md border border-border p-3 text-sm text-text-muted" role="status">
        {(contratos.error as ApiError).message}
      </p>
    );
  }

  if (contratos.isError) {
    return (
      <p className="text-sm text-danger">{t("Não foi possível carregar os contratos.")}</p>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {podeGerenciar ? (
        <FormularioDeContrato
          criando={criar.isPending}
          onCriar={(corpo) => criar.mutate(corpo)}
        />
      ) : null}

      <section className="rounded-md border border-border p-3">
        <h2 className="mb-2 text-sm font-semibold">{t("Contratos")}</h2>
        {(contratos.data ?? []).length === 0 ? (
          <p className="text-sm text-text-muted">{t("Nenhum contrato ainda.")}</p>
        ) : (
          <table className="w-full text-sm">
            <tbody>
              {(contratos.data ?? []).map((c) => (
                <tr
                  key={c.id}
                  className={`cursor-pointer border-b border-border/60 ${
                    selecionado === c.id ? "bg-surface-elevated" : ""
                  }`}
                  onClick={() => setSelecionado(c.id)}
                  data-testid={`contrato-${c.id}`}
                >
                  <td className="py-2">{rotuloDoModelo(c.modelo, t)}</td>
                  <td className="py-2 tabular-nums">{resumoDoValor(c, t)}</td>
                  <td className="py-2 text-right text-xs text-text-muted">
                    {new Date(c.created_at).toLocaleDateString("pt-BR")}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      {selecionado ? <Parcelas contratoId={selecionado} podeGerenciar={podeGerenciar} /> : null}
    </div>
  );
}

function FormularioDeContrato({
  criando,
  onCriar,
}: {
  criando: boolean;
  onCriar: (corpo: Record<string, unknown>) => void;
}) {
  const t = useT();
  const [leadId, setLeadId] = useState("");
  const [modelo, setModelo] = useState<Modelo>("fixo");
  const [valorFixo, setValorFixo] = useState("");
  const [percentual, setPercentual] = useState("");
  const [repasse, setRepasse] = useState("");

  const precisaFixo = modelo === "fixo" || modelo === "misto";
  const precisaExito = modelo === "exito" || modelo === "misto";
  const valorFixoCents = valorFixo ? Math.round(Number(valorFixo.replace(",", ".")) * 100) : null;
  const percentualExito = percentual ? Number(percentual.replace(",", ".")) : null;

  const pode =
    !criando &&
    (!precisaFixo || (valorFixoCents !== null && valorFixoCents > 0)) &&
    (!precisaExito || (percentualExito !== null && percentualExito > 0));

  return (
    <form
      className="flex flex-wrap items-end gap-2 rounded-md border border-border p-3"
      onSubmit={(e) => {
        e.preventDefault();
        if (!pode) return;
        onCriar({
          lead_id: leadId.trim() || null,
          modelo,
          valor_fixo_cents: precisaFixo ? valorFixoCents : null,
          percentual_exito: precisaExito ? percentualExito : null,
          repasse_advogado_pct: repasse ? Number(repasse.replace(",", ".")) : null,
        });
        setLeadId("");
        setValorFixo("");
        setPercentual("");
        setRepasse("");
      }}
    >
      <label className="flex flex-col gap-1 text-xs text-text-muted">
        {t("Modelo")}
        <select
          value={modelo}
          data-testid="contrato-modelo"
          onChange={(e) => setModelo(e.target.value as Modelo)}
          className="rounded-md border border-border bg-surface-elevated p-2 text-sm text-text"
        >
          <option value="fixo">{t("Fixo")}</option>
          <option value="exito">{t("Êxito")}</option>
          <option value="misto">{t("Misto")}</option>
        </select>
      </label>

      {precisaFixo ? (
        <label className="flex flex-col gap-1 text-xs text-text-muted">
          {t("Valor fixo")}
          <input
            value={valorFixo}
            inputMode="decimal"
            placeholder="0,00"
            data-testid="contrato-valor-fixo"
            onChange={(e) => setValorFixo(e.target.value)}
            className="w-28 rounded-md border border-border bg-surface-elevated p-2 text-sm text-text"
          />
        </label>
      ) : null}

      {precisaExito ? (
        <label className="flex flex-col gap-1 text-xs text-text-muted">
          {t("% de êxito")}
          <input
            value={percentual}
            inputMode="decimal"
            placeholder="10"
            data-testid="contrato-percentual-exito"
            onChange={(e) => setPercentual(e.target.value)}
            className="w-20 rounded-md border border-border bg-surface-elevated p-2 text-sm text-text"
          />
        </label>
      ) : null}

      <label className="flex flex-col gap-1 text-xs text-text-muted">
        {t("Repasse ao advogado (%)")}
        <input
          value={repasse}
          inputMode="decimal"
          placeholder={t("opcional")}
          data-testid="contrato-repasse"
          onChange={(e) => setRepasse(e.target.value)}
          className="w-24 rounded-md border border-border bg-surface-elevated p-2 text-sm text-text"
        />
      </label>

      <label className="flex flex-col gap-1 text-xs text-text-muted">
        {t("ID do lead (opcional)")}
        <input
          value={leadId}
          placeholder={t("cole o ID do lead")}
          data-testid="contrato-lead-id"
          onChange={(e) => setLeadId(e.target.value)}
          className="w-48 rounded-md border border-border bg-surface-elevated p-2 text-sm text-text"
        />
      </label>

      <Button type="submit" disabled={!pode} data-testid="criar-contrato">
        {t("Criar contrato")}
      </Button>
    </form>
  );
}
