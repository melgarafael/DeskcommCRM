/**
 * /app/politico/projecao — Projecao Eleitoral (War Room 2.0 Fase 4)
 *
 * Cruza dados do TSE (votacao historica) com leads atuais por territorio
 * para estimar base segura e projecao otimista.
 * View: pol_vw_projecao_eleitoral.
 *
 * Acesso: manager+
 */

import { redirect } from "next/navigation";
import Link from "next/link";
import { createServerClient } from "@/lib/supabase/server";
import { getUser } from "@/lib/auth/get-user";
import { resolverOrganizacaoAtiva } from "@/lib/organizations/resolver";

// -- Tipos -------------------------------------------------------------------

interface ProjecaoRow {
  territory_id: string;
  territory_name: string;
  territory_type: string;
  state_code: string | null;
  population: number | null;
  electorate: number | null;
  election_year: number | null;
  cargo: string | null;
  total_voters: number | null;
  valid_votes: number | null;
  candidate_votes: number | null;
  turnout_rate: number | null;
  total_leads: number;
  votos_certos: number;
  militantes: number;
  base_segura: number;
  projecao_otimista: number;
  penetracao_pct: number;
}

const TYPE_LABELS: Record<string, string> = {
  estado: "Estado",
  cidade: "Cidade",
  bairro: "Bairro",
  zona_eleitoral: "Zona Eleitoral",
  secao: "Secao",
  regiao: "Regiao",
};

// -- Data fetching -----------------------------------------------------------

async function buscarProjecao(
  organizationId: string,
  filtroType?: string,
  ordenacao?: string,
): Promise<ProjecaoRow[]> {
  const db = createServerClient();

  let query = db
    .from("pol_vw_projecao_eleitoral")
    .select("*")
    .eq("organization_id", organizationId)
    .limit(200);

  if (filtroType) {
    query = query.eq("territory_type", filtroType);
  }

  // Ordenacao
  switch (ordenacao) {
    case "penetracao":
      query = query.order("penetracao_pct", { ascending: false });
      break;
    case "base_segura":
      query = query.order("base_segura", { ascending: false });
      break;
    case "projecao":
      query = query.order("projecao_otimista", { ascending: false });
      break;
    default:
      query = query.order("total_leads", { ascending: false });
      break;
  }

  const { data, error } = await query;
  if (error) {
    console.error("Erro ao buscar projecao eleitoral:", error.message);
    return [];
  }

  return (data ?? []) as unknown as ProjecaoRow[];
}

// -- Componente --------------------------------------------------------------

export default async function ProjecaoPage({
  searchParams,
}: {
  searchParams: Promise<{ type?: string; ordem?: string }>;
}) {
  const user = await getUser();
  if (!user) redirect("/login");

  const org = await resolverOrganizacaoAtiva(user.id);
  if (!org) redirect("/app/onboarding");

  const params = await searchParams;
  const filtroType = params.type ?? "";
  const ordenacao = params.ordem ?? "";

  const projecoes = await buscarProjecao(org.id, filtroType || undefined, ordenacao || undefined);

  // Totais
  const totalBaseSegura = projecoes.reduce((s, r) => s + r.base_segura, 0);
  const totalProjecao = projecoes.reduce((s, r) => s + r.projecao_otimista, 0);
  const totalLeads = projecoes.reduce((s, r) => s + r.total_leads, 0);

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
        <h1 className="text-2xl font-bold tracking-tight">Projecao Eleitoral</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Estimativa de votos por territorio — dados TSE cruzados com a base atual de leads.
        </p>
      </div>

      {/* Totalizadores */}
      {projecoes.length > 0 && (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <div className="flex flex-col gap-1 rounded-lg border bg-card p-4">
            <span className="text-lg">{"\u{1F465}"}</span>
            <span className="text-2xl font-bold tabular-nums">{totalLeads.toLocaleString("pt-BR")}</span>
            <span className="text-xs text-muted-foreground">Total de leads</span>
          </div>
          <div className="flex flex-col gap-1 rounded-lg border bg-card p-4">
            <span className="text-lg">{"\u{1F512}"}</span>
            <span className="text-2xl font-bold tabular-nums text-green-600 dark:text-green-400">{totalBaseSegura.toLocaleString("pt-BR")}</span>
            <span className="text-xs text-muted-foreground">Base segura</span>
          </div>
          <div className="flex flex-col gap-1 rounded-lg border bg-card p-4">
            <span className="text-lg">{"\u{1F4C8}"}</span>
            <span className="text-2xl font-bold tabular-nums text-blue-600 dark:text-blue-400">{totalProjecao.toLocaleString("pt-BR")}</span>
            <span className="text-xs text-muted-foreground">Projecao otimista</span>
          </div>
          <div className="flex flex-col gap-1 rounded-lg border bg-card p-4">
            <span className="text-lg">{"\u{1F5FA}️"}</span>
            <span className="text-2xl font-bold tabular-nums">{projecoes.length}</span>
            <span className="text-xs text-muted-foreground">Territorios</span>
          </div>
        </div>
      )}

      {/* Filtros */}
      <div className="space-y-2">
        <div className="flex flex-wrap gap-2">
          <span className="text-xs text-muted-foreground self-center mr-1">Tipo:</span>
          <FilterLink href={buildHref("", ordenacao)} label="Todos" active={!filtroType} />
          {Object.entries(TYPE_LABELS).map(([value, label]) => (
            <FilterLink
              key={value}
              href={buildHref(value, ordenacao)}
              label={label}
              active={filtroType === value}
            />
          ))}
        </div>
        <div className="flex flex-wrap gap-2">
          <span className="text-xs text-muted-foreground self-center mr-1">Ordenar:</span>
          <FilterLink href={buildHref(filtroType, "")} label="Leads" active={!ordenacao} />
          <FilterLink href={buildHref(filtroType, "penetracao")} label="Penetracao" active={ordenacao === "penetracao"} />
          <FilterLink href={buildHref(filtroType, "base_segura")} label="Base segura" active={ordenacao === "base_segura"} />
          <FilterLink href={buildHref(filtroType, "projecao")} label="Projecao" active={ordenacao === "projecao"} />
        </div>
      </div>

      {/* Tabela */}
      {projecoes.length === 0 ? (
        <div className="rounded-xl border bg-card p-8 text-center text-sm text-muted-foreground">
          Nenhum territorio com dados de projecao.
        </div>
      ) : (
        <div className="rounded-xl border bg-card overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-left text-xs text-muted-foreground">
                <th className="px-4 py-3 font-medium">Territorio</th>
                <th className="px-4 py-3 font-medium">Tipo</th>
                <th className="px-4 py-3 font-medium">UF</th>
                <th className="px-4 py-3 font-medium text-right">Eleitorado</th>
                <th className="px-4 py-3 font-medium text-right">Leads</th>
                <th className="px-4 py-3 font-medium text-right">Base segura</th>
                <th className="px-4 py-3 font-medium text-right">Projecao</th>
                <th className="px-4 py-3 font-medium text-right">Penetracao</th>
                <th className="px-4 py-3 font-medium text-right">TSE (ano)</th>
              </tr>
            </thead>
            <tbody>
              {projecoes.map((r) => (
                <tr key={r.territory_id} className="border-b last:border-b-0 hover:bg-accent/30 transition-colors">
                  <td className="px-4 py-3 font-medium">{r.territory_name}</td>
                  <td className="px-4 py-3">
                    <span className="rounded-full bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary">
                      {TYPE_LABELS[r.territory_type] ?? r.territory_type}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-muted-foreground">{r.state_code ?? "—"}</td>
                  <td className="px-4 py-3 text-right tabular-nums text-muted-foreground">
                    {r.electorate ? r.electorate.toLocaleString("pt-BR") : "—"}
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums font-medium">
                    {r.total_leads.toLocaleString("pt-BR")}
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums font-medium text-green-600 dark:text-green-400">
                    {r.base_segura.toLocaleString("pt-BR")}
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums font-medium text-blue-600 dark:text-blue-400">
                    {r.projecao_otimista.toLocaleString("pt-BR")}
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums">
                    <PenetracaoBadge pct={r.penetracao_pct} />
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums text-muted-foreground">
                    {r.election_year ?? "—"}
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

function buildHref(type: string, ordem: string): string {
  const params = new URLSearchParams();
  if (type) params.set("type", type);
  if (ordem) params.set("ordem", ordem);
  const qs = params.toString();
  return `/app/politico/projecao${qs ? `?${qs}` : ""}`;
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
  if (pct >= 15) {
    color = "bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200";
  } else if (pct >= 5) {
    color = "bg-yellow-100 text-yellow-800 dark:bg-yellow-900 dark:text-yellow-200";
  } else if (pct > 0) {
    color = "bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200";
  }

  return (
    <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${color}`}>
      {pct}%
    </span>
  );
}
