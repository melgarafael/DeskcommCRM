/**
 * /app/politico/eventos — Eventos (War Room 2.0 Fase 3)
 *
 * Lista de eventos da campanha com tipo, status e metricas de audiencia.
 * Tabela: pol_events.
 *
 * Acesso: manager+
 */

import { redirect } from "next/navigation";
import Link from "next/link";
import { createServerClient } from "@/lib/supabase/server";
import { getUser } from "@/lib/auth/get-user";
import { resolverOrganizacaoAtiva } from "@/lib/organizations/resolver";

// -- Tipos -------------------------------------------------------------------

interface Evento {
  id: string;
  title: string;
  type: string | null;
  status: string;
  event_date: string | null;
  city: string | null;
  estimated_audience: number | null;
  actual_attendance: number | null;
  created_at: string;
}

const STATUS_LABELS: Record<string, string> = {
  scheduled: "Agendado",
  confirmed: "Confirmado",
  in_progress: "Em andamento",
  completed: "Concluido",
  cancelled: "Cancelado",
  postponed: "Adiado",
};

const TYPE_LABELS: Record<string, string> = {
  reuniao: "Reuniao",
  comicio: "Comicio",
  caminhada: "Caminhada",
  carreata: "Carreata",
  debate: "Debate",
  audiencia: "Audiencia",
  assembleia: "Assembleia",
  workshop: "Workshop",
  live: "Live",
  entrevista: "Entrevista",
  visita: "Visita",
  outro: "Outro",
};

// -- Data fetching -----------------------------------------------------------

async function buscarEventos(
  organizationId: string,
  filtroStatus?: string,
  filtroType?: string,
): Promise<Evento[]> {
  const db = createServerClient();

  let query = db
    .from("pol_events")
    .select("id, title, type, status, event_date, city, estimated_audience, actual_attendance, created_at")
    .eq("organization_id", organizationId)
    .order("event_date", { ascending: false, nullsFirst: false })
    .limit(100);

  if (filtroStatus) {
    query = query.eq("status", filtroStatus);
  }
  if (filtroType) {
    query = query.eq("type", filtroType);
  }

  const { data, error } = await query;
  if (error) {
    console.error("Erro ao buscar eventos:", error.message);
    return [];
  }

  return (data ?? []) as Evento[];
}

// -- Componente --------------------------------------------------------------

export default async function EventosPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string; type?: string }>;
}) {
  const user = await getUser();
  if (!user) redirect("/login");

  const org = await resolverOrganizacaoAtiva(user.id);
  if (!org) redirect("/app/onboarding");

  const params = await searchParams;
  const filtroStatus = params.status ?? "";
  const filtroType = params.type ?? "";

  const eventos = await buscarEventos(org.id, filtroStatus || undefined, filtroType || undefined);

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
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Eventos</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Gerencie eventos da campanha com audiencia estimada e presenca real.
          </p>
        </div>
        <button
          type="button"
          disabled
          className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground opacity-50 cursor-not-allowed"
          title="Em breve"
        >
          Novo evento
        </button>
      </div>

      {/* Filtros */}
      <div className="space-y-2">
        <div className="flex flex-wrap gap-2">
          <span className="text-xs text-muted-foreground self-center mr-1">Status:</span>
          <FilterLink href={buildHref("", filtroType)} label="Todos" active={!filtroStatus} />
          {Object.entries(STATUS_LABELS).map(([value, label]) => (
            <FilterLink
              key={value}
              href={buildHref(value, filtroType)}
              label={label}
              active={filtroStatus === value}
            />
          ))}
        </div>
        <div className="flex flex-wrap gap-2">
          <span className="text-xs text-muted-foreground self-center mr-1">Tipo:</span>
          <FilterLink href={buildHref(filtroStatus, "")} label="Todos" active={!filtroType} />
          {Object.entries(TYPE_LABELS).map(([value, label]) => (
            <FilterLink
              key={value}
              href={buildHref(filtroStatus, value)}
              label={label}
              active={filtroType === value}
            />
          ))}
        </div>
      </div>

      {/* Cards */}
      {eventos.length === 0 ? (
        <div className="rounded-xl border bg-card p-8 text-center text-sm text-muted-foreground">
          Nenhum evento encontrado.
        </div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2">
          {eventos.map((e) => (
            <div
              key={e.id}
              className="flex flex-col gap-3 rounded-xl border bg-card p-5"
            >
              <div className="flex items-start justify-between gap-2">
                <h2 className="font-semibold leading-snug">{e.title}</h2>
                <StatusBadge status={e.status} />
              </div>

              <div className="flex flex-wrap gap-2">
                {e.type && (
                  <span className="rounded-full bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary">
                    {TYPE_LABELS[e.type] ?? e.type}
                  </span>
                )}
                {e.city && (
                  <span className="text-xs text-muted-foreground">{e.city}</span>
                )}
              </div>

              <div className="flex flex-wrap gap-4 text-sm text-muted-foreground">
                {e.event_date && (
                  <span>
                    {new Date(e.event_date).toLocaleDateString("pt-BR", {
                      day: "2-digit",
                      month: "short",
                      year: "numeric",
                    })}
                  </span>
                )}
                {e.estimated_audience != null && (
                  <span>
                    Estimado: {e.estimated_audience.toLocaleString("pt-BR")}
                  </span>
                )}
                {e.actual_attendance != null && (
                  <span>
                    Real: {e.actual_attendance.toLocaleString("pt-BR")}
                  </span>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// -- Helpers -----------------------------------------------------------------

function buildHref(status: string, type: string): string {
  const params = new URLSearchParams();
  if (status) params.set("status", status);
  if (type) params.set("type", type);
  const qs = params.toString();
  return `/app/politico/eventos${qs ? `?${qs}` : ""}`;
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

function StatusBadge({ status }: { status: string }) {
  const label = STATUS_LABELS[status] ?? status;
  return (
    <span className="rounded-full bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary">
      {label}
    </span>
  );
}
