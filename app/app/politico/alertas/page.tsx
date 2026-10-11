/**
 * /app/politico/alertas — Alertas (War Room 2.0 Fase 3)
 *
 * Lista de alertas politicos com severidade, tipo e status.
 * Tabela: pol_alerts.
 *
 * Acesso: manager+
 */

import { redirect } from "next/navigation";
import Link from "next/link";
import { createServerClient } from "@/lib/supabase/server";
import { getUser } from "@/lib/auth/get-user";
import { resolverOrganizacaoAtiva } from "@/lib/organizations/resolver";

// -- Tipos -------------------------------------------------------------------

interface Alerta {
  id: string;
  title: string;
  alert_type: string | null;
  severity: string;
  status: string;
  description: string | null;
  acknowledged_by: string | null;
  created_at: string;
}

const STATUS_LABELS: Record<string, string> = {
  open: "Aberto",
  acknowledged: "Reconhecido",
  investigating: "Investigando",
  resolved: "Resolvido",
  dismissed: "Descartado",
};

const SEVERITY_LABELS: Record<string, string> = {
  info: "Info",
  low: "Baixo",
  medium: "Medio",
  high: "Alto",
  critical: "Critico",
};

const SEVERITY_COLORS: Record<string, string> = {
  info: "bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200",
  low: "bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200",
  medium: "bg-yellow-100 text-yellow-800 dark:bg-yellow-900 dark:text-yellow-200",
  high: "bg-orange-100 text-orange-800 dark:bg-orange-900 dark:text-orange-200",
  critical: "bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200",
};

const TYPE_LABELS: Record<string, string> = {
  sentiment: "Sentimento",
  engagement: "Engajamento",
  crisis: "Crise",
  opponent: "Adversario",
  territory: "Territorio",
  fake_news: "Fake News",
  growth: "Crescimento",
  momentum: "Momentum",
  media: "Midia",
  survey: "Pesquisa",
  custom: "Personalizado",
};

// -- Data fetching -----------------------------------------------------------

async function buscarAlertas(
  organizationId: string,
  filtroStatus?: string,
  filtroSeverity?: string,
): Promise<Alerta[]> {
  const db = createServerClient();

  let query = db
    .from("pol_alerts")
    .select("id, title, alert_type, severity, status, description, acknowledged_by, created_at")
    .eq("organization_id", organizationId)
    .order("created_at", { ascending: false })
    .limit(100);

  if (filtroStatus) {
    query = query.eq("status", filtroStatus);
  }
  if (filtroSeverity) {
    query = query.eq("severity", filtroSeverity);
  }

  const { data, error } = await query;
  if (error) {
    console.error("Erro ao buscar alertas:", error.message);
    return [];
  }

  return (data ?? []) as Alerta[];
}

// -- Componente --------------------------------------------------------------

export default async function AlertasPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string; severity?: string }>;
}) {
  const user = await getUser();
  if (!user) redirect("/login");

  const org = await resolverOrganizacaoAtiva(user.id);
  if (!org) redirect("/app/onboarding");

  const params = await searchParams;
  const filtroStatus = params.status ?? "";
  const filtroSeverity = params.severity ?? "";

  const alertas = await buscarAlertas(org.id, filtroStatus || undefined, filtroSeverity || undefined);

  return (
    <div className="mx-auto max-w-5xl px-4 py-8 space-y-6">
      {/* Voltar */}
      <Link
        href="/app/politico"
        className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground transition-colors"
      >
        &larr; War Room
      </Link>

      {/* Cabecalho */}
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Alertas</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Alertas politicos com severidade, tipo e acompanhamento.
        </p>
      </div>

      {/* Filtros */}
      <div className="space-y-2">
        <div className="flex flex-wrap gap-2">
          <span className="text-xs text-muted-foreground self-center mr-1">Status:</span>
          <FilterLink href={buildHref("", filtroSeverity)} label="Todos" active={!filtroStatus} />
          {Object.entries(STATUS_LABELS).map(([value, label]) => (
            <FilterLink
              key={value}
              href={buildHref(value, filtroSeverity)}
              label={label}
              active={filtroStatus === value}
            />
          ))}
        </div>
        <div className="flex flex-wrap gap-2">
          <span className="text-xs text-muted-foreground self-center mr-1">Severidade:</span>
          <FilterLink href={buildHref(filtroStatus, "")} label="Todas" active={!filtroSeverity} />
          {Object.entries(SEVERITY_LABELS).map(([value, label]) => (
            <FilterLink
              key={value}
              href={buildHref(filtroStatus, value)}
              label={label}
              active={filtroSeverity === value}
            />
          ))}
        </div>
      </div>

      {/* Cards */}
      {alertas.length === 0 ? (
        <div className="rounded-xl border bg-card p-8 text-center text-sm text-muted-foreground">
          Nenhum alerta encontrado.
        </div>
      ) : (
        <div className="space-y-3">
          {alertas.map((a) => (
            <div
              key={a.id}
              className="flex flex-col gap-3 rounded-xl border bg-card p-5"
            >
              <div className="flex items-start justify-between gap-2">
                <div className="flex items-center gap-2 min-w-0">
                  <SeverityBadge severity={a.severity} />
                  <h2 className="font-semibold leading-snug truncate">{a.title}</h2>
                </div>
                <span className="rounded-full bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary shrink-0">
                  {STATUS_LABELS[a.status] ?? a.status}
                </span>
              </div>

              {a.description && (
                <p className="text-sm text-muted-foreground leading-relaxed">
                  {a.description}
                </p>
              )}

              <div className="flex flex-wrap gap-3 text-xs text-muted-foreground">
                {a.alert_type && (
                  <span className="rounded-full bg-secondary px-2 py-0.5 font-medium">
                    {TYPE_LABELS[a.alert_type] ?? a.alert_type}
                  </span>
                )}
                {a.acknowledged_by && (
                  <span>Reconhecido por: {a.acknowledged_by}</span>
                )}
                <span>
                  {new Date(a.created_at).toLocaleDateString("pt-BR", {
                    day: "2-digit",
                    month: "short",
                    year: "numeric",
                    hour: "2-digit",
                    minute: "2-digit",
                  })}
                </span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// -- Helpers -----------------------------------------------------------------

function buildHref(status: string, severity: string): string {
  const params = new URLSearchParams();
  if (status) params.set("status", status);
  if (severity) params.set("severity", severity);
  const qs = params.toString();
  return `/app/politico/alertas${qs ? `?${qs}` : ""}`;
}

// -- Sub-componentes ---------------------------------------------------------

function FilterLink({
  href,
  label,
  active,
}: {
  href: string;
  label: string;
  active: boolean;
}) {
  return (
    <Link
      href={href}
      className={`rounded-full px-3 py-1 text-xs font-medium transition-colors ${
        active
          ? "bg-primary text-primary-foreground"
          : "bg-secondary text-secondary-foreground hover:bg-secondary/80"
      }`}
    >
      {label}
    </Link>
  );
}

function SeverityBadge({ severity }: { severity: string }) {
  const label = SEVERITY_LABELS[severity] ?? severity;
  const color = SEVERITY_COLORS[severity] ?? "bg-primary/10 text-primary";

  return (
    <span className={`rounded-full px-2 py-0.5 text-xs font-medium shrink-0 ${color}`}>
      {label}
    </span>
  );
}
