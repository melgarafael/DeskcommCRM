"use client";

/**
 * O PAINEL DE VENDAS — Análise › Vendas.
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

import { rotuloDoContato } from "@/lib/contacts/rotulo-do-contato";
import { normalizarTagDoRelatorio } from "@/lib/relatorios/comercial";
import type { LinhaDeRanking } from "@/lib/relatorios/painel-de-vendas";
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

/** O recorte da tela: funil e tag ("" = todos). */
interface RecorteDeVendas {
  pipelineId: string;
  tag: string;
}

const CLASSE_DO_SELETOR =
  "rounded-md border border-border bg-surface-elevated p-2 text-sm text-text max-md:min-h-11";

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
  const [recorte, setRecorte] = useState<RecorteDeVendas>({ pipelineId: "", tag: "" });
  const [metrica, setMetrica] = useState<Metrica>("valor");
  const { data, isLoading, isError, isFetching, isPlaceholderData } = usePainelDeVendas({ ...periodo, ...recorte });
  const painel = data?.data;
  // As OPÇÕES de funil e tag vêm da MESMA resposta: as vendas do período
  // inteiro (registradas e ganhos), antes do recorte.
  const opcoes = painel;

  // Funil ou tag que sumiu do período novo é zerado — só com a resposta do
  // período atual, nunca com a anterior de `keepPreviousData`.
  if (opcoes && !isPlaceholderData) {
    const funilSumiu = recorte.pipelineId !== "" && !opcoes.opcoes.pipeline_ids.includes(recorte.pipelineId);
    const tagSumiu = recorte.tag !== "" && !opcoes.opcoes.tags.includes(normalizarTagDoRelatorio(recorte.tag));
    if (funilSumiu || tagSumiu) {
      setRecorte({ pipelineId: funilSumiu ? "" : recorte.pipelineId, tag: tagSumiu ? "" : recorte.tag });
    }
  }
  const comRecorte = recorte.pipelineId !== "" || recorte.tag !== "";

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

      {/* ── O recorte: vale para os cartões, o gráfico e a lista ────────────── */}
      <div className="flex flex-wrap items-end gap-3" data-testid="recorte-do-painel">
        <label className="flex flex-col gap-1 text-xs text-text-muted">
          {t("Funil")}
          <select
            value={recorte.pipelineId}
            data-testid="painel-funil"
            onChange={(e) => setRecorte((r) => ({ ...r, pipelineId: e.target.value }))}
            className={CLASSE_DO_SELETOR}
          >
            <option value="">{t("Todos os funis")}</option>
            {(opcoes?.opcoes.pipeline_ids ?? []).map((id) => (
              <option key={id} value={id}>
                {opcoes?.nomes_dos_funis[id] ?? t("Funil sem nome")}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs text-text-muted">
          {t("Tag")}
          <select
            value={recorte.tag}
            data-testid="painel-tag"
            onChange={(e) => setRecorte((r) => ({ ...r, tag: e.target.value }))}
            className={CLASSE_DO_SELETOR}
          >
            <option value="">{t("Todas as tags")}</option>
            {(opcoes?.opcoes.tags ?? []).map((tag) => (
              <option key={tag} value={tag}>
                {tag}
              </option>
            ))}
          </select>
        </label>
        {comRecorte && (
          <button
            type="button"
            data-testid="painel-limpar"
            onClick={() => setRecorte({ pipelineId: "", tag: "" })}
            className="rounded-md border border-border px-3 py-2 text-sm hover:bg-surface-elevated max-md:min-h-11"
          >
            {t("Limpar filtros")}
          </button>
        )}
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
              detalhe={`${inteiro.format(painel.negocios_ganhos)} ${t("ganhos")} · ${inteiro.format(painel.perdidos)} ${t("perdidos")}`}
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

      {/* ── Rankings e a lista — da MESMA lista de vendas dos cartões ─────── */}
      {painel && painel.vendas > 0 && (
        <>
          <div className="grid gap-3 lg:grid-cols-3">
            <Ranking
              titulo={t("Tags que mais vendem")}
              testId="ranking-tags"
              linhas={painel.rankings.tags}
              rotulo={(chave) => chave}
              moeda={painel.moeda}
              aoClicar={(chave) => setRecorte((r) => ({ ...r, tag: chave }))}
              tituloDoClique={t("Ver as vendas desta tag")}
            />
            <Ranking
              titulo={t("Clientes que mais compram")}
              testId="ranking-clientes"
              linhas={painel.rankings.clientes}
              rotulo={(chave) => nomeDoContato(painel.contatos[chave], t)}
              moeda={painel.moeda}
            />
            <Ranking
              titulo={t("Funis que mais vendem")}
              testId="ranking-funis"
              linhas={painel.rankings.funis}
              rotulo={(chave) => painel.nomes_dos_funis[chave] ?? t("Funil sem nome")}
              moeda={painel.moeda}
            />
          </div>

          <Card data-testid="lista-do-painel">
            <CardHeader>
              <CardTitle className="text-base">
                {t("Vendas")} ({inteiro.format(painel.vendas_no_recorte)})
              </CardTitle>
              {painel.vendas_no_recorte > painel.lista.length && (
                <p className="text-xs text-text-muted">
                  {t("Mostrando as vendas mais recentes:")} {painel.lista.length}
                </p>
              )}
            </CardHeader>
            <CardContent className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-left text-xs text-text-muted">
                  <tr>
                    <th className="py-1 pr-3 font-medium">{t("Data")}</th>
                    <th className="py-1 pr-3 font-medium">{t("Cliente")}</th>
                    <th className="py-1 pr-3 font-medium max-md:hidden">{t("Negócio")}</th>
                    <th className="py-1 pr-3 font-medium max-md:hidden">{t("Funil")}</th>
                    <th className="py-1 pr-3 font-medium">{t("Tags")}</th>
                    <th className="py-1 text-right font-medium">{t("Valor")}</th>
                  </tr>
                </thead>
                <tbody>
                  {painel.lista.map((v) => (
                    <tr key={`${v.origem}-${v.id}`} className="border-t border-border/60" data-origem={v.origem}>
                      <td className="py-1.5 pr-3 tabular-nums">{rotuloDoPonto(v.dia)}</td>
                      <td className="py-1.5 pr-3">{nomeDoContato(v.contact_id ? painel.contatos[v.contact_id] : undefined, t)}</td>
                      <td className="py-1.5 pr-3 max-md:hidden">
                        {v.titulo ?? "—"}
                        <span className="ml-1 text-xs text-text-muted">
                          · {v.origem === "registrada" ? t("venda registrada") : t("card ganho")}
                        </span>
                      </td>
                      <td className="py-1.5 pr-3 max-md:hidden">
                        {v.pipeline_id ? (painel.nomes_dos_funis[v.pipeline_id] ?? t("Funil sem nome")) : "—"}
                      </td>
                      <td className="py-1.5 pr-3">
                        <div className="flex flex-wrap gap-1">
                          {v.tags.map((tag) => (
                            <span key={tag} className="rounded-full bg-surface-elevated px-2 py-0.5 text-xs">
                              {tag}
                            </span>
                          ))}
                        </div>
                      </td>
                      <td className="py-1.5 text-right tabular-nums">
                        {v.centavos === null
                          ? t("outra moeda")
                          : v.centavos === 0
                            ? t("sem valor")
                            : formatCents(v.centavos, painel.moeda)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}

function nomeDoContato(
  contato: { display_name: string | null; name: string | null; phone_number: string | null } | undefined,
  t: (texto: string) => string,
): string {
  if (!contato) return t("Sem contato");
  return rotuloDoContato(contato, t);
}

function Ranking({
  titulo,
  testId,
  linhas,
  rotulo,
  moeda,
  aoClicar,
  tituloDoClique,
}: {
  titulo: string;
  testId: string;
  linhas: LinhaDeRanking[];
  rotulo: (chave: string) => string;
  moeda: string;
  aoClicar?: (chave: string) => void;
  tituloDoClique?: string;
}) {
  return (
    <Card data-testid={testId}>
      <CardHeader>
        <CardTitle className="text-sm">{titulo}</CardTitle>
      </CardHeader>
      <CardContent>
        {linhas.length === 0 ? (
          <p className="text-sm text-text-muted">—</p>
        ) : (
          <ul className="flex flex-col gap-1.5 text-sm">
            {linhas.map((l) => (
              <li key={l.chave} className="flex items-baseline justify-between gap-2">
                {aoClicar ? (
                  <button
                    type="button"
                    title={tituloDoClique}
                    onClick={() => aoClicar(l.chave)}
                    className="min-w-0 truncate text-left hover:underline"
                  >
                    {rotulo(l.chave)}
                  </button>
                ) : (
                  <span className="min-w-0 truncate">{rotulo(l.chave)}</span>
                )}
                <span className="shrink-0 tabular-nums text-text-muted">
                  {formatCents(l.centavos, moeda)} · {l.vendas}
                </span>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
