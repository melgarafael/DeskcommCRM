"use client";

import type { FC } from "react";
import { cn } from "@/lib/utils";

/** Card de KPI / stat tile (dataviz: marks-and-anatomy.md Figures). */
interface KpiCardProps {
  label: string;
  value: string | number;
  delta?: { valor: number; label: string; positivo?: boolean };
  tendencia?: number[]; // sparkline 12 pontos
  icone?: React.ReactNode;
  classe?: string;
  carregando?: boolean;
}

export const KpiCard: FC<KpiCardProps> = ({
  label,
  value,
  delta,
  tendencia,
  icone,
  classe,
  carregando,
}) => {
  if (carregando) {
    return (
      <div className={cn("rounded-xl border bg-card p-4 space-y-2 animate-pulse", classe)}>
        <div className="h-3 w-24 bg-muted rounded" />
        <div className="h-8 w-32 bg-muted rounded" />
        {delta && <div className="h-3 w-20 bg-muted rounded" />}
        {tendencia && <div className="h-16 w-full bg-muted rounded" />}
      </div>
    );
  }

  return (
    <div className={cn("rounded-xl border bg-card p-4 space-y-2 transition-all duration-200 hover:shadow-md", classe)}>
      <div className="flex items-start justify-between gap-2">
        <p className="text-sm font-medium text-muted-foreground leading-tight">{label}</p>
        {icone && <span className="shrink-0 text-muted-foreground/50" aria-hidden>{icone}</span>}
      </div>
      <div className="flex items-end gap-3">
        <span className="text-2xl font-semibold tabular-nums text-foreground">{value}</span>
        {delta && (
          <span
            className={cn(
              "text-sm font-medium flex items-center gap-1 shrink-0",
              delta.positivo ? "text-emerald-600 dark:text-emerald-400" : "text-destructive"
            )}
          >
            {delta.positivo ? "+" : ""}{delta.valor} {delta.label}
          </span>
        )}
      </div>
      {tendencia && tendencia.length > 1 && (
        <Sparkline dados={tendencia} classe="h-10 w-full mt-1" cor="var(--color-accent)" />
      )}
    </div>
  );
};

/** Sparkline simples em SVG (dataviz: marks-and-anatomy.md). */
interface SparklineProps {
  dados: number[];
  classe?: string;
  cor?: string;
}

export const Sparkline: FC<SparklineProps> = ({ dados, classe, cor = "var(--color-accent)" }) => {
  if (dados.length < 2) return null;
  const max = Math.max(...dados);
  const min = Math.min(...dados);
  const amplitude = max - min || 1;
  const largura = 100 / (dados.length - 1);
  const altura = 32; // px

  const pontos = dados
    .map((v, i) => {
      const x = i * largura;
      const y = altura - ((v - min) / amplitude) * (altura - 4) - 2;
      return `${x}% ${y}px`;
    })
    .join(" ");

  return (
    <svg className={cn("overflow-visible", classe)} viewBox={`0 0 100 ${altura}`} preserveAspectRatio="none" aria-hidden>
      <defs>
        <linearGradient id="spark-gradient" x1="0%" y1="0%" x2="0%" y2="100%">
          <stop offset="0%" stopColor={cor} stopOpacity="0.3" />
          <stop offset="100%" stopColor={cor} stopOpacity="0" />
        </linearGradient>
      </defs>
      <path
        d={`M${pontos} L100% ${altura} L0% ${altura} Z`}
        fill="url(#spark-gradient)"
        stroke="none"
      />
      <polyline
        points={pontos}
        fill="none"
        stroke={cor}
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      {dados.length > 0 && (
        <circle
          cx={`${((dados.length - 1) * largura)}%`}
          cy={`${altura - ((dados[dados.length - 1]! - min) / amplitude) * (altura - 4) - 2}px`}
          r="3"
          fill={cor}
        />
      )}
    </svg>
  );
};

/** Badge de status (dataviz: palette.md status palette). */
interface StatusBadgeProps {
  label: string;
  variante: "good" | "warning" | "serious" | "critical" | "neutro";
  classe?: string;
}

const CORES_STATUS = {
  good: "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-300",
  warning: "bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300",
  serious: "bg-orange-100 text-orange-800 dark:bg-orange-900/30 dark:text-orange-300",
  critical: "bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300",
  neutro: "bg-muted text-muted-foreground",
};

export const StatusBadge: FC<StatusBadgeProps> = ({ label, variante, classe }) => (
  <span
    className={cn(
      "inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium",
      CORES_STATUS[variante],
      classe
    )}
  >
    {label}
  </span>
);

/** Item de alerta no dashboard. */
interface AlertaItemProps {
  tipo: "critica" | "atencao" | "info";
  titulo: string;
  descricao: string;
  contador: number;
  link: string;
  icone: React.ReactNode;
}

export const AlertaItem: FC<AlertaItemProps> = ({ tipo, titulo, descricao, contador, link, icone }) => {
  const cores = {
    critica: "border-l-4 border-l-destructive bg-destructive/5",
    atencao: "border-l-4 border-l-amber-500 bg-amber-50 dark:bg-amber-900/10",
    info: "border-l-4 border-l-blue-500 bg-blue-50 dark:bg-blue-900/10",
  };
  const iconeCores = {
    critica: "text-destructive",
    atencao: "text-amber-500",
    info: "text-blue-500",
  };

  return (
    <a
      href={link}
      className={cn(
        "flex items-start gap-3 p-3 rounded-r-lg transition-colors hover:bg-accent/50",
        cores[tipo]
      )}
    >
      <span className={cn("shrink-0 mt-0.5", iconeCores[tipo])} aria-hidden>
        {icone}
      </span>
      <div className="flex-1 min-w-0">
        <p className="font-medium text-sm text-foreground">{titulo}</p>
        <p className="text-sm text-muted-foreground mt-0.5">{descricao}</p>
      </div>
      <span className={cn("shrink-0 px-2 py-0.5 rounded-full text-xs font-medium tabular-nums", cores[tipo].replace("border-l-4 border-l-", "bg-").replace("/5", ""))}>
        {contador}
      </span>
    </a>
  );
};

/** Container de seção com título e link "ver mais". */
interface SecaoProps {
  titulo: string;
  children: React.ReactNode;
  linkMais?: { href: string; label: string };
  classe?: string;
}

export const Secao: FC<SecaoProps> = ({ titulo, children, linkMais, classe }) => (
  <section className={cn("space-y-3", classe)}>
    <div className="flex items-center justify-between">
      <h2 className="text-lg font-semibold tracking-tight">{titulo}</h2>
      {linkMais && (
        <a href={linkMais.href} className="text-sm underline underline-offset-2 hover:text-foreground">
          {linkMais.label}
        </a>
      )}
    </div>
    {children}
  </section>
);

/** Grid responsivo para KPIs. */
interface KpiGridProps {
  children: React.ReactNode;
  classe?: string;
}

export const KpiGrid: FC<KpiGridProps> = ({ children, classe }) => (
  <div
    className={cn(
      "grid gap-4",
      "grid-cols-1 sm:grid-cols-2 lg:grid-cols-4",
      classe
    )}
  >
    {children}
  </div>
);