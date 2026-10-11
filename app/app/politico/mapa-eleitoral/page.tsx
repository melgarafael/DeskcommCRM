/**
 * /app/politico/mapa-eleitoral — Mapa Eleitoral (War Room 2.0 Fase 4)
 *
 * Mapa interativo com duas camadas: oportunidades e prioridade territorial.
 * Views: pol_vw_mapa_oportunidades + pol_vw_mapa_prioridade.
 *
 * Acesso: manager+
 */

import { redirect } from "next/navigation";
import Link from "next/link";
import { createServerClient } from "@/lib/supabase/server";
import { getUser } from "@/lib/auth/get-user";
import { resolverOrganizacaoAtiva } from "@/lib/organizations/resolver";

// -- Tipos -------------------------------------------------------------------

interface OportunidadeRow {
  territory_id: string;
  name: string;
  type: string;
  state_code: string | null;
  latitude: number;
  longitude: number;
  population: number | null;
  electorate: number | null;
  total_leads: number;
  novos_cadastros: number;
  simpatizantes: number;
  apoiadores: number;
  potencial_conversao: number;
  penetracao_pct: number;
  classificacao: string;
}

interface PrioridadeRow {
  territory_id: string;
  name: string;
  type: string;
  state_code: string | null;
  latitude: number;
  longitude: number;
  electorate: number | null;
  strategic_status: string;
  influence_score: number;
  flags_ativas: number;
  flags_criticas: number;
  priority_score: number;
}

const CLASSIFICACAO_LABELS: Record<string, string> = {
  alta_oportunidade: "Alta oportunidade",
  oportunidade: "Oportunidade",
  consolidado: "Consolidado",
};

const STATUS_LABELS: Record<string, string> = {
  critico: "Critico",
  prioritario: "Prioritario",
  oportunidade: "Oportunidade",
  normal: "Normal",
};

// -- Data fetching -----------------------------------------------------------

async function buscarOportunidades(organizationId: string): Promise<OportunidadeRow[]> {
  const db = createServerClient();

  const { data, error } = await db
    .from("pol_vw_mapa_oportunidades")
    .select("*")
    .eq("organization_id", organizationId)
    .order("potencial_conversao", { ascending: false })
    .limit(200);

  if (error) {
    console.error("Erro ao buscar oportunidades:", error.message);
    return [];
  }

  return (data ?? []) as unknown as OportunidadeRow[];
}

async function buscarPrioridades(organizationId: string): Promise<PrioridadeRow[]> {
  const db = createServerClient();

  const { data, error } = await db
    .from("pol_vw_mapa_prioridade")
    .select("*")
    .eq("organization_id", organizationId)
    .order("priority_score", { ascending: false })
    .limit(200);

  if (error) {
    console.error("Erro ao buscar prioridades:", error.message);
    return [];
  }

  return (data ?? []) as unknown as PrioridadeRow[];
}

// -- Componente --------------------------------------------------------------

export default async function MapaEleitoralPage({
  searchParams,
}: {
  searchParams: Promise<{ camada?: string }>;
}) {
  const user = await getUser();
  if (!user) redirect("/login");

  const org = await resolverOrganizacaoAtiva(user.id);
  if (!org) redirect("/app/onboarding");

  const params = await searchParams;
  const camada = params.camada ?? "oportunidades";

  const [oportunidades, prioridades] = await Promise.all([
    camada === "oportunidades" ? buscarOportunidades(org.id) : Promise.resolve([]),
    camada === "prioridade" ? buscarPrioridades(org.id) : Promise.resolve([]),
  ]);

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
        <h1 className="text-2xl font-bold tracking-tight">Mapa Eleitoral</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Mapa interativo de territorios — oportunidades de conversao e prioridades estrategicas.
        </p>
      </div>

      {/* Tabs de camada */}
      <div className="flex gap-2">
        <FilterLink href="/app/politico/mapa-eleitoral" label="Oportunidades" active={camada === "oportunidades"} />
        <FilterLink href="/app/politico/mapa-eleitoral?camada=prioridade" label="Prioridade" active={camada === "prioridade"} />
      </div>

      {/* Camada: Oportunidades */}
      {camada === "oportunidades" && (
        <>
          {oportunidades.length === 0 ? (
            <div className="rounded-xl border bg-card p-8 text-center text-sm text-muted-foreground">
              Nenhum territorio com coordenadas. Cadastre territorios com latitude e longitude.
            </div>
          ) : (
            <>
              {/* Resumo por classificacao */}
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                <ClassificacaoCard
                  label="Alta oportunidade"
                  count={oportunidades.filter((o) => o.classificacao === "alta_oportunidade").length}
                  cor="text-red-600 dark:text-red-400"
                  descricao="Baixa penetracao + leads novos"
                />
                <ClassificacaoCard
                  label="Oportunidade"
                  count={oportunidades.filter((o) => o.classificacao === "oportunidade").length}
                  cor="text-yellow-600 dark:text-yellow-400"
                  descricao="Penetracao media"
                />
                <ClassificacaoCard
                  label="Consolidado"
                  count={oportunidades.filter((o) => o.classificacao === "consolidado").length}
                  cor="text-green-600 dark:text-green-400"
                  descricao="Penetracao alta"
                />
              </div>

              {/* Lista de territorios */}
              <div className="rounded-xl border bg-card overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b text-left text-xs text-muted-foreground">
                      <th className="px-4 py-3 font-medium">Territorio</th>
                      <th className="px-4 py-3 font-medium">UF</th>
                      <th className="px-4 py-3 font-medium text-right">Leads</th>
                      <th className="px-4 py-3 font-medium text-right">Novos</th>
                      <th className="px-4 py-3 font-medium text-right">Simpatizantes</th>
                      <th className="px-4 py-3 font-medium text-right">Potencial</th>
                      <th className="px-4 py-3 font-medium text-right">Penetracao</th>
                      <th className="px-4 py-3 font-medium">Classificacao</th>
                      <th className="px-4 py-3 font-medium text-right">Lat/Lng</th>
                    </tr>
                  </thead>
                  <tbody>
                    {oportunidades.map((o) => (
                      <tr key={o.territory_id} className="border-b last:border-b-0 hover:bg-accent/30 transition-colors">
                        <td className="px-4 py-3 font-medium">{o.name}</td>
                        <td className="px-4 py-3 text-muted-foreground">{o.state_code ?? "—"}</td>
                        <td className="px-4 py-3 text-right tabular-nums">{o.total_leads.toLocaleString("pt-BR")}</td>
                        <td className="px-4 py-3 text-right tabular-nums">{o.novos_cadastros.toLocaleString("pt-BR")}</td>
                        <td className="px-4 py-3 text-right tabular-nums">{o.simpatizantes.toLocaleString("pt-BR")}</td>
                        <td className="px-4 py-3 text-right tabular-nums font-medium">{o.potencial_conversao.toLocaleString("pt-BR")}</td>
                        <td className="px-4 py-3 text-right">
                          <PenetracaoBadge pct={o.penetracao_pct} />
                        </td>
                        <td className="px-4 py-3">
                          <ClassificacaoBadge classificacao={o.classificacao} />
                        </td>
                        <td className="px-4 py-3 text-right tabular-nums text-xs text-muted-foreground">
                          {o.latitude.toFixed(4)}, {o.longitude.toFixed(4)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </>
      )}

      {/* Camada: Prioridade */}
      {camada === "prioridade" && (
        <>
          {prioridades.length === 0 ? (
            <div className="rounded-xl border bg-card p-8 text-center text-sm text-muted-foreground">
              Nenhum territorio com coordenadas. Cadastre territorios com latitude e longitude.
            </div>
          ) : (
            <>
              {/* Resumo por status */}
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                <ClassificacaoCard
                  label="Critico"
                  count={prioridades.filter((p) => p.strategic_status === "critico").length}
                  cor="text-red-600 dark:text-red-400"
                  descricao="Acao imediata"
                />
                <ClassificacaoCard
                  label="Prioritario"
                  count={prioridades.filter((p) => p.strategic_status === "prioritario").length}
                  cor="text-orange-600 dark:text-orange-400"
                  descricao="Acao planejada"
                />
                <ClassificacaoCard
                  label="Oportunidade"
                  count={prioridades.filter((p) => p.strategic_status === "oportunidade").length}
                  cor="text-blue-600 dark:text-blue-400"
                  descricao="Potencial"
                />
                <ClassificacaoCard
                  label="Normal"
                  count={prioridades.filter((p) => p.strategic_status === "normal").length}
                  cor="text-gray-600 dark:text-gray-400"
                  descricao="Operacao regular"
                />
              </div>

              {/* Lista de territorios */}
              <div className="rounded-xl border bg-card overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b text-left text-xs text-muted-foreground">
                      <th className="px-4 py-3 font-medium">Territorio</th>
                      <th className="px-4 py-3 font-medium">UF</th>
                      <th className="px-4 py-3 font-medium">Status</th>
                      <th className="px-4 py-3 font-medium text-right">Score</th>
                      <th className="px-4 py-3 font-medium text-right">Influencia</th>
                      <th className="px-4 py-3 font-medium text-right">Flags ativas</th>
                      <th className="px-4 py-3 font-medium text-right">Flags criticas</th>
                      <th className="px-4 py-3 font-medium text-right">Lat/Lng</th>
                    </tr>
                  </thead>
                  <tbody>
                    {prioridades.map((p) => (
                      <tr key={p.territory_id} className="border-b last:border-b-0 hover:bg-accent/30 transition-colors">
                        <td className="px-4 py-3 font-medium">{p.name}</td>
                        <td className="px-4 py-3 text-muted-foreground">{p.state_code ?? "—"}</td>
                        <td className="px-4 py-3">
                          <StatusBadge status={p.strategic_status} />
                        </td>
                        <td className="px-4 py-3 text-right tabular-nums font-bold">{p.priority_score}</td>
                        <td className="px-4 py-3 text-right tabular-nums text-muted-foreground">{p.influence_score}</td>
                        <td className="px-4 py-3 text-right tabular-nums">
                          {p.flags_ativas > 0 ? (
                            <span className="font-medium text-amber-600 dark:text-amber-400">{p.flags_ativas}</span>
                          ) : (
                            <span className="text-muted-foreground">0</span>
                          )}
                        </td>
                        <td className="px-4 py-3 text-right tabular-nums">
                          {p.flags_criticas > 0 ? (
                            <span className="font-medium text-red-600 dark:text-red-400">{p.flags_criticas}</span>
                          ) : (
                            <span className="text-muted-foreground">0</span>
                          )}
                        </td>
                        <td className="px-4 py-3 text-right tabular-nums text-xs text-muted-foreground">
                          {p.latitude.toFixed(4)}, {p.longitude.toFixed(4)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
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

function ClassificacaoCard({
  label,
  count,
  cor,
  descricao,
}: {
  label: string;
  count: number;
  cor: string;
  descricao: string;
}) {
  return (
    <div className="flex flex-col gap-1 rounded-lg border bg-card p-4">
      <span className={`text-2xl font-bold tabular-nums ${cor}`}>{count}</span>
      <span className="text-sm font-medium">{label}</span>
      <span className="text-xs text-muted-foreground">{descricao}</span>
    </div>
  );
}

function ClassificacaoBadge({ classificacao }: { classificacao: string }) {
  const label = CLASSIFICACAO_LABELS[classificacao] ?? classificacao;

  const colorMap: Record<string, string> = {
    alta_oportunidade: "bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200",
    oportunidade: "bg-yellow-100 text-yellow-800 dark:bg-yellow-900 dark:text-yellow-200",
    consolidado: "bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200",
  };

  const color = colorMap[classificacao] ?? "bg-primary/10 text-primary";

  return (
    <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${color}`}>
      {label}
    </span>
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
