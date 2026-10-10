/**
 * /app/politico/territorios — Lista de territorios
 *
 * Cards/tabela de pol_territories com filtro por tipo.
 * Exibe nome, tipo (badge), populacao, eleitorado e contagem de filhos.
 *
 * Acesso: manager+
 */

import { redirect } from "next/navigation";
import Link from "next/link";
import { createServerClient } from "@/lib/supabase/server";
import { getUser } from "@/lib/auth/get-user";
import { resolverOrganizacaoAtiva } from "@/lib/organizations/resolver";

// -- Constantes --------------------------------------------------------------

const TIPOS_TERRITORIO = [
  { value: "estado", label: "Estado" },
  { value: "cidade", label: "Cidade" },
  { value: "bairro", label: "Bairro" },
  { value: "zona_eleitoral", label: "Zona eleitoral" },
  { value: "secao", label: "Secao" },
  { value: "regiao", label: "Regiao" },
  { value: "distrito", label: "Distrito" },
] as const;

function labelDoTipo(value: string): string {
  return TIPOS_TERRITORIO.find((t) => t.value === value)?.label ?? value;
}

function corDoTipo(value: string): string {
  const mapa: Record<string, string> = {
    estado: "bg-purple-100 text-purple-700 dark:bg-purple-900 dark:text-purple-300",
    cidade: "bg-blue-100 text-blue-700 dark:bg-blue-900 dark:text-blue-300",
    bairro: "bg-emerald-100 text-emerald-700 dark:bg-emerald-900 dark:text-emerald-300",
    zona_eleitoral: "bg-amber-100 text-amber-700 dark:bg-amber-900 dark:text-amber-300",
    secao: "bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300",
    regiao: "bg-cyan-100 text-cyan-700 dark:bg-cyan-900 dark:text-cyan-300",
    distrito: "bg-rose-100 text-rose-700 dark:bg-rose-900 dark:text-rose-300",
  };
  return mapa[value] ?? "bg-zinc-100 text-zinc-700";
}

// -- Tipos -------------------------------------------------------------------

interface TerritorioRow {
  id: string;
  name: string;
  type: string;
  population: number | null;
  electorate: number | null;
  parent_id: string | null;
}

// -- Data fetching -----------------------------------------------------------

async function buscarTerritorios(organizationId: string, tipo?: string) {
  const db = createServerClient();

  let query = db
    .from("pol_territories")
    .select("id, name, type, population, electorate, parent_id")
    .eq("organization_id", organizationId)
    .order("name", { ascending: true });

  if (tipo) {
    query = query.eq("type", tipo);
  }

  const { data } = await query;
  return (data as TerritorioRow[]) ?? [];
}

async function contarFilhos(organizationId: string): Promise<Record<string, number>> {
  const db = createServerClient();

  const { data } = await db
    .from("pol_territories")
    .select("parent_id")
    .eq("organization_id", organizationId)
    .not("parent_id", "is", null);

  const contagem: Record<string, number> = {};
  for (const row of data ?? []) {
    if (row.parent_id) {
      contagem[row.parent_id] = (contagem[row.parent_id] ?? 0) + 1;
    }
  }
  return contagem;
}

// -- Componente --------------------------------------------------------------

export default async function TerritoriosPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await getUser();
  if (!user) redirect("/login");

  const org = await resolverOrganizacaoAtiva(user.id);
  if (!org) redirect("/app/onboarding");

  const params = await searchParams;
  const tipo = typeof params.tipo === "string" ? params.tipo : undefined;

  const [territorios, filhosMap] = await Promise.all([
    buscarTerritorios(org.id, tipo),
    contarFilhos(org.id),
  ]);

  return (
    <div className="mx-auto max-w-5xl px-4 py-8 space-y-6">
      {/* Cabecalho */}
      <div>
        <div className="flex items-center gap-2">
          <Link
            href="/app/politico"
            className="text-sm text-muted-foreground hover:text-foreground transition-colors"
          >
            War Room
          </Link>
          <span className="text-sm text-muted-foreground">/</span>
          <h1 className="text-2xl font-bold tracking-tight">Territorios</h1>
        </div>
        <p className="mt-1 text-sm text-muted-foreground">
          {territorios.length} territorio{territorios.length !== 1 ? "s" : ""}
        </p>
      </div>

      {/* Filtro por tipo */}
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-xs text-muted-foreground">Tipo:</span>
        <div className="flex gap-1 flex-wrap">
          <Link
            href="/app/politico/territorios"
            className={`rounded-full px-2.5 py-0.5 text-xs font-medium transition-colors ${
              !tipo
                ? "bg-primary text-primary-foreground"
                : "bg-muted text-muted-foreground hover:bg-accent"
            }`}
          >
            Todos
          </Link>
          {TIPOS_TERRITORIO.map((t) => (
            <Link
              key={t.value}
              href={`/app/politico/territorios?tipo=${t.value}`}
              className={`rounded-full px-2.5 py-0.5 text-xs font-medium transition-colors ${
                tipo === t.value
                  ? "bg-primary text-primary-foreground"
                  : "bg-muted text-muted-foreground hover:bg-accent"
              }`}
            >
              {t.label}
            </Link>
          ))}
        </div>
      </div>

      {/* Cards */}
      {territorios.length === 0 ? (
        <div className="rounded-xl border bg-card p-12 text-center">
          <p className="text-sm text-muted-foreground">
            Nenhum territorio encontrado.
          </p>
        </div>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {territorios.map((territorio) => (
            <Link
              key={territorio.id}
              href={`/app/politico/territorios/${territorio.id}`}
              className="group flex flex-col gap-3 rounded-xl border bg-card p-5 transition-colors hover:bg-accent/30"
            >
              <div className="flex items-start justify-between gap-2">
                <h2 className="font-semibold group-hover:text-primary transition-colors leading-snug">
                  {territorio.name}
                </h2>
                <span
                  className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-medium ${corDoTipo(territorio.type)}`}
                >
                  {labelDoTipo(territorio.type)}
                </span>
              </div>

              <div className="grid grid-cols-3 gap-2 text-center">
                <div>
                  <span className="block text-lg font-bold tabular-nums">
                    {territorio.population != null
                      ? territorio.population.toLocaleString("pt-BR")
                      : "—"}
                  </span>
                  <span className="text-[10px] text-muted-foreground uppercase tracking-wider">
                    Populacao
                  </span>
                </div>
                <div>
                  <span className="block text-lg font-bold tabular-nums">
                    {territorio.electorate != null
                      ? territorio.electorate.toLocaleString("pt-BR")
                      : "—"}
                  </span>
                  <span className="text-[10px] text-muted-foreground uppercase tracking-wider">
                    Eleitorado
                  </span>
                </div>
                <div>
                  <span className="block text-lg font-bold tabular-nums">
                    {filhosMap[territorio.id] ?? 0}
                  </span>
                  <span className="text-[10px] text-muted-foreground uppercase tracking-wider">
                    Sub-regioes
                  </span>
                </div>
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
