"use client";
import {
  ResponsiveContainer,
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
} from "recharts";
import type { UsageSeries } from "@/app/api/v1/admin/usage/route";
import { formatCentsUSD } from "@/lib/money";

interface UsageChartsProps {
  series: UsageSeries;
}

function formatDateTick(date: string): string {
  const d = new Date(date + "T00:00:00");
  return d.toLocaleDateString("pt-PT", { day: "2-digit", month: "2-digit" });
}

// DÓLAR: o número é `llm_calls.cost_cents`, e `pricing.ts` cota o provedor em USD.
const formatCurrency = formatCentsUSD;

function formatNumber(n: number): string {
  return n.toLocaleString("pt-PT");
}

function EmptyChart() {
  return (
    <div className="flex h-40 items-center justify-center text-sm text-muted-foreground">
      Sem dados no período
    </div>
  );
}

interface ChartCardProps {
  title: string;
  children: React.ReactNode;
}

function ChartCard({ title, children }: ChartCardProps) {
  return (
    <div className="rounded-lg border bg-card p-4">
      <h3 className="mb-4 text-sm font-medium text-muted-foreground">{title}</h3>
      {children}
    </div>
  );
}

export function UsageCharts({ series }: UsageChartsProps) {
  const hasMessages = series.messages.some((p) => p.count > 0);
  const hasCost = series.ai_cost.some((p) => p.cents > 0);
  const hasTokens = series.ai_tokens.some((p) => p.tokens > 0);

  return (
    <div className="grid gap-4 md:grid-cols-2">
      {/* Messages per day */}
      <ChartCard title="Mensagens / dia">
        {!hasMessages ? (
          <EmptyChart />
        ) : (
          <ResponsiveContainer width="100%" height={200}>
            <AreaChart
              data={series.messages}
              margin={{ top: 4, right: 8, bottom: 0, left: 0 }}
            >
              <defs>
                <linearGradient id="colorMsg" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="hsl(var(--accent))" stopOpacity={0.25} />
                  <stop offset="95%" stopColor="hsl(var(--accent))" stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" className="stroke-border/50" />
              <XAxis
                dataKey="date"
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
                tickFormatter={formatNumber}
                width={45}
              />
              <Tooltip
                formatter={(value) => [formatNumber(Number(value)), "Mensagens"]}
                labelFormatter={(label) => formatDateTick(String(label))}
                contentStyle={{
                  borderRadius: "8px",
                  fontSize: "12px",
                  border: "1px solid hsl(var(--border))",
                }}
              />
              <Area
                type="monotone"
                dataKey="count"
                stroke="hsl(var(--accent))"
                strokeWidth={2}
                fill="url(#colorMsg)"
              />
            </AreaChart>
          </ResponsiveContainer>
        )}
      </ChartCard>

      {/* AI Cost per day */}
      <ChartCard title="Custo AI / dia (USD)">
        {!hasCost ? (
          <EmptyChart />
        ) : (
          <ResponsiveContainer width="100%" height={200}>
            <AreaChart
              data={series.ai_cost}
              margin={{ top: 4, right: 8, bottom: 0, left: 0 }}
            >
              <defs>
                <linearGradient id="colorCost" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="hsl(var(--chart-2,142 76% 36%))" stopOpacity={0.25} />
                  <stop offset="95%" stopColor="hsl(var(--chart-2,142 76% 36%))" stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" className="stroke-border/50" />
              <XAxis
                dataKey="date"
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
                tickFormatter={(v: number) =>
                  formatCurrency(v)
                }
                width={70}
              />
              <Tooltip
                formatter={(value) => [formatCurrency(Number(value)), "Custo"]}
                labelFormatter={(label) => formatDateTick(String(label))}
                contentStyle={{
                  borderRadius: "8px",
                  fontSize: "12px",
                  border: "1px solid hsl(var(--border))",
                }}
              />
              <Area
                type="monotone"
                dataKey="cents"
                stroke="hsl(142 76% 36%)"
                strokeWidth={2}
                fill="url(#colorCost)"
              />
            </AreaChart>
          </ResponsiveContainer>
        )}
      </ChartCard>

      {/* AI Tokens per day — full width */}
      <div className="md:col-span-2">
        <ChartCard title="AI Tokens / dia">
          {!hasTokens ? (
            <EmptyChart />
          ) : (
            <ResponsiveContainer width="100%" height={200}>
              <AreaChart
                data={series.ai_tokens}
                margin={{ top: 4, right: 8, bottom: 0, left: 0 }}
              >
                <defs>
                  <linearGradient id="colorTokens" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="hsl(var(--chart-3,262 83% 58%))" stopOpacity={0.25} />
                    <stop offset="95%" stopColor="hsl(var(--chart-3,262 83% 58%))" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" className="stroke-border/50" />
                <XAxis
                  dataKey="date"
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
                  tickFormatter={(v: number) => {
                    if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
                    if (v >= 1_000) return `${(v / 1_000).toFixed(0)}k`;
                    return String(v);
                  }}
                  width={50}
                />
                <Tooltip
                  formatter={(value) => [formatNumber(Number(value)), "Tokens"]}
                  labelFormatter={(label) => formatDateTick(String(label))}
                  contentStyle={{
                    borderRadius: "8px",
                    fontSize: "12px",
                    border: "1px solid hsl(var(--border))",
                  }}
                />
                <Area
                  type="monotone"
                  dataKey="tokens"
                  stroke="hsl(262 83% 58%)"
                  strokeWidth={2}
                  fill="url(#colorTokens)"
                />
              </AreaChart>
            </ResponsiveContainer>
          )}
        </ChartCard>
      </div>
    </div>
  );
}
