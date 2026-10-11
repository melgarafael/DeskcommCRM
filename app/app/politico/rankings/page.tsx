/**
 * /app/politico/rankings — Rankings (War Room 2.0 Fase 4)
 *
 * Dois rankings: cidades e liderancas.
 * Views: pol_vw_ranking_cidades + pol_vw_ranking_liderancas.
 *
 * Acesso: manager+
 */

import { redirect } from "next/navigation";
import Link from "next/link";
import { createServerClient } from "@/lib/supabase/server";
import { getUser } from "@/lib/auth/get-user";
import { resolverOrganizacaoAtiva } from "@/lib/organizations/resolver";

// -- Tipos -------------------------------------------------------------------

interface CidadeRanking {
  territory_id: string;
  cidade: string;
  state_code: string | null;
  population: number | null;
  electorate: number | null;
  total_leads: number;
  votos_certos: number;
  militantes: number;
  apoiadores: number;
  leads_quentes: number;
  penetracao_pct: number;
  influence_score: number;
  growth_rate: number;
  dominance_score: number;
  strategic_status: string;
  total_eventos: number;
}

interface LiderancaRanking {
  lead_id: string;
  contact_name: string | null;
  contact_phone: string | null;
  support_level: string;
  political_score: number | null;
  temperature: string | null;
  leader_potential: boolean;
  community_role: string | null;
  territory_name: string | null;
  mobilizados: number;
}

const SUPPORT_LABELS: Record<string, string> = {
  voto_certo: "Voto certo",
  militante: "Militante",
  apoiador: "Apoiador",
  simpatizante: "Simpatizante",
  novo_cadastro: "Novo cadastro",
};

const STATUS_LABELS: Record<string, string> = {
  critico: "Critico",
  prioritario: "Prioritario",
  oportunidade: "Oportunidade",
  normal: "Normal",
};

// -- Data fetching -----------------------------------------------------------

async function buscarRankings(organizationId: string, tab: string) {
  const db = createServerClient();

  if (tab === "liderancas") {
    const { data, error } = await db
      .from("pol_vw_ranking_liderancas")
      .select("*")
      .eq("organization_id", organizationId)
      .order("mobilizados", { ascending: false })
      .limit(100);

    if (error) console.error("Erro ranking liderancas:", error.message);
    return {
      cidades: [] as CidadeRanking[],
      liderancas: (data ?? []) as unknown as LiderancaRanking[],
    };
  }

  // Default: cidades
  const { data, error } = await db
    .from("pol_vw_ranking_cidades")
    .select("*")
    .eq("organization_id", organizationId)
    .order("total_leads", { ascending: false })
    .limit(100);

  if (error) console.error("Erro ranking cidades:", error.message);
  return {
    cidades: (data ?? []) as unknown as CidadeRanking[],
    liderancas: [] as LiderancaRanking[],
  };
}

// -- Componente --------------------------------------------------------------

export default async function RankingsPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string }>;
}) {
  const user = await getUser();
  if (!user) redirect("/login");

  const org = await resolverOrganizacaoAtiva(user.id);
  if (!org) redirect("/app/onboarding");

  const params = await searchParams;
  const tab = params.tab ?? "cidades";

  const { cidades, liderancas } = await buscarRankings(org.id, tab);

  return (
    <div className="mx-auto max-w-6xl px-4 py-8 space-y-6">
      {/* Voltar */}
      <Link
        href="/app/politico"
        className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground transition-colors"
      >
        &larr; War Room
      </Link>

      {/* Cabecalho */}
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Rankings</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Ranking de cidades por desempenho e liderancas por mobilizacao.
        </p>
      </div>

      {/* Tabs */}
      <div className="flex gap-2">
        <FilterLink href="/app/politico/rankings" label="Cidades" active={tab === "cidades"} />
        <FilterLink href="/app/politico/rankings?tab=liderancas" label="Liderancas" active={tab === "liderancas"} />
      </div>

      {/* Tab: Cidades */}
      {tab === "cidades" && (
        <>
          {cidades.length === 0 ? (
            <div className="rounded-xl border bg-card p-8 text-center text-sm text-muted-foreground">
              Nenhuma cidade no ranking. Cadastre territorios do tipo cidade.
            </div>
          ) : (
            <div className="rounded-xl border bg-card overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left text-xs text-muted-foreground">
                    <th className="px-4 py-3 font-medium w-8">#</th>
                    <th className="px-4 py-3 font-medium">Cidade</th>
                    <th className="px-4 py-3 font-medium">UF</th>
                    <th className="px-4 py-3 font-medium text-right">Leads</th>
                    <th className="px-4 py-3 font-medium text-right">Votos certos</th>
                    <th className="px-4 py-3 font-medium text-right">Penetracao</th>
                    <th className="px-4 py-3 font-medium text-right">Influencia</th>
                    <th className="px-4 py-3 font-medium text-right">Crescimento</th>
                    <th className="px-4 py-3 font-medium">Status</th>
                    <th className="px-4 py-3 font-medium text-right">Eventos</th>
                  </tr>
                </thead>
                <tbody>
                  {cidades.map((c, idx) => (
                    <tr key={c.territory_id} className="border-b last:border-b-0 hover:bg-accent/30 transition-colors">
                      <td className="px-4 py-3 tabular-nums text-muted-foreground">{idx + 1}</td>
                      <td className="px-4 py-3 font-medium">{c.cidade}</td>
                      <td className="px-4 py-3 text-muted-foreground">{c.state_code ?? "—"}</td>
                      <td className="px-4 py-3 text-right tabular-nums font-medium">{c.total_leads.toLocaleString("pt-BR")}</td>
                      <td className="px-4 py-3 text-right tabular-nums">{c.votos_certos.toLocaleString("pt-BR")}</td>
                      <td className="px-4 py-3 text-right">
                        <PenetracaoBadge pct={c.penetracao_pct} />
                      </td>
                      <td className="px-4 py-3 text-right tabular-nums text-muted-foreground">{c.influence_score}</td>
                      <td className="px-4 py-3 text-right">
                        <GrowthBadge rate={c.growth_rate} />
                      </td>
                      <td className="px-4 py-3">
                        <StatusBadge status={c.strategic_status} />
                      </td>
                      <td className="px-4 py-3 text-right tabular-nums text-muted-foreground">{c.total_eventos}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}

      {/* Tab: Liderancas */}
      {tab === "liderancas" && (
        <>
          {liderancas.length === 0 ? (
            <div className="rounded-xl border bg-card p-8 text-center text-sm text-muted-foreground">
              Nenhuma lideranca encontrada. Marque leads como lider potencial ou atribua papel comunitario.
            </div>
          ) : (
            <div className="rounded-xl border bg-card overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left text-xs text-muted-foreground">
                    <th className="px-4 py-3 font-medium w-8">#</th>
                    <th className="px-4 py-3 font-medium">Nome</th>
                    <th className="px-4 py-3 font-medium">Telefone</th>
                    <th className="px-4 py-3 font-medium">Nivel</th>
                    <th className="px-4 py-3 font-medium text-right">Score</th>
                    <th className="px-4 py-3 font-medium">Papel</th>
                    <th className="px-4 py-3 font-medium">Territorio</th>
                    <th className="px-4 py-3 font-medium text-right">Mobilizados</th>
                  </tr>
                </thead>
                <tbody>
                  {liderancas.map((l, idx) => (
                    <tr key={l.lead_id} className="border-b last:border-b-0 hover:bg-accent/30 transition-colors">
                      <td className="px-4 py-3 tabular-nums text-muted-foreground">{idx + 1}</td>
                      <td className="px-4 py-3 font-medium">{l.contact_name ?? "Sem nome"}</td>
                      <td className="px-4 py-3 text-muted-foreground">{l.contact_phone ?? "—"}</td>
                      <td className="px-4 py-3">
                        <SupportBadge level={l.support_level} />
                      </td>
                      <td className="px-4 py-3 text-right tabular-nums font-medium">{l.political_score ?? "—"}</td>
                      <td className="px-4 py-3">
                        {l.community_role ? (
                          <span className="rounded-full bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary">
                            {l.community_role}
                          </span>
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </td>
                      <td className="px-4 py-3 text-muted-foreground">{l.territory_name ?? "—"}</td>
                      <td className="px-4 py-3 text-right tabular-nums font-bold">{l.mobilizados.toLocaleString("pt-BR")}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
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

function PenetracaoBadge({ pct }: { pct: number }) {
  let color = "bg-gray-100 text-gray-800 dark:bg-gray-900 dark:text-gray-200";
  if (pct >= 15) color = "bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200";
  else if (pct >= 5) color = "bg-yellow-100 text-yellow-800 dark:bg-yellow-900 dark:text-yellow-200";
  else if (pct > 0) color = "bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200";

  return (
    <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${color}`}>
      {pct}%
    </span>
  );
}

function GrowthBadge({ rate }: { rate: number }) {
  if (rate > 0) {
    return (
      <span className="text-xs font-medium text-green-600 dark:text-green-400">
        +{rate}%
      </span>
    );
  }
  if (rate < 0) {
    return (
      <span className="text-xs font-medium text-red-600 dark:text-red-400">
        {rate}%
      </span>
    );
  }
  return <span className="text-xs text-muted-foreground">0%</span>;
}

function StatusBadge({ status }: { status: string }) {
  const label = STATUS_LABELS[status] ?? status;

  const colorMap: Record<string, string> = {
    critico: "bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200",
    prioritario: "bg-orange-100 text-orange-800 dark:bg-orange-900 dark:text-orange-200",
    oportunidade: "bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200",
    normal: "bg-gray-100 text-gray-800 dark:bg-gray-900 dark:text-gray-200",
  };

  const color = colorMap[status] ?? "bg-primary/10 text-primary";

  return (
    <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${color}`}>
      {label}
    </span>
  );
}

function SupportBadge({ level }: { level: string }) {
  const label = SUPPORT_LABELS[level] ?? level;

  const colorMap: Record<string, string> = {
    voto_certo: "bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200",
    militante: "bg-orange-100 text-orange-800 dark:bg-orange-900 dark:text-orange-200",
    apoiador: "bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200",
    simpatizante: "bg-yellow-100 text-yellow-800 dark:bg-yellow-900 dark:text-yellow-200",
    novo_cadastro: "bg-gray-100 text-gray-800 dark:bg-gray-900 dark:text-gray-200",
  };

  const color = colorMap[level] ?? "bg-primary/10 text-primary";

  return (
    <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${color}`}>
      {label}
    </span>
  );
}
