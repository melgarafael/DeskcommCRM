"use client";

/**
 * O PAINEL DE VENDAS (Orken CRM) — Análise › Vendas.
 *
 * Uma tela só para "quanto vendi": quatro cartões grandes (Vendas, Valor
 * vendido, Ticket médio, Conversão), o gráfico do período e, logo abaixo, os
 * rankings e a lista das vendas por funil e tag (o bloco do Faturamento, #4941),
 * no MESMO período. As réguas de cada número estão em
 * `lib/relatorios/painel-de-vendas.ts`.
 *
 * O período inicial vem do SERVIDOR (`periodoInicial`), calculado no fuso da
 * empresa: ler o relógio do navegador num `useState` daria um número na
 * renderização do servidor e outro no navegador.
 */
import { useMemo, useState, type ReactNode } from "react";
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import { RankingsDeNegociosGanhos } from "@/components/relatorios/rankings-de-negocios-ganhos";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useTagDeIdioma } from "@/hooks/i18n/useLocaleDeData";
import { useT } from "@/hooks/i18n/useT";
import { usePainelDeVendas } from "@/hooks/reports/usePainelDeVendas";
import { formatCents } from "@/lib/money";
import {
  ATALHOS_DE_PERIODO,
  atalhoDoPeriodo,
  periodoDoAtalho,
  type AtalhoDePeriodo,
  type Periodo,
} from "@/lib/relatorios/atalhos-de-periodo";
import { cn } from "@/lib/utils";

type Metrica = "valor" | "vendas";

function Cartao({ titulo, valor, detalhe, testId }: { titulo: string; valor: ReactNode; detalhe?: ReactNode; testId: string }) {
  return (
    <Card data-testid={testId}>
      <CardContent className="flex flex-col gap-1 p-5">
        <span className="text-sm font-medium text-text-muted">{titulo}</span>
        <span className="text-3xl font-semibold tabular-nums">{valor}</span>
        {detalhe ? <span className="text-xs text-text-muted">{detalhe}</span> : null}
      </CardContent>
    </Card>
  );
}

export function PainelDeVendas({ periodoInicial, tz }: { periodoInicial: Periodo; tz: string }) {
  const t = useT();
  const tagDeIdioma = useTagDeIdioma();
  const [periodo, setPeriodo] = useState<Periodo>(periodoInicial);
  const [metrica, setMetrica] = useState<Metrica>("valor");
  const { data, isLoading, isError, isFetching } = usePainelDeVendas(periodo);
  const painel = data?.data;

  const rotuloDoAtalho: Record<AtalhoDePeriodo, string> = {
    hoje: t("Hoje"),
    "7d": t("7 dias"),
    "30d": t("30 dias"),
    mes: t("Este mês"),
    mes_passado: t("Mês passado"),
  };
  // O atalho marcado é o que produz o período da tela HOJE; datas escolhidas à
  // mão não marcam nenhum.
  const atalhoAtivo = atalhoDoPeriodo(periodo, new Date(), tz);

  const porcentagem = useMemo(
    () => new Intl.NumberFormat(tagDeIdioma, { style: "percent", maximumFractionDigits: 1 }),
    [tagDeIdioma],
  );
  const inteiro = useMemo(() => new Intl.NumberFormat(tagDeIdioma), [tagDeIdioma]);
  const rotuloDoPonto = useMemo(() => {
    const dia = new Intl.DateTimeFormat(tagDeIdioma, { day: "2-digit", month: "short", timeZone: "UTC" });
    const mes = new Intl.DateTimeFormat(tagDeIdioma, { month: "short", year: "2-digit", timeZone: "UTC" });
    return (chave: string) =>
      chave.length === 7
        ? mes.format(new Date(`${chave}-01T00:00:00Z`))
        : dia.format(new Date(`${chave}T00:00:00Z`));
  }, [tagDeIdioma]);

  const moeda = painel?.moeda ?? "BRL";
  const formatarMetrica = (v: number) => (metrica === "valor" ? formatCents(v, moeda) : inteiro.format(v));

  return (
    <div className="flex flex-col gap-4" data-testid="painel-de-vendas">
      {/* ── O período ─────────────────────────────────────────────────────── */}
      <div className="flex flex-wrap items-center gap-2">
        {ATALHOS_DE_PERIODO.map((atalho) => (
          <button
            key={atalho}
            type="button"
            data-testid={`atalho-${atalho}`}
            aria-pressed={atalhoAtivo === atalho}
            onClick={() => setPeriodo(periodoDoAtalho(atalho, new Date(), tz))}
            className={cn(
              "rounded-full border px-3 py-1.5 text-sm transition-colors max-md:min-h-11",
              atalhoAtivo === atalho
                ? "border-accent bg-accent text-accent-foreground"
                : "border-border bg-surface hover:bg-surface-elevated",
            )}
          >
            {rotuloDoAtalho[atalho]}
          </button>
        ))}
        <div className="flex items-center gap-2 text-sm">
          <input
            type="date"
            aria-label={t("Data inicial")}
            value={periodo.de}
            max={periodo.ate}
            onChange={(e) => e.target.value && setPeriodo((p) => ({ ...p, de: e.target.value }))}
            className="rounded-md border border-border bg-surface px-2 py-1.5"
          />
          <span className="text-text-muted">{t("até")}</span>
          <input
            type="date"
            aria-label={t("Data final")}
            value={periodo.ate}
            min={periodo.de}
            onChange={(e) => e.target.value && setPeriodo((p) => ({ ...p, ate: e.target.value }))}
            className="rounded-md border border-border bg-surface px-2 py-1.5"
          />
        </div>
        {isFetching && !isLoading ? <span className="text-xs text-text-muted">{t("Atualizando…")}</span> : null}
      </div>

      {isLoading ? (
        <p className="text-sm text-text-muted">{t("Carregando…")}</p>
      ) : isError || !painel ? (
        <p className="text-sm text-danger">{t("Erro ao carregar o painel de vendas.")}</p>
      ) : (
        <>
          {/* ── Os cartões ──────────────────────────────────────────────────── */}
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <Cartao testId="cartao-vendas" titulo={t("Vendas")} valor={inteiro.format(painel.vendas)} />
            <Cartao
              testId="cartao-valor"
              titulo={t("Valor vendido")}
              valor={formatCents(painel.vendido_centavos, painel.moeda)}
            />
            <Cartao
              testId="cartao-ticket"
              titulo={t("Ticket médio")}
              valor={painel.ticket_medio_centavos === null ? "—" : formatCents(painel.ticket_medio_centavos, painel.moeda)}
            />
            <Cartao
              testId="cartao-conversao"
              titulo={t("Conversão")}
              valor={painel.conversao === null ? "—" : porcentagem.format(painel.conversao)}
              detalhe={`${inteiro.format(painel.vendas)} ${t("ganhos")} · ${inteiro.format(painel.perdidos)} ${t("perdidos")}`}
            />
          </div>

          {/* ── O gráfico ───────────────────────────────────────────────────── */}
          <Card>
            <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2">
              <CardTitle className="text-base">
                {painel.granularidade === "mes" ? t("Vendas por mês") : t("Vendas por dia")}
              </CardTitle>
              <div className="flex gap-1 rounded-full border border-border p-0.5" role="group">
                {(["valor", "vendas"] as const).map((m) => (
                  <button
                    key={m}
                    type="button"
                    data-testid={`metrica-${m}`}
                    aria-pressed={metrica === m}
                    onClick={() => setMetrica(m)}
                    className={cn(
                      "rounded-full px-3 py-1 text-xs",
                      metrica === m ? "bg-accent text-accent-foreground" : "text-text-muted",
                    )}
                  >
                    {m === "valor" ? t("Valor") : t("Quantidade")}
                  </button>
                ))}
              </div>
            </CardHeader>
            <CardContent>
              {painel.vendas === 0 ? (
                <p className="text-sm text-text-muted" data-testid="sem-vendas">
                  {t("Nenhuma venda no período.")}
                </p>
              ) : (
                <div className="h-72 w-full" data-testid="grafico-de-vendas">
                  <ResponsiveContainer width="100%" height="100%">
                    <AreaChart
                      data={painel.serie.map((p) => ({ chave: p.chave, valor: p.centavos, vendas: p.vendas }))}
                      margin={{ top: 8, right: 12, bottom: 0, left: 0 }}
                    >
                      <defs>
                        <linearGradient id="preenchimento-vendas" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="0%" stopColor="var(--color-accent)" stopOpacity={0.35} />
                          <stop offset="100%" stopColor="var(--color-accent)" stopOpacity={0.02} />
                        </linearGradient>
                      </defs>
                      <CartesianGrid vertical={false} className="stroke-border/50" />
                      <XAxis
                        dataKey="chave"
                        tickFormatter={rotuloDoPonto}
                        tick={{ fontSize: 11 }}
                        tickLine={false}
                        axisLine={false}
                        interval="preserveStartEnd"
                        minTickGap={16}
                      />
                      <YAxis
                        tick={{ fontSize: 11 }}
                        tickLine={false}
                        axisLine={false}
                        allowDecimals={false}
                        tickFormatter={formatarMetrica}
                        width={metrica === "valor" ? 80 : 40}
                      />
                      <Tooltip
                        formatter={(v) => [formatarMetrica(Number(v)), metrica === "valor" ? t("Valor") : t("Vendas")]}
                        labelFormatter={(l) => rotuloDoPonto(String(l))}
                        contentStyle={{
                          borderRadius: "8px",
                          fontSize: "12px",
                          border: "1px solid var(--color-border)",
                          background: "var(--color-surface)",
                        }}
                      />
                      <Area
                        type="monotone"
                        dataKey={metrica}
                        stroke="var(--color-accent)"
                        strokeWidth={2}
                        fill="url(#preenchimento-vendas)"
                        dot={{ r: 3 }}
                        activeDot={{ r: 5 }}
                      />
                    </AreaChart>
                  </ResponsiveContainer>
                </div>
              )}
            </CardContent>
          </Card>

          {/* ── O que ficou fora, dito em vez de escondido ──────────────────── */}
          {(painel.vendas_sem_valor > 0 || painel.excluidos.outra_moeda > 0 || painel.truncado) && (
            <ul className="list-disc pl-5 text-xs text-text-muted" data-testid="avisos-do-painel">
              {painel.vendas_sem_valor > 0 && (
                <li>
                  {inteiro.format(painel.vendas_sem_valor)}{" "}
                  {t("venda(s) sem valor preenchido: contam em Vendas, mas não no valor nem no ticket médio.")}
                </li>
              )}
              {painel.excluidos.outra_moeda > 0 && (
                <li>
                  {inteiro.format(painel.excluidos.outra_moeda)}{" "}
                  {t("venda(s) em outra moeda: contam em Vendas, mas não no valor.")}
                </li>
              )}
              {painel.truncado && <li>{t("Período com muitos negócios: a leitura parou no limite e os números podem estar incompletos.")}</li>}
            </ul>
          )}
        </>
      )}

      {/* ── As vendas, por funil e tag, no MESMO período ─────────────────── */}
      <RankingsDeNegociosGanhos de={periodo.de} ate={periodo.ate} />
    </div>
  );
}
