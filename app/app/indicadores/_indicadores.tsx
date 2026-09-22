"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Line,
  LineChart,
  Pie,
  PieChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import { Card } from "@/components/ui/card";
import { apiClient } from "@/lib/api/client";
import { showApiError } from "@/components/feedback/ApiErrorToast";
import { useT } from "@/hooks/i18n/useT";
import { comoMoeda } from "@/lib/format/moeda";
import { Saudacao } from "./_saudacao";
import { Briefing } from "./_briefing";
import { Funil } from "./_funil";
import { Atividade } from "./_atividade";

export interface DadosIndicadores {
  mes: string;
  rotuloMes: string;
  serie: {
    dia: number;
    vendas: number;
    vendaAc: number;
    metaAc: number | null;
    mesAnt: number | null;
    mesAno: number | null;
    projecao: number | null;
  }[];
  vendidoMes: number;
  qtdMes: number;
  vendidoHoje: number;
  objetivo: number | null;
  pctObjetivo: number | null;
  necessarioDia: number | null;
  diasUteisRestantes: number;
  previsaoMes: number;
  faturado: number;
  naoFaturado: number;
  carteira: {
    ativos: number;
    inativosRecentes: number;
    inativosAntigos: number;
    prospects: number;
    cicloDias: number;
    total: number;
  };
  positivacao: { compraram: number; base: number; pct: number };
  abc: { faixas: { faixa: string; clientes: number; cents: number; pct: number }[]; total: number };
  ranking: {
    id: string;
    nome: string;
    total: number;
    qtd: number;
    ticket: number;
    clientes: number;
    meta: number | null;
    pctMeta: number | null;
  }[];
  filtroVendedor: string;
  vendedores: { id: string; nome: string }[];
  cortado: boolean;
}

function brl(cents: number): string {
  return comoMoeda(cents, "BRL");
}

function Barra({ pct, cor }: { pct: number | null; cor: string }) {
  const v = pct == null ? 0 : Math.min(100, Math.max(0, pct));
  return (
    <div
      className="h-2 w-full overflow-hidden rounded-full bg-muted"
      role="progressbar"
      aria-valuenow={Math.round(v)}
    >
      <div className={`${cor} h-full rounded-full`} style={{ width: `${v}%` }} />
    </div>
  );
}

const CORES_CARTEIRA = ["#16a34a", "#eab308", "#dc2626", "#9ca3af"];

/** O "Indicador IA": pergunta livre respondida com os agregados do mês + gráfico. */
function PerguntarIA({ mes }: { mes: string }) {
  const t = useT();
  const sugestoes = [
    t("Quem vendeu mais este mês?"),
    t("Como está a carteira de clientes?"),
    t("Compare o faturado com o não faturado"),
  ];
  const [pergunta, setPergunta] = React.useState("");
  const [carregando, setCarregando] = React.useState(false);
  const [resposta, setResposta] = React.useState<string | null>(null);
  const [grafico, setGrafico] = React.useState<{
    tipo: "barras" | "pizza" | "linha";
    titulo: string;
    dados: { rotulo: string; valor_cents: number }[];
  } | null>(null);

  async function perguntar(texto: string) {
    const q = texto.trim();
    if (q.length < 2 || carregando) return;
    setCarregando(true);
    setResposta(null);
    setGrafico(null);
    try {
      const corpo = await apiClient.post<{
        data: {
          resposta: string;
          grafico: {
            tipo: "barras" | "pizza" | "linha";
            titulo: string;
            dados: { rotulo: string; valor_cents: number }[];
          } | null;
        };
      }>("/api/v1/indicadores/perguntar", { pergunta: q, ano_mes: mes });
      setResposta(corpo.data.resposta);
      setGrafico(corpo.data.grafico);
    } catch (e) {
      showApiError(e);
    } finally {
      setCarregando(false);
    }
  }

  return (
    <Card className="space-y-3 p-4">
      <p className="text-sm font-semibold tracking-wide">{t("INDICADOR IA")}</p>
      <div className="flex gap-2">
        <input
          value={pergunta}
          onChange={(e) => setPergunta(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void perguntar(pergunta);
          }}
          placeholder={t("Pergunte algo… ex: quem vendeu mais este mês?")}
          className="h-9 flex-1 rounded-lg border bg-background px-3 text-sm"
        />
        <button
          type="button"
          disabled={carregando || pergunta.trim().length < 2}
          onClick={() => void perguntar(pergunta)}
          className="h-9 rounded-lg border bg-background px-3 text-sm underline underline-offset-4 disabled:opacity-50"
        >
          {carregando ? t("Pensando…") : t("Perguntar")}
        </button>
      </div>
      <div className="flex flex-wrap gap-2">
        {sugestoes.map((s) => (
          <button
            key={s}
            type="button"
            onClick={() => {
              setPergunta(s);
              void perguntar(s);
            }}
            className="rounded-full border px-3 py-1 text-xs underline underline-offset-4"
          >
            {s}
          </button>
        ))}
      </div>
      {resposta && <p className="text-sm">{resposta}</p>}
      {grafico && grafico.dados.length > 0 && (
        <div>
          <p className="mb-2 text-sm font-medium">{grafico.titulo}</p>
          <div className="h-56">
            <ResponsiveContainer width="100%" height="100%">
              {grafico.tipo === "pizza" ? (
                <PieChart>
                  <Pie
                    data={grafico.dados}
                    dataKey="valor_cents"
                    nameKey="rotulo"
                    innerRadius={48}
                    outerRadius={72}
                    paddingAngle={2}
                  >
                    {grafico.dados.map((_, i) => (
                      <Cell key={i} fill={CORES_CARTEIRA[i % CORES_CARTEIRA.length]} />
                    ))}
                  </Pie>
                  <Tooltip formatter={(v) => brl(Math.round(Number(v ?? 0)))} />
                  <Legend />
                </PieChart>
              ) : grafico.tipo === "linha" ? (
                <LineChart data={grafico.dados} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" opacity={0.4} />
                  <XAxis
                    dataKey="rotulo"
                    tick={{ fontSize: 11 }}
                    interval={0}
                    angle={-20}
                    height={52}
                  />
                  <YAxis
                    tickFormatter={(v: number) => `${Math.round(v / 100 / 1000)}k`}
                    tick={{ fontSize: 11 }}
                    width={44}
                  />
                  <Tooltip formatter={(v) => brl(Math.round(Number(v ?? 0)))} />
                  <Line
                    type="monotone"
                    dataKey="valor_cents"
                    name="Valor"
                    stroke="#16a34a"
                    strokeWidth={2}
                    dot={false}
                  />
                </LineChart>
              ) : (
                <BarChart data={grafico.dados} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" opacity={0.4} />
                  <XAxis
                    dataKey="rotulo"
                    tick={{ fontSize: 11 }}
                    interval={0}
                    angle={-20}
                    height={52}
                  />
                  <YAxis
                    tickFormatter={(v: number) => `${Math.round(v / 100 / 1000)}k`}
                    tick={{ fontSize: 11 }}
                    width={44}
                  />
                  <Tooltip formatter={(v) => brl(Math.round(Number(v ?? 0)))} />
                  <Bar dataKey="valor_cents" name="Valor" fill="#2563eb" radius={[4, 4, 0, 0]} />
                </BarChart>
              )}
            </ResponsiveContainer>
          </div>
        </div>
      )}
    </Card>
  );
}

export function IndicadoresClient({
  dados,
  nome,
  hora,
}: {
  dados: DadosIndicadores;
  nome: string | null;
  hora: number;
}) {
  const router = useRouter();
  const t = useT();
  const [mes, setMes] = React.useState(dados.mes);
  const [vendedor, setVendedor] = React.useState(dados.filtroVendedor);
  const [comparar, setComparar] = React.useState(false);
  const [paineis, setPaineis] = React.useState<{ nome: string; mes: string; vendedor: string }[]>(
    () => {
      try {
        const cru =
          typeof window === "undefined" ? null : window.localStorage.getItem("indicadores-paineis");
        return cru ? (JSON.parse(cru) as { nome: string; mes: string; vendedor: string }[]) : [];
      } catch {
        return [];
      }
    },
  );
  const [nomePainel, setNomePainel] = React.useState("");

  function gravarPaineis(prox: { nome: string; mes: string; vendedor: string }[]) {
    setPaineis(prox);
    try {
      window.localStorage.setItem("indicadores-paineis", JSON.stringify(prox));
    } catch {
      // Cortesia, nunca erro.
    }
  }

  function aplicar(novoMes: string, novoVendedor: string) {
    const qs = new URLSearchParams();
    if (novoMes) qs.set("mes", novoMes);
    if (novoVendedor) qs.set("vendedor", novoVendedor);
    router.push(`/app/indicadores${qs.toString() ? `?${qs}` : ""}`);
  }

  const donut = [
    { nome: t("Ativos"), valor: dados.carteira.ativos },
    { nome: t("Inativos recentes"), valor: dados.carteira.inativosRecentes },
    { nome: t("Inativos antigos"), valor: dados.carteira.inativosAntigos },
    { nome: t("Prospects"), valor: dados.carteira.prospects },
  ];
  const totalFaturamento = dados.faturado + dados.naoFaturado;

  return (
    <div className="space-y-4 p-4 sm:space-y-6 sm:p-6">
      <Saudacao nome={nome} hora={hora} dados={dados} />

      <Briefing necessarioDia={dados.necessarioDia} />

      <PerguntarIA mes={dados.mes} />

      <div className="grid gap-4 lg:grid-cols-2">
        <Funil />
        <Atividade />
      </div>

      {/* Filtros: mês e vendedor, como no Mercos. */}
      <div className="flex flex-wrap items-end gap-3">
        <label className="block text-sm">
          <span className="mb-1 block text-muted-foreground">{t("Mês")}</span>
          <input
            type="month"
            value={mes}
            onChange={(e) => {
              setMes(e.target.value);
              aplicar(e.target.value, vendedor);
            }}
            className="h-9 rounded-lg border bg-background px-3"
          />
        </label>
        <label className="block text-sm">
          <span className="mb-1 block text-muted-foreground">{t("Vendedor")}</span>
          <select
            value={vendedor}
            onChange={(e) => {
              setVendedor(e.target.value);
              aplicar(mes, e.target.value);
            }}
            className="h-9 rounded-lg border bg-background px-3"
          >
            <option value="">{t("Todos os vendedores")}</option>
            {dados.vendedores.map((v) => (
              <option key={v.id} value={v.id}>
                {v.nome}
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-2 pb-2 text-sm">
          <input
            type="checkbox"
            checked={comparar}
            onChange={(e) => setComparar(e.target.checked)}
          />
          {t("Comparar com mês anterior e ano passado")}
        </label>
      </div>
      {paineis.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {paineis.map((p) => (
            <span
              key={p.nome}
              className="inline-flex items-center gap-1 rounded-full border px-3 py-1 text-xs"
            >
              <button
                type="button"
                className="underline underline-offset-4"
                onClick={() => {
                  setMes(p.mes);
                  setVendedor(p.vendedor);
                  aplicar(p.mes, p.vendedor);
                }}
              >
                {p.nome}
              </button>
              <button
                type="button"
                aria-label={`Excluir painel ${p.nome}`}
                className="text-muted-foreground"
                onClick={() => gravarPaineis(paineis.filter((x) => x.nome !== p.nome))}
              >
                ×
              </button>
            </span>
          ))}
        </div>
      )}
      <div className="flex flex-wrap items-end gap-3">
        <label className="block text-sm">
          <span className="mb-1 block text-muted-foreground">
            {t("Salvar esta vista como painel")}
          </span>
          <span className="flex gap-2">
            <input
              value={nomePainel}
              onChange={(e) => setNomePainel(e.target.value)}
              placeholder={t("Nome do painel…")}
              className="h-9 rounded-lg border bg-background px-3"
            />
            <button
              type="button"
              disabled={!nomePainel.trim()}
              onClick={() => {
                gravarPaineis([
                  ...paineis.filter((x) => x.nome !== nomePainel.trim()),
                  { nome: nomePainel.trim(), mes, vendedor },
                ]);
                setNomePainel("");
              }}
              className="h-9 rounded-lg border bg-background px-3 text-sm underline underline-offset-4 disabled:opacity-50"
            >
              {t("Salvar painel")}
            </button>
          </span>
        </label>
      </div>

      {/* EVOLUÇÃO DE VENDA */}
      <Card className="p-4">
        <div className="mb-3 flex items-center justify-between">
          <p className="text-sm font-semibold tracking-wide">{t("EVOLUÇÃO DE VENDA")}</p>
          <p className="text-xs text-muted-foreground uppercase">{dados.rotuloMes}</p>
        </div>
        <div className="grid gap-4 lg:grid-cols-[1fr_260px]">
          <div className="h-64">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={dados.serie} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" opacity={0.4} />
                <XAxis dataKey="dia" tick={{ fontSize: 11 }} interval={2} />
                <YAxis
                  tickFormatter={(v: number) => `${Math.round(v / 100 / 1000)}k`}
                  tick={{ fontSize: 11 }}
                  width={44}
                />
                <Tooltip
                  formatter={(v) => brl(Math.round(Number(v ?? 0)))}
                  labelFormatter={(d) => `${t("Dia")} ${d}`}
                />
                <Legend />
                <Line
                  type="monotone"
                  dataKey="vendaAc"
                  name={t("Vendas no mês")}
                  stroke="#16a34a"
                  strokeWidth={2}
                  dot={false}
                />
                {dados.serie.some((s) => s.metaAc != null) && (
                  <Line
                    type="monotone"
                    dataKey="metaAc"
                    name={t("Objetivo")}
                    stroke="#7c3aed"
                    strokeDasharray="6 3"
                    strokeWidth={2}
                    dot={false}
                  />
                )}
                {/* Simulação do fechamento: continua de hoje até o fim do mês no
                    ritmo médio. Amarelo como a linha de Previsão — mesma conta. */}
                {dados.serie.some((s) => s.projecao != null) && (
                  <Line
                    type="monotone"
                    dataKey="projecao"
                    name={t("Projeção")}
                    stroke="#eab308"
                    strokeDasharray="6 3"
                    strokeWidth={2}
                    dot={false}
                  />
                )}
                {comparar && (
                  <>
                    <Line
                      type="monotone"
                      dataKey="mesAnt"
                      name={t("Mês anterior")}
                      stroke="#94a3b8"
                      strokeDasharray="6 3"
                      strokeWidth={2}
                      dot={false}
                    />
                    <Line
                      type="monotone"
                      dataKey="mesAno"
                      name={t("Ano passado")}
                      stroke="#cbd5e1"
                      strokeDasharray="2 3"
                      strokeWidth={2}
                      dot={false}
                    />
                  </>
                )}
                <ReferenceLine
                  y={dados.previsaoMes}
                  stroke="#eab308"
                  strokeDasharray="4 3"
                  label={{ value: t("Previsão"), fontSize: 11 }}
                />
              </LineChart>
            </ResponsiveContainer>
          </div>
          <div className="space-y-4">
            <div>
              <p className="text-xs text-muted-foreground uppercase">{t("Vendido no mês")}</p>
              <p className="text-2xl font-semibold tabular-nums">{brl(dados.vendidoMes)}</p>
              <p className="text-xs text-muted-foreground">
                {t("Hoje")} {brl(dados.vendidoHoje)} · {dados.qtdMes} {t("pedidos")}
              </p>
            </div>
            <div>
              <div className="flex items-center justify-between">
                <p className="text-xs text-muted-foreground uppercase">{t("Objetivo do mês")}</p>
                {dados.objetivo == null && (
                  <Link href="/app/relatorios" className="text-xs underline underline-offset-4">
                    {t("Definir metas")}
                  </Link>
                )}
              </div>
              <p className="text-2xl font-semibold tabular-nums">
                {dados.objetivo != null ? brl(dados.objetivo) : "—"}
              </p>
              <div className="mt-1">
                <Barra pct={dados.pctObjetivo} cor="bg-violet-500" />
              </div>
              <p className="mt-1 text-xs text-muted-foreground">
                {dados.pctObjetivo != null
                  ? `${dados.pctObjetivo.toFixed(1)}% ${t("da meta")}`
                  : t("Nenhuma meta definida")}
              </p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground uppercase">{t("Necessário vender")}</p>
              <p className="text-lg font-semibold tabular-nums">
                {dados.necessarioDia != null
                  ? `${brl(Math.round(dados.necessarioDia))} ${t("por dia útil")}`
                  : "—"}
              </p>
              <p className="text-xs text-muted-foreground">
                {dados.diasUteisRestantes} {t("dias úteis restantes")}
              </p>
            </div>
          </div>
        </div>
        <div className="mt-2 border-t pt-2 text-center">
          <Link href="/app/pedidos" className="text-sm underline underline-offset-4">
            {t("Detalhar por vendedor")}
          </Link>
        </div>
      </Card>

      <div className="grid gap-4 lg:grid-cols-3">
        {/* CARTEIRA */}
        <Card className="p-4">
          <p className="mb-1 text-sm font-semibold tracking-wide">{t("CARTEIRA DE CLIENTES")}</p>
          <p className="mb-3 text-center text-3xl font-semibold tabular-nums">
            {dados.carteira.total}
            <span className="block text-xs font-normal text-muted-foreground">{t("clientes")}</span>
          </p>
          <div className="h-48">
            <ResponsiveContainer width="100%" height="100%">
              <PieChart>
                <Pie
                  data={donut}
                  dataKey="valor"
                  nameKey="nome"
                  innerRadius={52}
                  outerRadius={72}
                  paddingAngle={2}
                >
                  {donut.map((_, i) => (
                    <Cell key={i} fill={CORES_CARTEIRA[i % CORES_CARTEIRA.length]} />
                  ))}
                </Pie>
                <Tooltip />
                <Legend />
              </PieChart>
            </ResponsiveContainer>
          </div>
          <ul className="mt-2 space-y-1 text-sm">
            <li className="flex justify-between">
              <span>{t("Ativos")}</span>
              <strong className="tabular-nums">{dados.carteira.ativos}</strong>
            </li>
            <li className="flex justify-between">
              <span>{t("Inativos recentes")}</span>
              <strong className="tabular-nums">{dados.carteira.inativosRecentes}</strong>
            </li>
            <li className="flex justify-between">
              <span>{t("Inativos antigos")}</span>
              <strong className="tabular-nums">{dados.carteira.inativosAntigos}</strong>
            </li>
            <li className="flex justify-between">
              <span>{t("Prospects")}</span>
              <strong className="tabular-nums">{dados.carteira.prospects}</strong>
            </li>
          </ul>
          <p className="mt-2 text-xs text-muted-foreground">
            {t("Ciclo médio")}: {dados.carteira.cicloDias} {t("dias")}
          </p>
          <Link
            href="/app/carteira"
            className="mt-1 inline-block text-sm underline underline-offset-4"
          >
            {t("Detalhar carteira")}
          </Link>
        </Card>

        {/* POSITIVAÇÃO + FATURADO */}
        <Card className="space-y-4 p-4">
          <div>
            <p className="text-sm font-semibold tracking-wide">{t("POSITIVAÇÃO")}</p>
            <p className="mt-1 text-2xl font-semibold tabular-nums">
              {dados.positivacao.pct.toFixed(1)} %
            </p>
            <p className="text-xs text-muted-foreground">
              {dados.positivacao.compraram} {t("de")} {dados.positivacao.base}{" "}
              {t("clientes compraram no mês")}
            </p>
            <div className="mt-1">
              <Barra pct={dados.positivacao.pct} cor="bg-green-500" />
            </div>
          </div>
          <div className="border-t pt-4">
            <p className="text-sm font-semibold tracking-wide">{t("FATURADO X NÃO FATURADO")}</p>
            <div className="mt-2 space-y-1 text-sm">
              <div className="flex justify-between">
                <span>{t("Faturado")}</span>
                <strong className="tabular-nums">{brl(dados.faturado)}</strong>
              </div>
              <div className="mt-1">
                <Barra
                  pct={totalFaturamento > 0 ? (dados.faturado / totalFaturamento) * 100 : 0}
                  cor="bg-success"
                />
              </div>
              <div className="flex justify-between">
                <span>{t("Não faturado")}</span>
                <strong className="tabular-nums">{brl(dados.naoFaturado)}</strong>
              </div>
            </div>
            <div className="mt-2 flex gap-3 text-sm">
              <Link href="/app/faturamento" className="underline underline-offset-4">
                {t("Ver faturamento")}
              </Link>
              <Link href="/app/titulos" className="underline underline-offset-4">
                {t("Ver títulos")}
              </Link>
            </div>
          </div>
          <div className="border-t pt-4">
            <p className="text-sm font-semibold tracking-wide">{t("PREVISÃO DE FECHAMENTO")}</p>
            <p className="mt-1 text-2xl font-semibold tabular-nums">{brl(dados.previsaoMes)}</p>
            <p className="text-xs text-muted-foreground">{t("Ritmo diário projetado no mês")}</p>
          </div>
        </Card>

        {/* CURVA ABC */}
        <Card className="p-4">
          <p className="mb-3 text-sm font-semibold tracking-wide">{t("CURVA ABC DE CLIENTES")}</p>
          <div className="space-y-3">
            {dados.abc.faixas.map((f, i) => (
              <div key={f.faixa}>
                <div className="flex justify-between text-sm">
                  <span className="font-medium">
                    {t("Curva")} {f.faixa}
                  </span>
                  <span className="text-muted-foreground tabular-nums">
                    {f.clientes} {t("clientes")} · {brl(f.cents)} ({f.pct.toFixed(1)}%)
                  </span>
                </div>
                <div className="mt-1">
                  <Barra
                    pct={f.pct}
                    cor={["bg-violet-500", "bg-sky-500", "bg-slate-400"][i % 3] ?? "bg-slate-400"}
                  />
                </div>
              </div>
            ))}
          </div>
          <p className="mt-3 text-xs text-muted-foreground">
            {t("Faturado total")}: {brl(dados.abc.total)}
          </p>
        </Card>
      </div>

      {/* RANKING */}
      <Card className="p-4">
        <div className="mb-3 flex items-center justify-between">
          <p className="text-sm font-semibold tracking-wide">
            {t("QUANTIDADE E VALOR POR VENDEDOR")}
          </p>
          <Link href="/app/comissoes" className="text-sm underline underline-offset-4">
            {t("Ver comissões")}
          </Link>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-muted-foreground">
                <th className="py-1 pr-3 font-medium">{t("Vendedor")}</th>
                <th className="py-1 pr-3 text-right font-medium">{t("Pedidos")}</th>
                <th className="py-1 pr-3 text-right font-medium">{t("Ticket médio")}</th>
                <th className="py-1 pr-3 text-right font-medium">{t("Total")}</th>
                <th className="py-1 text-right font-medium">{t("Meta")}</th>
              </tr>
            </thead>
            <tbody>
              {dados.ranking.map((r) => (
                <tr key={r.id} className="border-t">
                  <td className="py-2 pr-3 font-medium">{r.nome}</td>
                  <td className="py-2 pr-3 text-right tabular-nums">{r.qtd}</td>
                  <td className="py-2 pr-3 text-right tabular-nums">{brl(r.ticket)}</td>
                  <td className="py-2 pr-3 text-right font-semibold tabular-nums">
                    {brl(r.total)}
                  </td>
                  <td className="py-2 text-right tabular-nums">
                    {r.meta != null ? `${brl(r.meta)} (${(r.pctMeta ?? 0).toFixed(0)}%)` : "—"}
                  </td>
                </tr>
              ))}
              {dados.ranking.length === 0 && (
                <tr>
                  <td colSpan={5} className="py-4 text-center text-muted-foreground">
                    {t("Sem vendas no período.")}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </Card>

      {dados.cortado && (
        <p className="text-xs text-muted-foreground">
          {t("Janela limitada a 25 mil linhas — os totais consideram o período cortado.")}
        </p>
      )}
    </div>
  );
}
