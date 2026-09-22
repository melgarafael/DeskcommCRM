"use client";
import Link from "next/link";
import * as React from "react";
import { toast } from "sonner";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import { showApiError } from "@/components/feedback/ApiErrorToast";
import { EmptyFilterResults } from "@/components/empty";
import { useT } from "@/hooks/i18n/useT";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { apiClient } from "@/lib/api/client";
import { comoMoeda } from "@/lib/format/moeda";
import { linkWhatsAppRecuperacao, type ClienteInativo } from "@/lib/comercial/inatividade";
import { ROTULO_RECOMPRA } from "@/lib/comercial/radar-compras";
import {
  FILTRO_RADAR_VAZIO,
  ROTULO_NIVEL,
  agregarRadar,
  filtrarLinhas,
  intervaloTipicoDe,
  type FiltroRadar,
  type LinhaRadar,
  type NivelRadar,
  type ResumoRadar,
} from "@/lib/comercial/radar-score";
import { useAtRiskLeads } from "@/hooks/leads/useAtRiskLeads";
import { RecompraRadarList, type LinhaRadarLista } from "./RecompraRadarList";
import { RiskRadarList } from "./RiskRadarList";
import { RadarCategorias } from "./RadarCategorias";

const TIMEOUT_RADAR_MS = 60_000;

const COR_NIVEL: Record<NivelRadar, string> = {
  saudavel: "#33c758",
  atencao: "#ffa600",
  risco: "#ff3e00",
  critico: "#a94a3c",
};

const VARIANTE_NIVEL: Record<NivelRadar, "success" | "warning" | "error" | "info"> = {
  saudavel: "success",
  atencao: "warning",
  risco: "error",
  critico: "error",
};

function paraLinha(l: LinhaRadarLista): LinhaRadar {
  return {
    contact_id: l.contact_id,
    nome: l.nome,
    fone: l.fone,
    cidade: l.cidade ?? null,
    uf: l.uf ?? null,
    vendedor_user_id: l.vendedor_user_id ?? null,
    qtd_pedidos: l.qtd_pedidos,
    ticket_medio_cents: l.ticket_medio_cents,
    intervalo_mediano_dias: l.intervalo_mediano_dias,
    intervalo_medio_dias: l.intervalo_medio_dias,
    dias_sem_compra: l.dias_sem_compra,
    atraso_dias: l.atraso_dias,
    situacao: l.situacao,
    ultima_compra: l.ultima_compra,
    ultimos: l.ultimos,
  };
}

function zapHref(
  fone: string | null,
  nome: string,
  atraso: number,
  intervalo: number | null,
): string | null {
  if (!fone) return null;
  const digitos = fone.replace(/\D/g, "");
  if (digitos.length < 10) return null;
  const msg =
    intervalo != null
      ? `Olá ${nome}! Você costuma comprar a cada ~${Math.round(intervalo)} dias e já passou ${atraso} dias do padrão. Posso preparar seu pedido?`
      : `Olá ${nome}! Faz tempo que você não compra com a gente. Posso preparar uma condição para você voltar?`;
  return `https://wa.me/${digitos}?text=${encodeURIComponent(msg)}`;
}

function rolarPara(id: string) {
  document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });
}

/**
 * RADAR COMERCIAL — painel de decisões, não lista bonita.
 *
 * Uma busca (`situacao=todas`) alimenta KPIs, gráficos e ranking — tudo
 * derivado das linhas, sem mock. A lista clássica (`RecompraRadarList`) segue
 * montada como drill-down (o e2e `recompra-radar` lê dela), e a de demandas
 * (`RiskRadarList`) intacta. Filtros globais valem para o dashboard; a lista
 * clássica mantém o próprio select de situação.
 */
export function RadarDashboard() {
  const t = useT();
  const [linhas, setLinhas] = React.useState<LinhaRadarLista[] | null>(null);
  const [falhou, setFalhou] = React.useState(false);
  const [filtros, setFiltros] = React.useState<FiltroRadar>(FILTRO_RADAR_VAZIO);
  const [drill, setDrill] = React.useState("");
  const [vendedores, setVendedores] = React.useState<
    { user_id: string; full_name: string | null }[]
  >([]);
  const [inativos, setInativos] = React.useState<ClienteInativo[] | null>(null);
  const [tarefaEmCurso, setTarefaEmCurso] = React.useState<string | null>(null);
  const [metricaSaude, setMetricaSaude] = React.useState<"compras" | "clientes">("compras");
  const { data: risco } = useAtRiskLeads();

  const carregar = React.useCallback(async () => {
    setFalhou(false);
    try {
      const corpo = await apiClient.get<{ data: LinhaRadarLista[] }>(
        "/api/v1/radar-compras?situacao=todas&limit=5000",
        {
          timeoutMs: TIMEOUT_RADAR_MS,
        },
      );
      setLinhas(corpo.data ?? []);
    } catch (e) {
      showApiError(e);
      setFalhou(true);
      setLinhas([]);
    }
  }, []);

  React.useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void carregar();
    apiClient
      .get<{ data: { user_id: string; full_name: string | null }[] }>("/api/v1/team/assignable")
      .then((r) => setVendedores(Array.isArray(r?.data) ? r.data : []))
      .catch(() => undefined);
    apiClient
      .get<{ data: ClienteInativo[] }>("/api/v1/comercial/inativos?dias=90")
      .then((r) => setInativos(Array.isArray(r?.data) ? r.data.slice(0, 5) : []))
      .catch(() => setInativos([]));
  }, [carregar]);

  const hoje = new Date().toISOString().slice(0, 10);
  const linhasRadar = React.useMemo(() => (linhas ?? []).map(paraLinha), [linhas]);
  const filtradas = React.useMemo(
    () => filtrarLinhas(linhasRadar, filtros),
    [linhasRadar, filtros],
  );
  const resumo: ResumoRadar | null = React.useMemo(
    () => (linhas === null ? null : agregarRadar(filtradas, hoje)),
    [filtradas, linhas, hoje],
  );
  const serieMista = React.useMemo(() => {
    const clientesPorSemana = new Map<string, Set<string>>();
    for (const l of filtradas) {
      for (const u of l.ultimos) {
        if (u.dia > hoje) continue;
        const d = new Date(`${u.dia}T12:00:00Z`);
        const dow = (d.getUTCDay() + 6) % 7;
        d.setUTCDate(d.getUTCDate() - dow);
        const s = d.toISOString().slice(0, 10);
        const set = clientesPorSemana.get(s) ?? new Set<string>();
        set.add(l.contact_id);
        clientesPorSemana.set(s, set);
      }
    }
    return (resumo?.serie ?? []).map((s) => ({
      ...s,
      clientes: clientesPorSemana.get(s.semana)?.size ?? 0,
    }));
  }, [resumo, filtradas, hoje]);

  const nomesVendedores = React.useMemo(
    () => new Map(vendedores.map((v) => [v.user_id, v.full_name ?? v.user_id.slice(0, 8)])),
    [vendedores],
  );
  const vendedoresPresentes = React.useMemo(() => {
    const ids = new Set(linhasRadar.map((l) => l.vendedor_user_id).filter((v): v is string => !!v));
    return [...ids]
      .map((id) => ({ id, nome: nomesVendedores.get(id) ?? id.slice(0, 8) }))
      .sort((a, b) => a.nome.localeCompare(b.nome, "pt-BR"));
  }, [linhasRadar, nomesVendedores]);
  const cidades = React.useMemo(() => {
    const mapa = new Map<string, string>();
    for (const l of linhasRadar) {
      if (!l.cidade) continue;
      const chave = l.uf ? `${l.cidade}/${l.uf}` : l.cidade;
      if (!mapa.has(chave.toLowerCase())) mapa.set(chave.toLowerCase(), chave);
    }
    return [...mapa.values()].sort((a, b) => a.localeCompare(b, "pt-BR"));
  }, [linhasRadar]);

  function mudar(patch: Partial<FiltroRadar>) {
    setFiltros((f) => ({ ...f, ...patch }));
  }

  function limpar() {
    setFiltros(FILTRO_RADAR_VAZIO);
    setDrill("");
  }

  async function criarTarefa(l: LinhaRadar) {
    setTarefaEmCurso(l.contact_id);
    try {
      await apiClient.post("/api/v1/tarefas", {
        titulo: `Contatar ${l.nome} — recompra atrasada +${l.atraso_dias}d`,
        descricao: `Última compra há ${l.dias_sem_compra} dias; ticket médio ${comoMoeda(l.ticket_medio_cents, "BRL")}.`,
        contact_id: l.contact_id,
      });
      toast.success(t("Tarefa criada — aparece no quadro de tarefas."));
    } catch (e) {
      showApiError(e);
    } finally {
      setTarefaEmCurso(null);
    }
  }

  if (linhas === null) {
    return (
      <div className="space-y-4" aria-live="polite">
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-24 w-full" />
          ))}
        </div>
        <Skeleton className="h-64 w-full" />
        <Skeleton className="h-16 w-full" />
      </div>
    );
  }

  if (falhou && linhas.length === 0) {
    return (
      <Card className="p-8 text-center">
        <p className="font-medium">{t("Não consegui ler os pedidos.")}</p>
        <p className="mt-1 text-sm text-muted-foreground">
          {t("Verifique a conexão e tente de novo.")}
        </p>
        <Button className="mt-4" onClick={() => void carregar()}>
          {t("Tentar novamente")}
        </Button>
      </Card>
    );
  }

  const r = resumo ?? agregarRadar([], hoje);
  const donut = [
    { nome: t("No prazo"), valor: r.recompra.noPrazo, cor: "#33c758", situacao: "" },
    {
      nome: t("Atrasados"),
      valor: r.recompra.atrasados,
      cor: "#ffa600",
      situacao: "recompra_atrasada",
    },
    {
      nome: t("Muito atrasados"),
      valor: r.recompra.muitoAtrasados,
      cor: "#ff3e00",
      situacao: "em_risco",
    },
    {
      nome: t("Compra única"),
      valor: r.recompra.primeiraCompra,
      cor: "#999999",
      situacao: "primeira_compra",
    },
  ].filter((d) => d.valor > 0);
  const totalDonut = donut.reduce((s, d) => s + d.valor, 0) || 1;

  const barrasRisco = (Object.keys(COR_NIVEL) as NivelRadar[]).map((n) => ({
    nivel: n,
    rotulo: ROTULO_NIVEL[n],
    qtd: r.distrib[n],
    cor: COR_NIVEL[n],
  }));
  const maxBarra = Math.max(1, ...barrasRisco.map((b) => b.qtd));

  const top = r.ranking.slice(0, 5);
  const semFiltro = JSON.stringify(filtros) === JSON.stringify(FILTRO_RADAR_VAZIO);

  return (
    <div className="space-y-6">
      {/* Filtros que funcionam: tudo abaixo (KPIs, gráficos, ranking) deriva das linhas filtradas. */}
      <Card className="space-y-3 p-4">
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <div className="space-y-1.5">
            <Label htmlFor="radar-busca">{t("Buscar cliente")}</Label>
            <Input
              id="radar-busca"
              value={filtros.busca}
              onChange={(e) => mudar({ busca: e.target.value })}
              placeholder={t("nome ou telefone…")}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="radar-vendedor">{t("Vendedor")}</Label>
            <select
              id="radar-vendedor"
              className="h-10 w-full rounded-lg border bg-background px-3 text-sm"
              value={filtros.vendedor}
              onChange={(e) => mudar({ vendedor: e.target.value })}
            >
              <option value="">{t("Todos")}</option>
              {vendedoresPresentes.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.nome}
                </option>
              ))}
            </select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="radar-cidade">{t("Cidade")}</Label>
            <Input
              id="radar-cidade"
              value={filtros.cidade}
              onChange={(e) => mudar({ cidade: e.target.value })}
              placeholder="Joinville"
              list="radar-cidades"
            />
            <datalist id="radar-cidades">
              {cidades.map((c) => (
                <option key={c} value={c} />
              ))}
            </datalist>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="radar-periodo">{t("Sem compra há até")}</Label>
            <select
              id="radar-periodo"
              className="h-10 w-full rounded-lg border bg-background px-3 text-sm"
              value={filtros.periodoDias == null ? "" : String(filtros.periodoDias)}
              onChange={(e) =>
                mudar({ periodoDias: e.target.value === "" ? null : Number(e.target.value) })
              }
            >
              <option value="">{t("Qualquer período")}</option>
              <option value="30">30 {t("dias")}</option>
              <option value="60">60 {t("dias")}</option>
              <option value="90">90 {t("dias")}</option>
            </select>
          </div>
          <div className="space-y-1.5">
            <Label>{t("Nível")}</Label>
            <div className="flex flex-wrap gap-1.5">
              {(Object.keys(ROTULO_NIVEL) as NivelRadar[]).map((n) => {
                const ativo = filtros.niveis.includes(n);
                return (
                  <button
                    key={n}
                    type="button"
                    aria-pressed={ativo}
                    onClick={() =>
                      mudar({
                        niveis: ativo
                          ? filtros.niveis.filter((x) => x !== n)
                          : [...filtros.niveis, n],
                      })
                    }
                    className={`rounded-full border px-2.5 py-1 text-xs font-medium transition-colors ${ativo ? "border-transparent bg-accent text-accent-foreground" : "hover:border-accent"}`}
                  >
                    {ROTULO_NIVEL[n]}
                  </button>
                );
              })}
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="radar-diasmin">{t("Parados há ao menos (dias)")}</Label>
            <Input
              id="radar-diasmin"
              type="number"
              min={0}
              value={filtros.diasMin === 0 ? "" : filtros.diasMin}
              onChange={(e) => mudar({ diasMin: Math.max(0, Number(e.target.value) || 0) })}
              placeholder="0"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="radar-ticketmin">{t("Ticket a partir de (R$)")}</Label>
            <Input
              id="radar-ticketmin"
              type="number"
              min={0}
              value={filtros.ticketMinCents === 0 ? "" : Math.round(filtros.ticketMinCents / 100)}
              onChange={(e) =>
                mudar({
                  ticketMinCents: Math.max(0, Math.round((Number(e.target.value) || 0) * 100)),
                })
              }
              placeholder="0"
            />
          </div>
          <div className="flex items-end gap-2">
            <Button variant="outline" onClick={() => void carregar()}>
              {t("Atualizar")}
            </Button>
            <Button variant="ghost" onClick={limpar}>
              {t("Limpar filtros")}
            </Button>
          </div>
        </div>
      </Card>

      {/* KPIs — clicar em risco/oportunidades leva à lista filtrada. */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Card className="p-3">
          <p className="text-xs text-muted-foreground">{t("Clientes monitorados")}</p>
          <p className="mt-1 text-2xl font-semibold text-text tabular-nums">
            {r.monitorados.toLocaleString("pt-BR")}
          </p>
          {r.semCompraValida > 0 && (
            <p className="mt-0.5 text-xs text-muted-foreground">
              +{r.semCompraValida.toLocaleString("pt-BR")} {t("sem compra válida (prospecção)")}
            </p>
          )}
        </Card>
        <button
          type="button"
          className="text-left"
          onClick={() => {
            setDrill("em_risco");
            rolarPara("radar-lista");
          }}
          aria-label={t("Ver clientes em risco")}
        >
          <Card className="h-full p-3 transition-colors hover:border-border-strong">
            <p className="text-xs text-muted-foreground">{t("Em risco")}</p>
            <p className="mt-1 text-2xl font-semibold text-text tabular-nums">
              {r.emRisco.toLocaleString("pt-BR")}
            </p>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {r.riscoPct.toLocaleString("pt-BR", { maximumFractionDigits: 1 })}% {t("da carteira")}
            </p>
          </Card>
        </button>
        <button
          type="button"
          className="text-left"
          onClick={() => {
            setDrill("recompra_atrasada");
            rolarPara("radar-lista");
          }}
          aria-label={t("Ver oportunidades de recompra")}
        >
          <Card className="h-full p-3 transition-colors hover:border-border-strong">
            <p className="text-xs text-muted-foreground">{t("Oportunidades de recompra")}</p>
            <p className="mt-1 text-2xl font-semibold text-text tabular-nums">
              {r.oportunidades.toLocaleString("pt-BR")}
            </p>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {comoMoeda(r.potencialCents, "BRL")} {t("estimados")}
            </p>
          </Card>
        </button>
        <Card className="p-3">
          <p className="text-xs text-muted-foreground">{t("Receita em risco")}</p>
          <p className="mt-1 text-2xl font-semibold text-text tabular-nums">
            {comoMoeda(r.receitaRiscoCents, "BRL")}
          </p>
          <p className="mt-0.5 text-xs text-muted-foreground">{t("ticket médio dos atrasados")}</p>
        </Card>
      </div>

      {/* Ações recomendadas hoje — as 3 prioridades por impacto. */}
      {top.length > 0 && (
        <Card className="space-y-2 p-4">
          <h2 className="text-base font-medium text-text">{t("Ações recomendadas hoje")}</h2>
          <ul className="space-y-2">
            {top.slice(0, 3).map((l, i) => (
              <li key={l.contact_id} className="flex flex-wrap items-center gap-2 text-sm">
                <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-accent text-[11px] font-medium text-accent-foreground">
                  {i + 1}
                </span>
                <Link
                  href={`/app/contacts/${l.contact_id}`}
                  className="font-medium text-primary underline-offset-4 hover:underline"
                >
                  {l.nome}
                </Link>
                <span className="text-muted-foreground">
                  +{l.atraso_dias}d · {comoMoeda(l.ticket_medio_cents, "BRL")}
                </span>
              </li>
            ))}
          </ul>
          <Button size="sm" variant="outline" onClick={() => rolarPara("radar-oportunidades")}>
            {t("Ver todas")}
          </Button>
        </Card>
      )}

      {/* Categorias — risco, recompra, oportunidade, follow-up, perda, cobrança. */}
      <RadarCategorias
        linhas={filtradas}
        nomesVendedores={nomesVendedores}
        risco={risco}
        montarZap={zapHref}
        onCriarTarefa={(l) => void criarTarefa(l)}
        tarefaEmCurso={tarefaEmCurso}
      />

      {/* Saúde da carteira — eventos de compra reais por semana (até 4/cliente). */}
      <Card className="p-4">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <div>
            <h2 className="text-base font-medium text-text">{t("Saúde da carteira")}</h2>
            <p className="text-xs text-muted-foreground">
              {t("Eventos de compra por semana — 12 últimas semanas.")}
            </p>
          </div>
          <div className="flex gap-1.5">
            {(["compras", "clientes"] as const).map((m) => (
              <button
                key={m}
                type="button"
                aria-pressed={metricaSaude === m}
                onClick={() => setMetricaSaude(m)}
                className={`rounded-full border px-2.5 py-1 text-xs font-medium ${metricaSaude === m ? "border-transparent bg-accent text-accent-foreground" : "hover:border-accent"}`}
              >
                {m === "compras" ? t("Compras") : t("Clientes")}
              </button>
            ))}
          </div>
        </div>
        {r.serie.every((s) => s.compras === 0) ? (
          <p className="py-6 text-center text-sm text-muted-foreground">
            {t("Sem eventos de compra nas últimas 12 semanas.")}
          </p>
        ) : (
          <div className="h-56">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={serieMista} margin={{ top: 4, right: 4, bottom: 0, left: -12 }}>
                <CartesianGrid stroke="#e8e8e8" vertical={false} />
                <XAxis
                  dataKey="rotulo"
                  tick={{ fontSize: 11, fill: "#666666" }}
                  axisLine={false}
                  tickLine={false}
                  interval={2}
                />
                <YAxis
                  tick={{ fontSize: 11, fill: "#666666" }}
                  axisLine={false}
                  tickLine={false}
                  allowDecimals={false}
                />
                <Tooltip
                  contentStyle={{
                    background: "#ffffff",
                    border: "1px solid #e8e8e8",
                    borderRadius: 12,
                    fontSize: 12,
                  }}
                  formatter={(v) => [v, metricaSaude === "compras" ? t("compras") : t("clientes")]}
                  labelFormatter={(l) => `${t("Semana de")} ${l}`}
                />
                <Bar dataKey={metricaSaude} fill="#7e77f0" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        )}
      </Card>

      <div className="grid gap-3 lg:grid-cols-2">
        {/* Recompra — clicar filtra a lista. */}
        <Card className="p-4">
          <h2 className="text-base font-medium text-text">{t("Recompra")}</h2>
          <p className="text-xs text-muted-foreground">
            {t("Clique numa fatia para filtrar a lista.")}
          </p>
          {totalDonut === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">
              {t("Sem dados de ciclo.")}
            </p>
          ) : (
            <div className="h-56">
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie
                    data={donut}
                    dataKey="valor"
                    nameKey="nome"
                    innerRadius="55%"
                    outerRadius="85%"
                    paddingAngle={2}
                    onClick={(d) => {
                      const situacao = (d as unknown as { situacao?: string })?.situacao ?? "";
                      setDrill(situacao);
                      rolarPara("radar-lista");
                    }}
                    className="cursor-pointer outline-hidden"
                  >
                    {donut.map((d) => (
                      <Cell key={d.nome} fill={d.cor} />
                    ))}
                  </Pie>
                  <Tooltip
                    contentStyle={{
                      background: "#ffffff",
                      border: "1px solid #e8e8e8",
                      borderRadius: 12,
                      fontSize: 12,
                    }}
                    formatter={(v, nome) => [
                      `${v} (${((Number(v) / totalDonut) * 100).toLocaleString("pt-BR", { maximumFractionDigits: 0 })}%)`,
                      nome,
                    ]}
                  />
                  <Legend wrapperStyle={{ fontSize: 12 }} />
                </PieChart>
              </ResponsiveContainer>
            </div>
          )}
        </Card>

        {/* Risco — distribuição por nível. */}
        <Card className="p-4">
          <h2 className="text-base font-medium text-text">{t("Risco de carteira")}</h2>
          <p className="text-xs text-muted-foreground">
            {t("Pelo comportamento de cada cliente, não por dia fixo.")}
          </p>
          <ul className="mt-3 space-y-2">
            {barrasRisco.map((b) => (
              <li key={b.nivel} className="text-sm">
                <div className="flex justify-between gap-2">
                  <button
                    type="button"
                    className="font-medium underline-offset-4 hover:underline"
                    onClick={() => {
                      mudar({ niveis: [b.nivel] });
                      rolarPara("radar-oportunidades");
                    }}
                  >
                    {b.rotulo}
                  </button>
                  <span className="text-muted-foreground tabular-nums">{b.qtd}</span>
                </div>
                <div className="mt-1 h-2 overflow-hidden rounded-full bg-muted">
                  <div
                    className="h-full rounded-full"
                    style={{ width: `${(b.qtd / maxBarra) * 100}%`, background: b.cor }}
                  />
                </div>
              </li>
            ))}
          </ul>
        </Card>
      </div>

      {/* Oportunidades de hoje — ranking por score, com ação. */}
      <div id="radar-oportunidades" className="scroll-mt-20 space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-base font-medium text-text">{t("Oportunidades de hoje")}</h2>
          {!semFiltro && (
            <Button size="sm" variant="ghost" onClick={limpar}>
              {t("Limpar filtros")} ({filtradas.length})
            </Button>
          )}
        </div>
        {top.length === 0 ? (
          filtradas.length === 0 && !semFiltro ? (
            <EmptyFilterResults primary={{ label: t("Limpar filtros"), onClick: limpar }} />
          ) : (
            <Card className="p-8 text-center">
              <p className="font-medium">{t("Tudo tranquilo por aqui")}</p>
              <p className="mt-1 text-sm text-muted-foreground">
                {t("Nenhum cliente atrasado no recorte atual.")}
              </p>
            </Card>
          )
        ) : (
          <ul className="grid gap-3 lg:grid-cols-2">
            {top.map((l) => {
              const intervalo = intervaloTipicoDe(l);
              const zap = zapHref(l.fone, l.nome, l.atraso_dias, intervalo);
              const vendedor = l.vendedor_user_id
                ? (nomesVendedores.get(l.vendedor_user_id) ?? null)
                : null;
              return (
                <li key={l.contact_id}>
                  <Card className="h-full space-y-2 p-4">
                    <div className="flex flex-wrap items-center gap-2">
                      <Link
                        href={`/app/contacts/${l.contact_id}`}
                        className="font-medium text-primary underline-offset-4 hover:underline"
                      >
                        {l.nome}
                      </Link>
                      <Badge variant={VARIANTE_NIVEL[l.nivel]}>{ROTULO_NIVEL[l.nivel]}</Badge>
                      <span className="ml-auto text-xs text-muted-foreground tabular-nums">
                        score {l.score}
                      </span>
                    </div>
                    <p className="text-sm text-muted-foreground tabular-nums">
                      {t("Última compra há")} {l.dias_sem_compra}d
                      {intervalo != null && (
                        <>
                          {" "}
                          · {t("padrão a cada")} ~{Math.round(intervalo)}d
                        </>
                      )}{" "}
                      · +{l.atraso_dias}d
                    </p>
                    <p className="text-sm text-muted-foreground">
                      {t("Ticket médio")} {comoMoeda(l.ticket_medio_cents, "BRL")} ·{" "}
                      {t("potencial")} {comoMoeda(l.ticket_medio_cents, "BRL")}
                      {[l.cidade && l.uf ? `${l.cidade}/${l.uf}` : l.cidade, vendedor]
                        .filter(Boolean)
                        .join(" · ") !== "" && (
                        <>
                          {" "}
                          ·{" "}
                          {[l.cidade && l.uf ? `${l.cidade}/${l.uf}` : l.cidade, vendedor]
                            .filter(Boolean)
                            .join(" · ")}
                        </>
                      )}
                    </p>
                    <div className="flex flex-wrap gap-2">
                      <Button size="sm" variant="outline" asChild>
                        <Link href={`/app/contacts/${l.contact_id}`}>{t("Abrir cliente")}</Link>
                      </Button>
                      {zap && (
                        <Button size="sm" variant="outline" asChild>
                          <a href={zap} target="_blank" rel="noopener noreferrer">
                            WhatsApp
                          </a>
                        </Button>
                      )}
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={tarefaEmCurso === l.contact_id}
                        onClick={() => void criarTarefa(l)}
                      >
                        {tarefaEmCurso === l.contact_id ? t("Criando…") : t("Criar tarefa")}
                      </Button>
                    </div>
                  </Card>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {/* Todos os alertas — a lista clássica (o e2e lê dela). */}
      <div id="radar-lista" className="scroll-mt-20 space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-base font-medium text-text">{t("Todos os alertas de recompra")}</h2>
          {drill !== "" && (
            <Button size="sm" variant="ghost" onClick={() => setDrill("")}>
              {t("Limpar filtro do gráfico")}:{" "}
              {ROTULO_RECOMPRA[drill as keyof typeof ROTULO_RECOMPRA] ?? drill}
            </Button>
          )}
        </div>
        <RecompraRadarList situacaoExterna={drill} onSituacaoExternaChange={setDrill} />
      </div>

      {/* Inativos — top recuperável + rota para a recuperação completa. */}
      <Card className="space-y-2 p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-base font-medium text-text">{t("Maiores chances de recuperação")}</h2>
          <Button size="sm" variant="outline" asChild>
            <Link href="/app/recuperacao">{t("Abrir recuperação")}</Link>
          </Button>
        </div>
        {inativos === null ? (
          <Skeleton className="h-10 w-full" />
        ) : inativos.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            {t("Ninguém inativo há 90 dias. Boas vendas!")}
          </p>
        ) : (
          <ul className="divide-y divide-border">
            {inativos.map((c) => {
              const zap = linkWhatsAppRecuperacao(c.telefone, c.nome, c.dias_sem_compra);
              return (
                <li key={c.contact_id} className="flex flex-wrap items-center gap-2 py-2 text-sm">
                  <Link
                    href={`/app/contacts/${c.contact_id}`}
                    className="font-medium text-primary underline-offset-4 hover:underline"
                  >
                    {c.nome}
                  </Link>
                  <span className="text-muted-foreground tabular-nums">
                    {c.dias_sem_compra}d · {comoMoeda(c.total_historico_cents, "BRL")}
                  </span>
                  <span className="ml-auto flex gap-2">
                    {zap && (
                      <Button size="sm" variant="outline" asChild>
                        <a href={zap} target="_blank" rel="noopener noreferrer">
                          WhatsApp
                        </a>
                      </Button>
                    )}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </Card>

      {/* Demandas — funcionalidade existente, intacta, com o cabeçalho que o e2e espera. */}
      <div id="radar-demandas" className="scroll-mt-20 space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-base font-medium text-text">{t("Radar de risco")}</h2>
          {risco && risco.total > 0 && (
            <span className="text-xs text-muted-foreground tabular-nums">
              {risco.total} {t("demandas no radar")}
            </span>
          )}
        </div>
        <RiskRadarList />
      </div>
    </div>
  );
}
