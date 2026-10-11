/**
 * /app/politico/pesquisas — Pesquisas (War Room 2.0 Fase 3)
 *
 * Lista de pesquisas de opiniao da campanha com status e contagem de respostas.
 * Tabela: pol_surveys + pol_survey_responses (count).
 *
 * Acesso: manager+
 */

import { redirect } from "next/navigation";
import Link from "next/link";
import { createServerClient } from "@/lib/supabase/server";
import { getUser } from "@/lib/auth/get-user";
import { resolverOrganizacaoAtiva } from "@/lib/organizations/resolver";

// -- Tipos -------------------------------------------------------------------

interface Pesquisa {
  id: string;
  title: string;
  type: string | null;
  status: string;
  start_date: string | null;
  end_date: string | null;
  public_token: string | null;
  created_at: string;
}

interface PesquisaComRespostas extends Pesquisa {
  response_count: number;
}

const STATUS_LABELS: Record<string, string> = {
  draft: "Rascunho",
  active: "Ativa",
  paused: "Pausada",
  completed: "Concluida",
  archived: "Arquivada",
};

const TYPE_LABELS: Record<string, string> = {
  field: "Campo",
  online: "Online",
  phone: "Telefone",
  door_to_door: "Porta a porta",
  other: "Outra",
};

// -- Data fetching -----------------------------------------------------------

async function buscarPesquisas(
  organizationId: string,
  filtroStatus?: string,
): Promise<PesquisaComRespostas[]> {
  const db = createServerClient();

  let query = db
    .from("pol_surveys")
    .select("id, title, type, status, start_date, end_date, public_token, created_at")
    .eq("organization_id", organizationId)
    .order("created_at", { ascending: false })
    .limit(100);

  if (filtroStatus) {
    query = query.eq("status", filtroStatus);
  }

  const { data, error } = await query;
  if (error) {
    console.error("Erro ao buscar pesquisas:", error.message);
    return [];
  }

  const pesquisas = (data ?? []) as Pesquisa[];

  // Buscar contagem de respostas por pesquisa
  if (pesquisas.length === 0) return [];

  const ids = pesquisas.map((p) => p.id);

  const { data: counts, error: countError } = await db
    .from("pol_survey_responses")
    .select("survey_id")
    .in("survey_id", ids);

  if (countError) {
    console.error("Erro ao buscar contagem de respostas:", countError.message);
    return pesquisas.map((p) => ({ ...p, response_count: 0 }));
  }

  const countMap = new Map<string, number>();
  for (const row of counts ?? []) {
    const current = countMap.get(row.survey_id) ?? 0;
    countMap.set(row.survey_id, current + 1);
  }

  return pesquisas.map((p) => ({
    ...p,
    response_count: countMap.get(p.id) ?? 0,
  }));
}

// -- Componente --------------------------------------------------------------

export default async function PesquisasPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string }>;
}) {
  const user = await getUser();
  if (!user) redirect("/login");

  const org = await resolverOrganizacaoAtiva(user.id);
  if (!org) redirect("/app/onboarding");

  const params = await searchParams;
  const filtroStatus = params.status ?? "";

  const pesquisas = await buscarPesquisas(org.id, filtroStatus || undefined);

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
        <h1 className="text-2xl font-bold tracking-tight">Pesquisas</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Pesquisas de opiniao e intencao de voto com links publicos e contagem de respostas.
        </p>
      </div>

      {/* Filtro */}
      <div className="flex flex-wrap gap-2">
        <FilterLink href="/app/politico/pesquisas" label="Todas" active={!filtroStatus} />
        {Object.entries(STATUS_LABELS).map(([value, label]) => (
          <FilterLink
            key={value}
            href={`/app/politico/pesquisas?status=${value}`}
            label={label}
            active={filtroStatus === value}
          />
        ))}
      </div>

      {/* Cards */}
      {pesquisas.length === 0 ? (
        <div className="rounded-xl border bg-card p-8 text-center text-sm text-muted-foreground">
          Nenhuma pesquisa encontrada.
        </div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2">
          {pesquisas.map((p) => (
            <div
              key={p.id}
              className="flex flex-col gap-3 rounded-xl border bg-card p-5"
            >
              <div className="flex items-start justify-between gap-2">
                <h2 className="font-semibold leading-snug">{p.title}</h2>
                <StatusBadge status={p.status} />
              </div>

              <div className="flex flex-wrap gap-2">
                {p.type && (
                  <span className="rounded-full bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary">
                    {TYPE_LABELS[p.type] ?? p.type}
                  </span>
                )}
                <span className="rounded-full bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary">
                  {p.response_count} {p.response_count === 1 ? "resposta" : "respostas"}
                </span>
              </div>

              <div className="flex flex-wrap gap-4 text-sm text-muted-foreground">
                {p.start_date && (
                  <span>
                    Inicio:{" "}
                    {new Date(p.start_date).toLocaleDateString("pt-BR", {
                      day: "2-digit",
                      month: "short",
                    })}
                  </span>
                )}
                {p.end_date && (
                  <span>
                    Fim:{" "}
                    {new Date(p.end_date).toLocaleDateString("pt-BR", {
                      day: "2-digit",
                      month: "short",
                    })}
                  </span>
                )}
              </div>

              {p.public_token && (
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  <span className="truncate font-mono bg-secondary px-2 py-1 rounded">
                    {p.public_token}
                  </span>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
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

  const colorMap: Record<string, string> = {
    draft: "bg-secondary text-secondary-foreground",
    active: "bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200",
    paused: "bg-yellow-100 text-yellow-800 dark:bg-yellow-900 dark:text-yellow-200",
    completed: "bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200",
    archived: "bg-gray-100 text-gray-800 dark:bg-gray-900 dark:text-gray-200",
  };

  const color = colorMap[status] ?? "bg-primary/10 text-primary";

  return (
    <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${color}`}>
      {label}
    </span>
  );
}
