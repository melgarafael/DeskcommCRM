/**
 * /app/politico/funil-invisivel — Funil Invisivel (War Room 2.0 Fase 3)
 *
 * Rastreamento comportamental de contatos por engajamento passivo.
 * Tabela: pol_invisible_funnel joined com contacts.
 *
 * Acesso: manager+
 */

import { redirect } from "next/navigation";
import Link from "next/link";
import { createServerClient } from "@/lib/supabase/server";
import { getUser } from "@/lib/auth/get-user";
import { resolverOrganizacaoAtiva } from "@/lib/organizations/resolver";

// -- Tipos -------------------------------------------------------------------

interface FunilEntry {
  id: string;
  contact_id: string;
  funnel_stage: string;
  interaction_class: string | null;
  funnel_score: number;
  total_clicks: number;
  total_replies: number;
  consecutive_weeks_active: number;
  updated_at: string;
  contacts: {
    name: string | null;
    phone: string | null;
  } | null;
}

const STAGE_LABELS: Record<string, string> = {
  awareness: "Consciencia",
  interest: "Interesse",
  consideration: "Consideracao",
  intent: "Intencao",
  evaluation: "Avaliacao",
  conversion: "Conversao",
};

const CLASS_LABELS: Record<string, string> = {
  cold: "Frio",
  warm: "Morno",
  hot: "Quente",
  engaged: "Engajado",
  advocate: "Defensor",
};

// -- Data fetching -----------------------------------------------------------

async function buscarFunil(
  organizationId: string,
  filtroStage?: string,
  filtroClass?: string,
): Promise<FunilEntry[]> {
  const db = createServerClient();

  let query = db
    .from("pol_invisible_funnel")
    .select("id, contact_id, funnel_stage, interaction_class, funnel_score, total_clicks, total_replies, consecutive_weeks_active, updated_at, contacts(name, phone)")
    .eq("organization_id", organizationId)
    .order("funnel_score", { ascending: false })
    .limit(100);

  if (filtroStage) {
    query = query.eq("funnel_stage", filtroStage);
  }
  if (filtroClass) {
    query = query.eq("interaction_class", filtroClass);
  }

  const { data, error } = await query;
  if (error) {
    console.error("Erro ao buscar funil invisivel:", error.message);
    return [];
  }

  return (data ?? []) as unknown as FunilEntry[];
}

// -- Componente --------------------------------------------------------------

export default async function FunilInvisivelPage({
  searchParams,
}: {
  searchParams: Promise<{ stage?: string; class?: string }>;
}) {
  const user = await getUser();
  if (!user) redirect("/login");

  const org = await resolverOrganizacaoAtiva(user.id);
  if (!org) redirect("/app/onboarding");

  const params = await searchParams;
  const filtroStage = params.stage ?? "";
  const filtroClass = params.class ?? "";

  const entradas = await buscarFunil(org.id, filtroStage || undefined, filtroClass || undefined);

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
        <h1 className="text-2xl font-bold tracking-tight">Funil Invisivel</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Rastreamento comportamental — engajamento passivo por cliques, respostas e semanas ativas.
        </p>
      </div>

      {/* Filtros */}
      <div className="space-y-2">
        <div className="flex flex-wrap gap-2">
          <span className="text-xs text-muted-foreground self-center mr-1">Estagio:</span>
          <FilterLink href={buildHref("", filtroClass)} label="Todos" active={!filtroStage} />
          {Object.entries(STAGE_LABELS).map(([value, label]) => (
            <FilterLink
              key={value}
              href={buildHref(value, filtroClass)}
              label={label}
              active={filtroStage === value}
            />
          ))}
        </div>
        <div className="flex flex-wrap gap-2">
          <span className="text-xs text-muted-foreground self-center mr-1">Classe:</span>
          <FilterLink href={buildHref(filtroStage, "")} label="Todos" active={!filtroClass} />
          {Object.entries(CLASS_LABELS).map(([value, label]) => (
            <FilterLink
              key={value}
              href={buildHref(filtroStage, value)}
              label={label}
              active={filtroClass === value}
            />
          ))}
        </div>
      </div>

      {/* Tabela */}
      {entradas.length === 0 ? (
        <div className="rounded-xl border bg-card p-8 text-center text-sm text-muted-foreground">
          Nenhum contato no funil invisivel.
        </div>
      ) : (
        <div className="rounded-xl border bg-card overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-left text-xs text-muted-foreground">
                <th className="px-4 py-3 font-medium">Contato</th>
                <th className="px-4 py-3 font-medium">Telefone</th>
                <th className="px-4 py-3 font-medium">Estagio</th>
                <th className="px-4 py-3 font-medium">Classe</th>
                <th className="px-4 py-3 font-medium">Score</th>
                <th className="px-4 py-3 font-medium">Cliques</th>
                <th className="px-4 py-3 font-medium">Respostas</th>
                <th className="px-4 py-3 font-medium">Semanas ativas</th>
              </tr>
            </thead>
            <tbody>
              {entradas.map((e) => (
                <tr key={e.id} className="border-b last:border-b-0 hover:bg-accent/30 transition-colors">
                  <td className="px-4 py-3 font-medium">
                    {e.contacts?.name ?? "Sem nome"}
                  </td>
                  <td className="px-4 py-3 text-muted-foreground">
                    {e.contacts?.phone ?? "—"}
                  </td>
                  <td className="px-4 py-3">
                    <StageBadge stage={e.funnel_stage} />
                  </td>
                  <td className="px-4 py-3">
                    {e.interaction_class ? (
                      <span className="rounded-full bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary">
                        {CLASS_LABELS[e.interaction_class] ?? e.interaction_class}
                      </span>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </td>
                  <td className="px-4 py-3 tabular-nums font-medium">
                    {e.funnel_score}
                  </td>
                  <td className="px-4 py-3 tabular-nums text-muted-foreground">
                    {e.total_clicks}
                  </td>
                  <td className="px-4 py-3 tabular-nums text-muted-foreground">
                    {e.total_replies}
                  </td>
                  <td className="px-4 py-3 tabular-nums text-muted-foreground">
                    {e.consecutive_weeks_active}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// -- Helpers -----------------------------------------------------------------

function buildHref(stage: string, interactionClass: string): string {
  const params = new URLSearchParams();
  if (stage) params.set("stage", stage);
  if (interactionClass) params.set("class", interactionClass);
  const qs = params.toString();
  return `/app/politico/funil-invisivel${qs ? `?${qs}` : ""}`;
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

function StageBadge({ stage }: { stage: string }) {
  const label = STAGE_LABELS[stage] ?? stage;

  const colorMap: Record<string, string> = {
    awareness: "bg-gray-100 text-gray-800 dark:bg-gray-900 dark:text-gray-200",
    interest: "bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200",
    consideration: "bg-yellow-100 text-yellow-800 dark:bg-yellow-900 dark:text-yellow-200",
    intent: "bg-orange-100 text-orange-800 dark:bg-orange-900 dark:text-orange-200",
    evaluation: "bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200",
    conversion: "bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200",
  };

  const color = colorMap[stage] ?? "bg-primary/10 text-primary";

  return (
    <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${color}`}>
      {label}
    </span>
  );
}
