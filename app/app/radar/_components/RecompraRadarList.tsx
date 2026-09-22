"use client";
import Link from "next/link";
import * as React from "react";

import { useT } from "@/hooks/i18n/useT";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Card } from "@/components/ui/card";
import { apiClient } from "@/lib/api/client";
import { showApiError } from "@/components/feedback/ApiErrorToast";
import { comoMoeda } from "@/lib/format/moeda";
import { ROTULO_RECOMPRA, type HistoricoCompra, type SituacaoRecompra } from "@/lib/comercial/radar-compras";
import { useTagDeIdioma } from "@/hooks/i18n/useLocaleDeData";

// Sem o `vendas` completo (a rota manda resumo + `ultimos`): a base tem
// 10k+ pedidos e o histórico inteiro por cliente não cabe no timeout.
export type LinhaRadarLista = Omit<HistoricoCompra, "vendas"> & {
  nome: string;
  fone: string | null;
  cidade?: string | null;
  uf?: string | null;
  vendedor_user_id?: string | null;
};
type Linha = LinhaRadarLista;

// A chamada agrega a base inteira: 60s de teto em vez dos 10s padrão.
// Sem isso, o abort caía no catch e a tela mentia "base em dia".
const TIMEOUT_RADAR_MS = 60_000;

const POR_PAGINA = 30;

type FaixaPrevista = "atrasadas" | "hoje" | "amanha" | "semana" | "proximos30" | "depois" | "semCiclo";

const ORDEM_FAIXA: FaixaPrevista[] = ["atrasadas", "hoje", "amanha", "semana", "proximos30", "depois", "semCiclo"];

/** Data prevista da próxima compra = última + intervalo típico (dias). null sem ciclo. */
function dataPrevista(l: Linha): string | null {
  const intervalo = l.intervalo_mediano_dias ?? l.intervalo_medio_dias ?? null;
  if (intervalo == null || !l.ultima_compra) return null;
  const base = new Date(`${l.ultima_compra}T12:00:00Z`).getTime();
  if (Number.isNaN(base)) return null;
  return new Date(base + Math.round(intervalo) * 86400000).toISOString().slice(0, 10);
}

function faixaDe(prevista: string | null, hoje: string): FaixaPrevista {
  if (prevista == null) return "semCiclo";
  const diff = Math.round(
    (new Date(`${prevista}T12:00:00Z`).getTime() - new Date(`${hoje}T12:00:00Z`).getTime()) / 86400000,
  );
  if (diff < 0) return "atrasadas";
  if (diff === 0) return "hoje";
  if (diff === 1) return "amanha";
  if (diff <= 7) return "semana";
  if (diff <= 30) return "proximos30";
  return "depois";
}

const ROTULO_FAIXA: Record<FaixaPrevista, string> = {
  atrasadas: "Atrasadas",
  hoje: "Hoje",
  amanha: "Amanhã",
  semana: "Esta semana",
  proximos30: "Próximos 30 dias",
  depois: "Depois",
  semCiclo: "Sem ciclo",
};

const VARIANTE: Record<SituacaoRecompra, "error" | "warning" | "info" | "success"> = {
  em_risco: "error",
  recompra_atrasada: "warning",
  em_voo: "info",
  cancelado_sem_nova: "warning",
  oportunidade_aberta: "info",
  primeira_compra: "success",
  novo_sem_compras: "success",
  ok: "success",
};

/**
 * RECOMPRA — o radar sobre PEDIDOS REAIS (não sobre atividade no CRM).
 *
 * Cada linha explica o alerta com os pedidos: últimos valores, intervalo
 * típico, dias parado e atraso. [Ver pedidos] abre a ficha 360° do contato,
 * onde mora o histórico completo.
 */
export function RecompraRadarList({
  situacaoExterna,
  onSituacaoExternaChange,
}: {
  situacaoExterna?: string;
  onSituacaoExternaChange?: (s: string) => void;
}) {
  const t = useT();
  const tagIdioma = useTagDeIdioma();
  const [situacao, setSituacao] = React.useState("");
  const [linhas, setLinhas] = React.useState<Linha[] | null>(null);
  const [pagina, setPagina] = React.useState(1);
  // Drill-down do dashboard: quando o pai impõe uma situação, ela vence o
  // select interno (que continua valendo quando ninguém impõe nada).
  const situacaoEfetiva = situacaoExterna ?? situacao;

  React.useEffect(() => {
    let vivo = true;
    const qs = situacaoEfetiva ? `?situacao=${situacaoEfetiva}` : "";
    apiClient
      .get<{ data: Linha[] }>(`/api/v1/radar-compras${qs}`, { timeoutMs: TIMEOUT_RADAR_MS })
      .then((corpo) => {
        if (vivo) setLinhas(corpo.data ?? []);
      })
      .catch((e: unknown) => {
        if (!vivo) return;
        showApiError(e);
        setLinhas([]);
      });
    return () => {
      vivo = false;
    };
  }, [situacaoEfetiva]);

  function trocarSituacao(s: string) {
    if (onSituacaoExternaChange) onSituacaoExternaChange(s);
    else setSituacao(s);
    setPagina(1);
  }

  const hoje = React.useMemo(() => new Date().toISOString().slice(0, 10), []);
  // Ordem por data prevista (atraso primeiro), para a página respirar em
  // blocos de 30 sem perder a prioridade: quem já passou da data vem antes.
  const ordenadas = React.useMemo(() => {
    if (linhas === null) return null;
    return [...linhas]
      .map((l) => ({ l, prevista: dataPrevista(l), faixa: faixaDe(dataPrevista(l), hoje) }))
      .sort((a, b) => {
        const fa = ORDEM_FAIXA.indexOf(a.faixa);
        const fb = ORDEM_FAIXA.indexOf(b.faixa);
        if (fa !== fb) return fa - fb;
        if (a.faixa === "atrasadas") return b.l.atraso_dias - a.l.atraso_dias;
        return (a.prevista ?? "").localeCompare(b.prevista ?? "");
      });
  }, [linhas, hoje]);
  const totalPaginas = ordenadas === null ? 0 : Math.max(1, Math.ceil(ordenadas.length / POR_PAGINA));
  const paginaSegura = Math.min(pagina, totalPaginas);
  const visiveis = ordenadas === null ? null : ordenadas.slice((paginaSegura - 1) * POR_PAGINA, paginaSegura * POR_PAGINA);

  if (linhas === null) {
    return (
      <div className="space-y-2">
        <Skeleton className="h-16 w-full" />
        <Skeleton className="h-16 w-full" />
        <Skeleton className="h-16 w-full" />
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-end gap-3">
        <label className="block text-sm">
          <span className="mb-1 block text-muted-foreground">{t("Situação")}</span>
          <select
            value={situacaoEfetiva}
            onChange={(e) => trocarSituacao(e.target.value)}
            className="h-9 rounded-lg border bg-background px-3"
          >
            <option value="">{t("Todas (exceto em dia)")}</option>
            {(Object.keys(ROTULO_RECOMPRA) as SituacaoRecompra[])
              .filter((s) => s !== "ok")
              .map((s) => (
                <option key={s} value={s}>
                  {ROTULO_RECOMPRA[s]}
                </option>
              ))}
          </select>
        </label>
      </div>

      {linhas.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t("Nenhum alerta de recompra — base em dia.")}</p>
      ) : (
        <>
          {visiveis!.map(({ l, faixa, prevista }, i) => {
            const mostrarFaixa = i === 0 || visiveis![i - 1]?.faixa !== faixa;
            return (
              <React.Fragment key={l.contact_id}>
                {mostrarFaixa && (
                  <h3 className="pt-2 text-sm font-medium text-text">
                    {t(ROTULO_FAIXA[faixa])}
                  </h3>
                )}
                <Card className="space-y-2 p-4">
            <div className="flex flex-wrap items-center gap-2">
              <Link
                href={`/app/contacts/${l.contact_id}`}
                className="font-medium text-primary underline-offset-4 hover:underline"
              >
                {l.nome}
              </Link>
              <Badge variant={VARIANTE[l.situacao]}>{ROTULO_RECOMPRA[l.situacao]}</Badge>
              {l.pedido_aberto_id && (
                <span className="text-xs text-muted-foreground">
                  {t("pedido aberto de")} {comoMoeda(l.pedido_aberto_total_cents ?? 0, "BRL")}
                </span>
              )}
              {l.orcamento_total_cents != null && (
                <span className="text-xs text-muted-foreground">
                  {t("proposta de")} {comoMoeda(l.orcamento_total_cents, "BRL")}
                </span>
              )}
              {l.cancelado_total_cents != null && (
                <span className="text-xs text-muted-foreground">
                  {t("cancelado de")} {comoMoeda(l.cancelado_total_cents, "BRL")}
                </span>
              )}
            </div>
            <p className="text-sm text-muted-foreground">
              {l.qtd_pedidos > 0 ? (
                <>
                  {(() => {
                    const intervalo = l.intervalo_mediano_dias ?? l.intervalo_medio_dias ?? null;
                    // Sem 2 ocasiões distintas não há ciclo: 2 pedidos no mesmo
                    // dia são 1 ocasião, não "a cada ~0 dias".
                    return intervalo == null ? (
                      <>{t("Compra única")}</>
                    ) : (
                      <>
                        {t("Compra a cada")} ~{Math.round(intervalo)} {t("dias")}
                      </>
                    );
                  })()}{" "}
                  · {t("há")} {l.dias_sem_compra} {t("dias sem comprar")}
                  {l.atraso_dias > 0 && (
                    <>
                      {" "}· {t("atraso de")} <strong className="text-foreground">+{l.atraso_dias}</strong>
                    </>
                  )}
                  {" · "}
                  {t("ticket médio")} {comoMoeda(l.ticket_medio_cents, "BRL")}
                  {prevista && (
                    <>
                      {" · "}
                      {t("prevista para")} {new Date(`${prevista}T12:00:00Z`).toLocaleDateString(tagIdioma)}
                    </>
                  )}
                  {l.canal_predominante && (
                    <>
                      {" · "}
                      {t("canal")} {l.canal_predominante}
                    </>
                  )}
                </>
              ) : (
                <>{t("Sem compras válidas — prospect ou base nova.")}</>
              )}
            </p>
            {l.ultimos.length > 0 && (
              <p className="text-xs tabular-nums text-muted-foreground">
                {t("Últimos")}:{" "}
                {l.ultimos
                  .map(
                    (u) =>
                      `${new Date(`${u.dia}T12:00:00Z`).toLocaleDateString(tagIdioma)} — ${comoMoeda(u.total_cents, "BRL")}`,
                  )
                  .join(" · ")}
              </p>
            )}
            <div>
              <Button size="sm" variant="outline" asChild>
                <Link href={`/app/contacts/${l.contact_id}`}>{t("Ver pedidos")}</Link>
              </Button>
            </div>
          </Card>
              </React.Fragment>
            );
          })}
          {totalPaginas > 1 && (
            <div className="flex items-center justify-between gap-2 pt-1 text-sm text-muted-foreground">
              <Button
                size="sm"
                variant="outline"
                disabled={paginaSegura <= 1}
                onClick={() => setPagina((p) => Math.max(1, p - 1))}
              >
                {t("Anterior")}
              </Button>
              <span className="tabular-nums">
                {t("Página")} {paginaSegura} {t("de")} {totalPaginas} · {linhas.length} {t("alertas")}
              </span>
              <Button
                size="sm"
                variant="outline"
                disabled={paginaSegura >= totalPaginas}
                onClick={() => setPagina((p) => Math.min(totalPaginas, p + 1))}
              >
                {t("Próxima")}
              </Button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
