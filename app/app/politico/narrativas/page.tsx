/**
 * /app/politico/narrativas — Radar de Narrativas
 *
 * Listagem paginada de pol_narratives com metricas agregadas
 * (total, oportunidades, ameacas, sinais recentes nos ultimos 7 dias).
 * Tabela com tema, plataforma, sentimento, forca, status estrategico e posts.
 *
 * Acesso: manager+
 */

import { redirect } from "next/navigation";
import Link from "next/link";
import { createServerClient } from "@/lib/supabase/server";
import { getUser } from "@/lib/auth/get-user";
import { resolverOrganizacaoAtiva } from "@/lib/organizations/resolver";

// -- Tipos -------------------------------------------------------------------

interface MetricasNarrativas {
  total: number;
  oportunidades: number;
  ameacas: number;
  sinaisRecentes: number;
}

interface Narrativa {
  id: string;
  theme: string;
  platform: string | null;
  sentiment: string | null;
  strength: number;
  posts_count: number;
  strategic_status: string | null;
}

// -- Constantes --------------------------------------------------------------

const POR_PAGINA = 20;

const SENTIMENT_CONFIG: Record<string, { label: string; cor: string }> = {
  positive: {
    label: "Positivo",
    cor: "bg-green-100 text-green-800 dark:bg-green-950 dark:text-green-200",
  },
  negative: {
    label: "Negativo",
    cor: "bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-200",
  },
  neutral: {
    label: "Neutro",
    cor: "bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400",
  },
  mixed: {
    label: "Misto",
    cor: "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-200",
  },
};

const STATUS_CONFIG: Record<string, { label: string; cor: string }> = {
  monitoring: {
    label: "Monitorando",
    cor: "bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400",
  },
  opportunity: {
    label: "Oportunidade",
    cor: "bg-green-100 text-green-800 dark:bg-green-950 dark:text-green-200",
  },
  threat: {
    label: "Ameaca",
    cor: "bg-orange-100 text-orange-800 dark:bg-orange-950 dark:text-orange-200",
  },
  crisis: {
    label: "Crise",
    cor: "bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-200",
  },
  resolved: {
    label: "Resolvida",
    cor: "bg-blue-100 text-blue-800 dark:bg-blue-950 dark:text-blue-200",
  },
};

// -- Data fetching -----------------------------------------------------------

async function buscarMetricas(organizationId: string): Promise<MetricasNarrativas> {
  const db = createServerClient();

  const seteDiasAtras = new Date();
  seteDiasAtras.setDate(seteDiasAtras.getDate() - 7);

  const [total, oportunidades, ameacas, sinaisRecentes] = await Promise.all([
    db
      .from("pol_narratives")
      .select("id", { count: "exact", head: true })
      .eq("organization_id", organizationId),

    db
      .from("pol_narratives")
      .select("id", { count: "exact", head: true })
      .eq("organization_id", organizationId)
      .eq("strategic_status", "opportunity"),

    db
      .from("pol_narratives")
      .select("id", { count: "exact", head: true })
      .eq("organization_id", organizationId)
      .in("strategic_status", ["threat", "crisis"]),

    db
      .from("pol_narrative_signals")
      .select("id", { count: "exact", head: true })
      .eq("organization_id", organizationId)
      .gte("created_at", seteDiasAtras.toISOString()),
  ]);

  return {
    total: total.count ?? 0,
    oportunidades: oportunidades.count ?? 0,
    ameacas: ameacas.count ?? 0,
    sinaisRecentes: sinaisRecentes.count ?? 0,
  };
}

async function buscarNarrativas(
  organizationId: string,
  pagina: number,
): Promise<{ narrativas: Narrativa[]; total: number }> {
  const db = createServerClient();
  const offset = (pagina - 1) * POR_PAGINA;

  const { data, count } = await db
    .from("pol_narratives")
    .select("id, theme, platform, sentiment, strength, posts_count, strategic_status", {
      count: "exact",
    })
    .eq("organization_id", organizationId)
    .order("strength", { ascending: false })
    .range(offset, offset + POR_PAGINA - 1);

  return {
    narrativas: (data ?? []) as Narrativa[],
    total: count ?? 0,
  };
}

// -- Componente --------------------------------------------------------------

export default async function NarrativasPage(props: {
  searchParams: Promise<{ pagina?: string }>;
}) {
  const user = await getUser();
  if (!user) redirect("/login");

  const org = await resolverOrganizacaoAtiva(user.id);
  if (!org) redirect("/app/onboarding");

  const searchParams = await props.searchParams;
  const paginaAtual = Math.max(1, parseInt(searchParams.pagina ?? "1", 10) || 1);

  const [metricas, { narrativas, total }] = await Promise.all([
    buscarMetricas(org.id),
    buscarNarrativas(org.id, paginaAtual),
  ]);

  const totalPaginas = Math.ceil(total / POR_PAGINA);

  return (
    <div className="mx-auto max-w-4xl px-4 py-8 space-y-8">
      {/* Cabecalho */}
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Radar de Narrativas</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Monitore narrativas ativas no debate publico, identifique oportunidades e ameacas em tempo real.
        </p>
      </div>

      {/* Metricas */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <MetricaCard label="Total narrativas" valor={metricas.total} />
        <MetricaCard label="Oportunidades" valor={metricas.oportunidades} />
        <MetricaCard label="Ameacas" valor={metricas.ameacas} />
        <MetricaCard label="Sinais recentes (7d)" valor={metricas.sinaisRecentes} />
      </div>

      {/* Tabela de narrativas */}
      {narrativas.length > 0 ? (
        <>
          <div className="rounded-xl border bg-card overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b bg-muted/50">
                    <th className="px-4 py-3 text-left font-medium text-muted-foreground">Tema</th>
                    <th className="px-4 py-3 text-left font-medium text-muted-foreground">Plataforma</th>
                    <th className="px-4 py-3 text-left font-medium text-muted-foreground">Sentimento</th>
                    <th className="px-4 py-3 text-right font-medium text-muted-foreground">Forca</th>
                    <th className="px-4 py-3 text-left font-medium text-muted-foreground">Status</th>
                    <th className="px-4 py-3 text-right font-medium text-muted-foreground">Posts</th>
                  </tr>
                </thead>
                <tbody>
                  {narrativas.map((n) => {
                    const sentimentConfig = SENTIMENT_CONFIG[n.sentiment ?? ""] ?? SENTIMENT_CONFIG.neutral;
                    const statusConfig = STATUS_CONFIG[n.strategic_status ?? ""] ?? STATUS_CONFIG.monitoring;

                    return (
                      <tr
                        key={n.id}
                        className="border-b last:border-b-0 hover:bg-accent/30 transition-colors"
                      >
                        <td className="px-4 py-3 font-bold">{n.theme}</td>
                        <td className="px-4 py-3">
                          {n.platform && (
                            <span className="rounded-full bg-muted px-2 py-0.5 text-xs font-medium capitalize">
                              {n.platform.replace("_", " ")}
                            </span>
                          )}
                        </td>
                        <td className="px-4 py-3">
                          <span
                            className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${sentimentConfig.cor}`}
                          >
                            {sentimentConfig.label}
                          </span>
                        </td>
                        <td className="px-4 py-3 text-right tabular-nums font-semibold">
                          {Number(n.strength).toFixed(1)}
                        </td>
                        <td className="px-4 py-3">
                          <span
                            className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${statusConfig.cor}`}
                          >
                            {statusConfig.label}
                          </span>
                        </td>
                        <td className="px-4 py-3 text-right tabular-nums">
                          {n.posts_count.toLocaleString("pt-BR")}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>

          {/* Paginacao */}
          {totalPaginas > 1 && (
            <div className="flex items-center justify-between pt-2">
              <p className="text-xs text-muted-foreground">
                Pagina <span className="tabular-nums">{paginaAtual}</span> de{" "}
                <span className="tabular-nums">{totalPaginas}</span> ({total} narrativa
                {total !== 1 ? "s" : ""})
              </p>
              <div className="flex gap-2">
                {paginaAtual > 1 && (
                  <Link
                    href={`/app/politico/narrativas?pagina=${paginaAtual - 1}`}
                    className="rounded-lg border bg-card px-3 py-1.5 text-xs font-medium hover:bg-accent transition-colors"
                  >
                    Anterior
                  </Link>
                )}
                {paginaAtual < totalPaginas && (
                  <Link
                    href={`/app/politico/narrativas?pagina=${paginaAtual + 1}`}
                    className="rounded-lg border bg-card px-3 py-1.5 text-xs font-medium hover:bg-accent transition-colors"
                  >
                    Proxima
                  </Link>
                )}
              </div>
            </div>
          )}
        </>
      ) : (
        /* Empty state */
        <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200">
          <strong>Para comecar:</strong> cadastre a primeira narrativa para monitorar temas do debate
          publico, identificar oportunidades e antecipar crises.
        </div>
      )}
    </div>
  );
}

// -- Sub-componentes ---------------------------------------------------------

function MetricaCard({
  label,
  valor,
}: {
  label: string;
  valor: number;
}) {
  return (
    <div className="flex flex-col gap-1 rounded-lg border bg-card p-4">
      <span className="text-2xl font-bold tabular-nums">{valor}</span>
      <span className="text-xs text-muted-foreground">{label}</span>
    </div>
  );
}
