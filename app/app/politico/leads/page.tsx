/**
 * /app/politico/leads — Lista de leads politicos
 *
 * Tabela paginada de pol_leads com join em contacts (nome, telefone).
 * Filtros por support_level e temperature. Link para detalhe individual.
 *
 * Acesso: manager+
 */

import { redirect } from "next/navigation";
import Link from "next/link";
import { createServerClient } from "@/lib/supabase/server";
import { getUser } from "@/lib/auth/get-user";
import { resolverOrganizacaoAtiva } from "@/lib/organizations/resolver";

// -- Constantes --------------------------------------------------------------

const POR_PAGINA = 25;

const SUPPORT_LEVELS = [
  { value: "novo_cadastro", label: "Novo cadastro", cor: "bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300" },
  { value: "simpatizante", label: "Simpatizante", cor: "bg-blue-100 text-blue-700 dark:bg-blue-900 dark:text-blue-300" },
  { value: "apoiador", label: "Apoiador", cor: "bg-emerald-100 text-emerald-700 dark:bg-emerald-900 dark:text-emerald-300" },
  { value: "militante", label: "Militante", cor: "bg-amber-100 text-amber-700 dark:bg-amber-900 dark:text-amber-300" },
  { value: "voto_certo", label: "Voto certo", cor: "bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-300" },
] as const;

const TEMPERATURES = [
  { value: "frio", label: "Frio", cor: "bg-sky-100 text-sky-700 dark:bg-sky-900 dark:text-sky-300" },
  { value: "morno", label: "Morno", cor: "bg-orange-100 text-orange-700 dark:bg-orange-900 dark:text-orange-300" },
  { value: "quente", label: "Quente", cor: "bg-red-100 text-red-700 dark:bg-red-900 dark:text-red-300" },
] as const;

// -- Helpers -----------------------------------------------------------------

function corDoSupportLevel(value: string): string {
  return SUPPORT_LEVELS.find((s) => s.value === value)?.cor ?? "bg-zinc-100 text-zinc-700";
}

function labelDoSupportLevel(value: string): string {
  return SUPPORT_LEVELS.find((s) => s.value === value)?.label ?? value;
}

function corDaTemperature(value: string): string {
  return TEMPERATURES.find((t) => t.value === value)?.cor ?? "bg-zinc-100 text-zinc-700";
}

function labelDaTemperature(value: string): string {
  return TEMPERATURES.find((t) => t.value === value)?.label ?? value;
}

// -- Tipos -------------------------------------------------------------------

interface LeadRow {
  id: string;
  support_level: string;
  temperature: string;
  political_score: number;
  territory_id: string | null;
  contacts: {
    name: string | null;
    phone: string | null;
  } | null;
  pol_territories: {
    name: string;
  } | null;
}

// -- Data fetching -----------------------------------------------------------

async function buscarLeads(
  organizationId: string,
  pagina: number,
  supportLevel?: string,
  temperature?: string,
) {
  const db = createServerClient();
  const offset = (pagina - 1) * POR_PAGINA;

  let query = db
    .from("pol_leads")
    .select(
      "id, support_level, temperature, political_score, territory_id, contacts(name, phone), pol_territories(name)",
      { count: "exact" },
    )
    .eq("organization_id", organizationId)
    .order("created_at", { ascending: false })
    .range(offset, offset + POR_PAGINA - 1);

  if (supportLevel) {
    query = query.eq("support_level", supportLevel);
  }
  if (temperature) {
    query = query.eq("temperature", temperature);
  }

  const { data, count } = await query;

  return {
    leads: (data as unknown as LeadRow[]) ?? [],
    total: count ?? 0,
  };
}

// -- Componente --------------------------------------------------------------

export default async function LeadsPoliticosPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await getUser();
  if (!user) redirect("/login");

  const org = await resolverOrganizacaoAtiva(user.id);
  if (!org) redirect("/app/onboarding");

  const params = await searchParams;
  const pagina = Math.max(1, Number(params.pagina) || 1);
  const supportLevel = typeof params.nivel === "string" ? params.nivel : undefined;
  const temperature = typeof params.temperatura === "string" ? params.temperatura : undefined;

  const { leads, total } = await buscarLeads(org.id, pagina, supportLevel, temperature);
  const totalPaginas = Math.ceil(total / POR_PAGINA);

  // Montar query string base para paginacao e filtros
  function montarQuery(overrides: Record<string, string | undefined>) {
    const q = new URLSearchParams();
    const merged = { nivel: supportLevel, temperatura: temperature, ...overrides };
    for (const [k, v] of Object.entries(merged)) {
      if (v) q.set(k, v);
    }
    const s = q.toString();
    return s ? `?${s}` : "";
  }

  return (
    <div className="mx-auto max-w-5xl px-4 py-8 space-y-6">
      {/* Cabecalho */}
      <div className="flex items-center justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <Link
              href="/app/politico"
              className="text-sm text-muted-foreground hover:text-foreground transition-colors"
            >
              War Room
            </Link>
            <span className="text-sm text-muted-foreground">/</span>
            <h1 className="text-2xl font-bold tracking-tight">Leads Politicos</h1>
          </div>
          <p className="mt-1 text-sm text-muted-foreground">
            {total} lead{total !== 1 ? "s" : ""} cadastrado{total !== 1 ? "s" : ""}
          </p>
        </div>
        <Link
          href="/app/politico/leads/novo"
          className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 transition-colors"
        >
          + Novo Lead
        </Link>
      </div>

      {/* Filtros */}
      <div className="flex flex-wrap gap-3">
        {/* Filtro por nivel */}
        <div className="flex items-center gap-2">
          <span className="text-xs text-muted-foreground">Nivel:</span>
          <div className="flex gap-1">
            <Link
              href={`/app/politico/leads${montarQuery({ nivel: undefined, pagina: "1" })}`}
              className={`rounded-full px-2.5 py-0.5 text-xs font-medium transition-colors ${
                !supportLevel
                  ? "bg-primary text-primary-foreground"
                  : "bg-muted text-muted-foreground hover:bg-accent"
              }`}
            >
              Todos
            </Link>
            {SUPPORT_LEVELS.map((s) => (
              <Link
                key={s.value}
                href={`/app/politico/leads${montarQuery({ nivel: s.value, pagina: "1" })}`}
                className={`rounded-full px-2.5 py-0.5 text-xs font-medium transition-colors ${
                  supportLevel === s.value
                    ? "bg-primary text-primary-foreground"
                    : "bg-muted text-muted-foreground hover:bg-accent"
                }`}
              >
                {s.label}
              </Link>
            ))}
          </div>
        </div>

        {/* Filtro por temperatura */}
        <div className="flex items-center gap-2">
          <span className="text-xs text-muted-foreground">Temperatura:</span>
          <div className="flex gap-1">
            <Link
              href={`/app/politico/leads${montarQuery({ temperatura: undefined, pagina: "1" })}`}
              className={`rounded-full px-2.5 py-0.5 text-xs font-medium transition-colors ${
                !temperature
                  ? "bg-primary text-primary-foreground"
                  : "bg-muted text-muted-foreground hover:bg-accent"
              }`}
            >
              Todas
            </Link>
            {TEMPERATURES.map((t) => (
              <Link
                key={t.value}
                href={`/app/politico/leads${montarQuery({ temperatura: t.value, pagina: "1" })}`}
                className={`rounded-full px-2.5 py-0.5 text-xs font-medium transition-colors ${
                  temperature === t.value
                    ? "bg-primary text-primary-foreground"
                    : "bg-muted text-muted-foreground hover:bg-accent"
                }`}
              >
                {t.label}
              </Link>
            ))}
          </div>
        </div>
      </div>

      {/* Tabela */}
      {leads.length === 0 ? (
        <div className="rounded-xl border bg-card p-12 text-center">
          <p className="text-sm text-muted-foreground">
            Nenhum lead politico encontrado.
          </p>
        </div>
      ) : (
        <div className="rounded-xl border bg-card overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b bg-muted/50">
                  <th className="px-4 py-3 text-left font-medium text-muted-foreground">
                    Contato
                  </th>
                  <th className="px-4 py-3 text-left font-medium text-muted-foreground">
                    Nivel de apoio
                  </th>
                  <th className="px-4 py-3 text-left font-medium text-muted-foreground">
                    Temperatura
                  </th>
                  <th className="px-4 py-3 text-left font-medium text-muted-foreground">
                    Territorio
                  </th>
                  <th className="px-4 py-3 text-right font-medium text-muted-foreground">
                    Score
                  </th>
                </tr>
              </thead>
              <tbody>
                {leads.map((lead) => (
                  <tr key={lead.id} className="border-b last:border-0 hover:bg-muted/30 transition-colors">
                    <td className="px-4 py-3">
                      <Link
                        href={`/app/politico/leads/${lead.id}`}
                        className="font-medium hover:text-primary transition-colors"
                      >
                        {lead.contacts?.name ?? "Sem nome"}
                      </Link>
                      {lead.contacts?.phone && (
                        <p className="text-xs text-muted-foreground mt-0.5">
                          {lead.contacts.phone}
                        </p>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${corDoSupportLevel(lead.support_level)}`}>
                        {labelDoSupportLevel(lead.support_level)}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${corDaTemperature(lead.temperature)}`}>
                        {labelDaTemperature(lead.temperature)}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-muted-foreground">
                      {lead.pol_territories?.name ?? "—"}
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums font-medium">
                      {lead.political_score}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Paginacao */}
      {totalPaginas > 1 && (
        <div className="flex items-center justify-between pt-2">
          <p className="text-xs text-muted-foreground">
            Pagina <span className="tabular-nums">{pagina}</span> de{" "}
            <span className="tabular-nums">{totalPaginas}</span>
          </p>
          <div className="flex gap-2">
            {pagina > 1 && (
              <Link
                href={`/app/politico/leads${montarQuery({ pagina: String(pagina - 1) })}`}
                className="rounded-lg border bg-card px-3 py-1.5 text-xs font-medium hover:bg-accent transition-colors"
              >
                Anterior
              </Link>
            )}
            {pagina < totalPaginas && (
              <Link
                href={`/app/politico/leads${montarQuery({ pagina: String(pagina + 1) })}`}
                className="rounded-lg border bg-card px-3 py-1.5 text-xs font-medium hover:bg-accent transition-colors"
              >
                Proxima
              </Link>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
