"use client";
import { useState } from "react";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";

import { SecoesDaOperacao } from "@/components/operacao/SecoesDaOperacao";
import { useT } from "@/hooks/i18n/useT";
import { apiClient } from "@/lib/api/client";
import { horaCurtaNoFuso } from "@/lib/operacao/regras";
import type { OperacaoDoDia } from "@/lib/operacao/tipos";

/** De quanto em quanto tempo a tela pede a operação de novo. */
const ATUALIZAR_A_CADA_MS = 30_000;

export function OperacaoDoDiaClient({
  inicial,
  hoje,
  podeGerar,
}: {
  inicial: OperacaoDoDia;
  hoje: string;
  podeGerar: boolean;
}) {
  const t = useT();
  const [dia, setDia] = useState(inicial.dia);
  const [gerando, setGerando] = useState(false);
  const [aviso, setAviso] = useState<{ tipo: "ok" | "erro"; texto: string } | null>(null);

  const consulta = useQuery({
    queryKey: ["operacao-do-dia", dia],
    queryFn: () => apiClient.get<{ data: OperacaoDoDia }>(`/api/v1/operacao/dia?dia=${encodeURIComponent(dia)}`),
    initialData: dia === inicial.dia ? { data: inicial } : undefined,
    initialDataUpdatedAt: dia === inicial.dia ? new Date(inicial.lido_em).getTime() : undefined,
    refetchInterval: ATUALIZAR_A_CADA_MS,
  });
  const operacao = consulta.data?.data ?? null;

  async function gerar() {
    setGerando(true);
    setAviso(null);
    try {
      await apiClient.post<{ data: { id: string | null; dia: string } }>("/api/v1/operacao/relatorios", { dia });
      setAviso({ tipo: "ok", texto: t("Relatório do dia salvo.") });
    } catch {
      setAviso({ tipo: "erro", texto: t("Não deu para gerar o relatório agora.") });
    } finally {
      setGerando(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-2 text-sm">
          <span>{t("Dia")}</span>
          <input
            type="date"
            value={dia}
            max={hoje}
            onChange={(e) => e.target.value && e.target.value <= hoje && setDia(e.target.value)}
            className="h-9 rounded-md border border-border bg-background px-3 text-sm"
            data-testid="operacao-dia"
          />
        </label>
        {dia !== hoje && (
          <button type="button" onClick={() => setDia(hoje)} className="h-9 rounded-md border border-border px-3 text-sm">
            {t("Hoje")}
          </button>
        )}
        <span className="text-xs text-text-muted" data-testid="operacao-atualizado">
          {operacao
            ? `${t("Atualizado às")} ${horaCurtaNoFuso(operacao.lido_em, operacao.fuso)} (${operacao.fuso})`
            : t("Carregando…")}
        </span>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          {podeGerar && (
            <>
              <button
                type="button"
                onClick={gerar}
                disabled={gerando}
                className="h-9 rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground disabled:opacity-60"
                data-testid="operacao-gerar"
              >
                {gerando ? t("Gerando…") : t("Gerar relatório agora")}
              </button>
              <Link href="/app/operacao/relatorios" className="h-9 rounded-md border border-border px-3 text-sm leading-9">
                {t("Relatórios salvos")}
              </Link>
            </>
          )}
        </div>
      </div>
      {aviso && (
        <p className={`text-sm ${aviso.tipo === "erro" ? "text-red-500" : "text-text-muted"}`} role="status">
          {aviso.texto}{" "}
          {aviso.tipo === "ok" && (
            <Link href={`/app/operacao/relatorios/${dia}`} className="underline">
              {t("Abrir relatório")}
            </Link>
          )}
        </p>
      )}
      {consulta.isError && <p className="text-sm text-red-500">{t("Não deu para carregar a operação do dia agora.")}</p>}
      {operacao && <SecoesDaOperacao operacao={operacao} referencia={operacao.lido_em} />}
    </div>
  );
}
