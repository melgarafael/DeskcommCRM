"use client";

import type { FC } from "react";
import {
  LineChart,
  Line,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Legend,
  PieChart,
  Pie,
  Cell,
  BarChart,
  Bar,
} from "recharts";
import { cn } from "@/lib/utils";

/** Cores da paleta categórica (dataviz: palette.md). */
const CORES_SERIES = [
  "var(--color-accent)", // blue
  "#eb6834", // orange
  "#1baf7a", // aqua
  "#eda100", // yellow
  "#e87ba4", // magenta
];

const CORES_PIE = [
  "var(--color-accent)",
  "#eb6834",
  "#1baf7a",
  "#eda100",
  "#e87ba4",
  "#008300",
  "#6250d6",
  "#e34948",
];

/** Props comuns de gráfico. */
interface ChartContainerProps {
  children: React.ReactNode;
  titulo?: string;
  classe?: string;
  altura?: number;
}

export const ChartContainer: FC<ChartContainerProps> = ({ children, titulo, classe, altura = 260 }) => (
  <div className={cn("rounded-xl border bg-card p-4", classe)}>
    {titulo && <h3 className="text-sm font-semibold text-foreground mb-4">{titulo}</h3>}
    <div style={{ width: "100%", height: altura }}>{children}</div>
  </div>
);

/** Tooltip customizado consistente com o design system. */
const CustomTooltip = ({ active, payload, label }: { active?: boolean; payload?: Array<{ value: number; name: string; color: string; dataKey: string }>; label?: string }) => {
  if (!active || !payload || !payload.length) return null;
  return (
    <div className="rounded-md bg-popover border p-2 shadow-lg text-xs">
      <p className="font-medium text-foreground mb-1">{label}</p>
      {payload.map((item, i) => (
        <div key={i} className="flex items-center gap-1.5">
          <span className="w-2 h-2 rounded-full" style={{ backgroundColor: item.color }} />
          <span className="text-muted-foreground">{item.name}: </span>
          <span className="font-medium tabular-nums text-foreground">{item.value.toLocaleString("pt-BR")}</span>
        </div>
      ))}
    </div>
  );
};

/** Linha de publicações (publicadas vs falharam) — últimos 30 dias. */
interface PublicacoesLinhaProps {
  dados: Array<{ dia: string; publicadas: number; falharam: number }>;
  classe?: string;
}

export const PublicacoesLinha: FC<PublicacoesLinhaProps> = ({ dados, classe }) => {
  if (!dados.length) return <ChartContainer titulo="Publicações (últimos 30 dias)" classe={classe}>Sem dados</ChartContainer>;

  const formatarDia = (dia: string) => {
    const [, m, d] = dia.split("-");
    return `${d}/${m}`;
  };

  return (
    <ChartContainer titulo="Publicações (últimos 30 dias)" classe={classe} altura={260}>
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={dados} margin={{ top: 5, right: 5, left: 0, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" vertical={false} />
          <XAxis
            dataKey="dia"
            tickFormatter={formatarDia}
            tick={{ fill: "var(--color-text-muted)", fontSize: 11 }}
            axisLine={false}
            tickLine={false}
            interval="preserveStartEnd"
          />
          <YAxis
            tick={{ fill: "var(--color-text-muted)", fontSize: 11 }}
            axisLine={false}
            tickLine={false}
            tickFormatter={(v) => (v >= 1000 ? `${(v / 1000).toFixed(1)}k` : v.toString())}
            domain={[0, "dataMax + 1"]}
          />
          <Tooltip content={<CustomTooltip />} />
          <Legend
            wrapperStyle={{ paddingTop: 10 }}
            formatter={(value) => value}
            iconType="circle"
          />
          <Area
            type="monotone"
            dataKey="publicadas"
            name="Publicadas"
            stroke={CORES_SERIES[0]}
            strokeWidth={2}
            fill={CORES_SERIES[0]}
            fillOpacity={0.1}
            dot={false}
            activeDot={{ r: 4, strokeWidth: 2 }}
          />
          <Line
            type="monotone"
            dataKey="falharam"
            name="Falharam"
            stroke={CORES_SERIES[1]}
            strokeWidth={2}
            strokeDasharray="5 5"
            dot={false}
            activeDot={{ r: 4, strokeWidth: 2 }}
          />
        </LineChart>
      </ResponsiveContainer>
    </ChartContainer>
  );
};

/** Barras de tarefas concluídas — últimos 14 dias. */
interface TarefasBarrasProps {
  dados: Array<{ dia: string; concluidas: number }>;
  classe?: string;
}

export const TarefasBarras: FC<TarefasBarrasProps> = ({ dados, classe }) => {
  if (!dados.length) return <ChartContainer titulo="Tarefas concluídas (últimos 14 dias)" classe={classe}>Sem dados</ChartContainer>;

  const formatarDia = (dia: string) => {
    const [, m, d] = dia.split("-");
    return `${d}/${m}`;
  };

  // Inverter dados para mostrar do mais recente para o mais antigo (recharts não tem reversal no YAxis v3)
  const dadosInvertidos = [...dados].reverse();

  return (
    <ChartContainer titulo="Tarefas concluídas (últimos 14 dias)" classe={classe} altura={260}>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={dadosInvertidos} margin={{ top: 5, right: 5, left: 0, bottom: 0 }} layout="vertical">
          <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" horizontal={false} />
          <XAxis
            type="number"
            tick={{ fill: "var(--color-text-muted)", fontSize: 11 }}
            axisLine={false}
            tickLine={false}
            domain={[0, "dataMax + 1"]}
          />
          <YAxis
            dataKey="dia"
            type="category"
            tickFormatter={formatarDia}
            tick={{ fill: "var(--color-text-muted)", fontSize: 11 }}
            axisLine={false}
            tickLine={false}
            width={50}
          />
          <Tooltip content={<CustomTooltip />} />
          <Bar
            dataKey="concluidas"
            name="Concluídas"
            fill={CORES_SERIES[0]}
            radius={[0, 4, 4, 0]}
            maxBarSize={24}
          />
        </BarChart>
      </ResponsiveContainer>
    </ChartContainer>
  );
};

/** Pizza de situações de contratos. */
interface ContratosPizzaProps {
  dados: Array<{ situacao: string; quantidade: number; label: string }>;
  classe?: string;
}

export const ContratosPizza: FC<ContratosPizzaProps> = ({ dados, classe }) => {
  const comDados = dados.filter((d) => d.quantidade > 0);
  if (!comDados.length) return <ChartContainer titulo="Situação dos contratos" classe={classe}>Sem contratos</ChartContainer>;

  // Limitar a 8 categorias (tamanho da paleta CORES_PIE) — fold excesso em "Outros"
  // para evitar reciclar cores (violaria "categorical hues in fixed order, never cycled")
  const MAX_CATEGORIAS = CORES_PIE.length;
  const ordenados = [...comDados].sort((a, b) => b.quantidade - a.quantidade);
  let dadosParaGrafico: Array<{ situacao: string; quantidade: number; label: string }>;
  if (ordenados.length > MAX_CATEGORIAS) {
    const principais = ordenados.slice(0, MAX_CATEGORIAS - 1);
    const outrosQuantidade = ordenados.slice(MAX_CATEGORIAS - 1).reduce((s, d) => s + d.quantidade, 0);
    dadosParaGrafico = [...principais, { situacao: "outros", quantidade: outrosQuantidade, label: "Outros" }];
  } else {
    dadosParaGrafico = ordenados;
  }

  // Calcular total para porcentagem no label
  const total = dadosParaGrafico.reduce((s, d) => s + d.quantidade, 0);

  return (
    <ChartContainer titulo="Situação dos contratos" classe={classe} altura={280}>
      <ResponsiveContainer width="100%" height="100%">
        <PieChart>
          <Pie
            data={dadosParaGrafico}
            cx="50%"
            cy="50%"
            innerRadius={60}
            outerRadius={100}
            dataKey="quantidade"
            nameKey="label"
            label={({ name, value }) => `${name} ${total > 0 ? ((value / total) * 100).toFixed(0) : "0"}%`}
            labelLine={false}
            startAngle={90}
            endAngle={450}
          >
            {dadosParaGrafico.map((_, i) => (
              <Cell key={`cell-${i}`} fill={CORES_PIE[i]} />
            ))}
          </Pie>
          <Tooltip content={<CustomTooltip />} />
          <Legend
            wrapperStyle={{ paddingTop: 10 }}
            formatter={(value) => value}
            iconType="circle"
          />
        </PieChart>
      </ResponsiveContainer>
    </ChartContainer>
  );
};

/** Barras horizontais de tarefas por coluna. */
interface TarefasPorColunaProps {
  dados: Record<string, number>;
  classe?: string;
}

const ROTULOS_COLUNA: Record<string, string> = {
  backlog: "Backlog",
  a_fazer: "A fazer",
  em_andamento: "Em andamento",
  revisao: "Revisão",
  concluido: "Concluído",
};

const ORDEM_COLUNAS = ["backlog", "a_fazer", "em_andamento", "revisao", "concluido"];

export const TarefasPorColuna: FC<TarefasPorColunaProps> = ({ dados, classe }) => {
  const barras = ORDEM_COLUNAS.map((col, i) => ({
    coluna: ROTULOS_COLUNA[col] ?? col,
    quantidade: dados[col] ?? 0,
    cor: CORES_SERIES[i % CORES_SERIES.length], // ordem fixa da paleta categórica
  })).filter((b) => b.quantidade > 0);

  if (!barras.length) return <ChartContainer titulo="Tarefas por coluna" classe={classe}>Sem tarefas</ChartContainer>;

  // Inverter para mostrar na ordem correta (Backlog no topo)
  const barrasInvertidas = [...barras].reverse();

  return (
    <ChartContainer titulo="Tarefas por coluna" classe={classe} altura={220}>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={barrasInvertidas} layout="vertical" margin={{ top: 5, right: 5, left: 0, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" horizontal={false} />
          <XAxis
            type="number"
            tick={{ fill: "var(--color-text-muted)", fontSize: 11 }}
            axisLine={false}
            tickLine={false}
            domain={[0, "dataMax + 1"]}
          />
          <YAxis
            dataKey="coluna"
            type="category"
            tick={{ fill: "var(--color-text-muted)", fontSize: 11 }}
            axisLine={false}
            tickLine={false}
            width={90}
          />
          <Tooltip content={<CustomTooltip />} />
          <Bar
            dataKey="quantidade"
            fill="cor"
            radius={[0, 4, 4, 0]}
            maxBarSize={24}
          />
        </BarChart>
      </ResponsiveContainer>
    </ChartContainer>
  );
};