"use client";
import {
  ResponsiveContainer,
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
} from "recharts";
import type { UsagePayload } from "@/lib/ai/usage/aggregate";
import { formatCentsUSD } from "@/lib/money";

interface Props {
  payload: UsagePayload;
}

function formatDateTick(s: string): string {
  const d = new Date(`${s}T00:00:00Z`);
  return d.toLocaleDateString("pt-BR", {
    day: "2-digit",
    month: "2-digit",
    timeZone: "UTC",
  });
}

function formatNumber(n: number): string {
  return n.toLocaleString("pt-BR");
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}k`;
  return String(n);
}

function ChartCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-lg border bg-card p-4">
      <h3 className="mb-4 text-sm font-medium text-muted-foreground">{title}</h3>
      {children}
    </div>
  );
}

function EmptyChart() {
  return (
    <div className="flex h-[200px] items-center justify-center text-sm text-muted-foreground">
      Sem dados no período
    </div>
  );
}

const tooltipStyle = {
  borderRadius: "8px",
  fontSize: "12px",
  border: "1px solid hsl(var(--border))",
  background: "hsl(var(--popover))",
};

export function UsageChart({ payload }: Props) {
  const { series } = payload;

  // Pre-build merged latency dataset for the dual-line chart.
  const latencyData = series.p50_latency_ms.map((p, i) => ({
    day: p.day,
    p50: p.value,
    p95: series.p95_latency_ms[i]?.value ?? 0,
  }));

  const handoffData = series.handoff_rate.map((p) => ({
    day: p.day,
    pct: Number((p.value * 100).toFixed(2)),
  }));

  const hasCost = series.cost_cents.some((p) => p.value > 0);
  const hasTokens = series.total_tokens.some((p) => p.value > 0);
  const hasLatency = latencyData.some((p) => p.p50 > 0 || p.p95 > 0);
  const hasHandoff = handoffData.some((p) => p.pct > 0);

  return (
    <div className="grid gap-4 md:grid-cols-2">
      <ChartCard title="Quanto gastou por dia (USD)">
        {!hasCost ? (
          <EmptyChart />
        ) : (
          <ResponsiveContainer width="100%" height={200}>
            <LineChart
              data={series.cost_cents}
              margin={{ top: 4, right: 8, bottom: 0, left: 0 }}
            >
              <CartesianGrid strokeDasharray="3 3" className="stroke-border/50" />
              <XAxis
                dataKey="day"
                tickFormatter={formatDateTick}
                tick={{ fontSize: 11 }}
                tickLine={false}
                axisLine={false}
                interval="preserveStartEnd"
              />
              <YAxis
                tick={{ fontSize: 11 }}
                tickLine={false}
                axisLine={false}
                tickFormatter={(v: number) => formatCentsUSD(v)}
                width={70}
              />
              <Tooltip
                formatter={(value) => [formatCentsUSD(Number(value)), "Custo"]}
                labelFormatter={(label) => formatDateTick(String(label))}
                contentStyle={tooltipStyle}
              />
              <Line
                type="monotone"
                dataKey="value"
                stroke="hsl(142 76% 36%)"
                strokeWidth={2}
                dot={false}
              />
            </LineChart>
          </ResponsiveContainer>
        )}
      </ChartCard>

      <ChartCard title="Volume de texto processado por dia">
        {!hasTokens ? (
          <EmptyChart />
        ) : (
          <ResponsiveContainer width="100%" height={200}>
            <LineChart
              data={series.total_tokens}
              margin={{ top: 4, right: 8, bottom: 0, left: 0 }}
            >
              <CartesianGrid strokeDasharray="3 3" className="stroke-border/50" />
              <XAxis
                dataKey="day"
                tickFormatter={formatDateTick}
                tick={{ fontSize: 11 }}
                tickLine={false}
                axisLine={false}
                interval="preserveStartEnd"
              />
              <YAxis
                tick={{ fontSize: 11 }}
                tickLine={false}
                axisLine={false}
                tickFormatter={formatTokens}
                width={50}
              />
              <Tooltip
                formatter={(value) => [formatNumber(Number(value)), "Tokens"]}
                labelFormatter={(label) => formatDateTick(String(label))}
                contentStyle={tooltipStyle}
              />
              <Line
                type="monotone"
                dataKey="value"
                stroke="hsl(262 83% 58%)"
                strokeWidth={2}
                dot={false}
              />
            </LineChart>
          </ResponsiveContainer>
        )}
      </ChartCard>

      <ChartCard title="Tempo de resposta por dia (segundos)">
        {!hasLatency ? (
          <EmptyChart />
        ) : (
          <ResponsiveContainer width="100%" height={200}>
            <LineChart
              data={latencyData}
              margin={{ top: 4, right: 8, bottom: 0, left: 0 }}
            >
              <CartesianGrid strokeDasharray="3 3" className="stroke-border/50" />
              <XAxis
                dataKey="day"
                tickFormatter={formatDateTick}
                tick={{ fontSize: 11 }}
                tickLine={false}
                axisLine={false}
                interval="preserveStartEnd"
              />
              <YAxis
                tick={{ fontSize: 11 }}
                tickLine={false}
                axisLine={false}
                // O eixo TAMBÉM em segundos. Traduzir só o título e o tooltip
                // deixaria a régua contradizendo o rótulo — o gráfico diria
                // "segundos" e mostraria 24.000 na lateral.
                tickFormatter={(v: number) =>
                  (v / 1000).toLocaleString("pt-BR", { maximumFractionDigits: 0 })
                }
                width={40}
              />
              <Tooltip
                // Segundos, não milissegundos: 17.621 ms não diz nada a quem
                // atende; 17,6 s diz.
                formatter={(value, name) => [
                  `${(Number(value) / 1000).toLocaleString("pt-BR", { maximumFractionDigits: 1 })} s`,
                  name,
                ]}
                labelFormatter={(label) => formatDateTick(String(label))}
                contentStyle={tooltipStyle}
              />
              <Legend wrapperStyle={{ fontSize: 11 }} />
              <Line
                type="monotone"
                dataKey="p50"
                name="a maioria responde em"
                stroke="hsl(199 89% 48%)"
                strokeWidth={2}
                dot={false}
              />
              <Line
                type="monotone"
                dataKey="p95"
                name="pior caso comum"
                stroke="hsl(0 84% 60%)"
                strokeWidth={2}
                dot={false}
              />
            </LineChart>
          </ResponsiveContainer>
        )}
      </ChartCard>

      <ChartCard title="Quanto foi para uma pessoa (%)">
        {!hasHandoff ? (
          <EmptyChart />
        ) : (
          <ResponsiveContainer width="100%" height={200}>
            <LineChart
              data={handoffData}
              margin={{ top: 4, right: 8, bottom: 0, left: 0 }}
            >
              <CartesianGrid strokeDasharray="3 3" className="stroke-border/50" />
              <XAxis
                dataKey="day"
                tickFormatter={formatDateTick}
                tick={{ fontSize: 11 }}
                tickLine={false}
                axisLine={false}
                interval="preserveStartEnd"
              />
              <YAxis
                tick={{ fontSize: 11 }}
                tickLine={false}
                axisLine={false}
                tickFormatter={(v: number) => `${v.toFixed(0)}%`}
                width={45}
              />
              <Tooltip
                formatter={(value) => [`${Number(value).toFixed(2)}%`, "Handoff"]}
                labelFormatter={(label) => formatDateTick(String(label))}
                contentStyle={tooltipStyle}
              />
              <Line
                type="monotone"
                dataKey="pct"
                stroke="hsl(38 92% 50%)"
                strokeWidth={2}
                dot={false}
              />
            </LineChart>
          </ResponsiveContainer>
        )}
      </ChartCard>
    </div>
  );
}
