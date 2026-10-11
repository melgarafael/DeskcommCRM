/**
 * /app/politico/adversarios — Painel de Adversarios Politicos
 *
 * Listagem paginada de pol_opponents com metricas agregadas
 * (total, risco alto, sinais ativos nos ultimos 7 dias).
 * Cards em grid com nivel de risco, threat score e seguidores.
 *
 * Acesso: manager+
 */

import { redirect } from "next/navigation";
import Link from "next/link";
import { createServerClient } from "@/lib/supabase/server";
import { getUser } from "@/lib/auth/get-user";
import { resolverOrganizacaoAtiva } from "@/lib/organizations/resolver";

// -- Tipos -------------------------------------------------------------------

interface MetricasAdversarios {
  total: number;
  riscoAlto: number;
  sinaisAtivos: number;
}

interface Adversario {
  id: string;
  name: string;
  platform: string;
  username: string | null;
  risk_level: string;
  threat_score: number;
  followers: number;
  active: boolean;
}

// -- Constantes --------------------------------------------------------------

const POR_PAGINA = 12;

const RISK_LEVEL_CONFIG: Record<string, { label: string; cor: string }> = {
  low: {
    label: "Baixo",
    cor: "bg-green-100 text-green-800 dark:bg-green-950 dark:text-green-200",
  },
  medium: {
    label: "Medio",
    cor: "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-200",
  },
  high: {
    label: "Alto",
    cor: "bg-orange-100 text-orange-800 dark:bg-orange-950 dark:text-orange-200",
  },
  critical: {
    label: "Critico",
    cor: "bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-200",
  },
};

// -- Data fetching -----------------------------------------------------------

async function buscarMetricas(organizationId: string): Promise<MetricasAdversarios> {
  const db = createServerClient();

  const seteDiasAtras = new Date();
  seteDiasAtras.setDate(seteDiasAtras.getDate() - 7);

  const [total, riscoAlto, sinaisAtivos] = await Promise.all([
    db
      .from("pol_opponents")
      .select("id", { count: "exact", head: true })
      .eq("organization_id", organizationId),

    db
      .from("pol_opponents")
      .select("id", { count: "exact", head: true })
      .eq("organization_id", organizationId)
      .in("risk_level", ["high", "critical"]),

    db
      .from("pol_opponent_signals")
      .select("id", { count: "exact", head: true })
      .eq("organization_id", organizationId)
      .gte("created_at", seteDiasAtras.toISOString()),
  ]);

  return {
    total: total.count ?? 0,
    riscoAlto: riscoAlto.count ?? 0,
    sinaisAtivos: sinaisAtivos.count ?? 0,
  };
}

async function buscarAdversarios(
  organizationId: string,
  pagina: number,
): Promise<{ adversarios: Adversario[]; total: number }> {
  const db = createServerClient();
  const offset = (pagina - 1) * POR_PAGINA;

  const { data, count } = await db
    .from("pol_opponents")
    .select("id, name, platform, username, risk_level, threat_score, followers, active", {
      count: "exact",
    })
    .eq("organization_id", organizationId)
    .order("threat_score", { ascending: false })
    .range(offset, offset + POR_PAGINA - 1);

  return {
    adversarios: (data ?? []) as Adversario[],
    total: count ?? 0,
  };
}

// -- Componente --------------------------------------------------------------

export default async function AdversariosPage(props: {
  searchParams: Promise<{ pagina?: string }>;
}) {
  const user = await getUser();
  if (!user) redirect("/login");

  const org = await resolverOrganizacaoAtiva(user.id);
  if (!org) redirect("/app/onboarding");

  const searchParams = await props.searchParams;
  const paginaAtual = Math.max(1, parseInt(searchParams.pagina ?? "1", 10) || 1);

  const [metricas, { adversarios, total }] = await Promise.all([
    buscarMetricas(org.id),
    buscarAdversarios(org.id, paginaAtual),
  ]);

  const totalPaginas = Math.ceil(total / POR_PAGINA);

  return (
    <div className="mx-auto max-w-4xl px-4 py-8 space-y-8">
      {/* Cabecalho */}
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Adversarios</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Monitore adversarios politicos, acompanhe niveis de ameaca e sinais de alerta da oposicao.
        </p>
      </div>

      {/* Metricas */}
      <div className="grid grid-cols-3 gap-3">
        <MetricaCard label="Total de adversarios" valor={metricas.total} />
        <MetricaCard label="Risco alto" valor={metricas.riscoAlto} />
        <MetricaCard label="Sinais ativos (7d)" valor={metricas.sinaisAtivos} />
      </div>

      {/* Grid de adversarios */}
      {adversarios.length > 0 ? (
        <>
          <div className="grid gap-4 sm:grid-cols-2">
            {adversarios.map((adv) => {
              const riskConfig = RISK_LEVEL_CONFIG[adv.risk_level] ?? RISK_LEVEL_CONFIG.low;

              return (
                <div
                  key={adv.id}
                  className="rounded-xl border bg-card p-4 space-y-3 hover:bg-accent/30 transition-colors"
                >
                  {/* Topo: nome + status */}
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="font-bold truncate">{adv.name}</p>
                      {adv.username && (
                        <p className="text-xs text-muted-foreground truncate">@{adv.username}</p>
                      )}
                    </div>
                    <span
                      className={`shrink-0 inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${
                        adv.active
                          ? "bg-green-100 text-green-800 dark:bg-green-950 dark:text-green-200"
                          : "bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400"
                      }`}
                    >
                      {adv.active ? "Ativo" : "Inativo"}
                    </span>
                  </div>

                  {/* Badges: plataforma + risco */}
                  <div className="flex items-center gap-2">
                    <span className="rounded-full bg-muted px-2 py-0.5 text-xs font-medium capitalize">
                      {adv.platform}
                    </span>
                    <span
                      className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${riskConfig.cor}`}
                    >
                      {riskConfig.label}
                    </span>
                  </div>

                  {/* Metricas do card */}
                  <div className="flex items-center gap-4 text-sm">
                    <div>
                      <span className="text-muted-foreground">Ameaca: </span>
                      <span className="font-semibold tabular-nums">{Number(adv.threat_score).toFixed(1)}</span>
                    </div>
                    <div>
                      <span className="text-muted-foreground">Seguidores: </span>
                      <span className="font-semibold tabular-nums">
                        {adv.followers.toLocaleString("pt-BR")}
                      </span>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>

          {/* Paginacao */}
          {totalPaginas > 1 && (
            <div className="flex items-center justify-between pt-2">
              <p className="text-xs text-muted-foreground">
                Pagina <span className="tabular-nums">{paginaAtual}</span> de{" "}
                <span className="tabular-nums">{totalPaginas}</span> ({total} adversario
                {total !== 1 ? "s" : ""})
              </p>
              <div className="flex gap-2">
                {paginaAtual > 1 && (
                  <Link
                    href={`/app/politico/adversarios?pagina=${paginaAtual - 1}`}
                    className="rounded-lg border bg-card px-3 py-1.5 text-xs font-medium hover:bg-accent transition-colors"
                  >
                    Anterior
                  </Link>
                )}
                {paginaAtual < totalPaginas && (
                  <Link
                    href={`/app/politico/adversarios?pagina=${paginaAtual + 1}`}
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
          <strong>Para comecar:</strong> cadastre o primeiro adversario politico para monitorar
          niveis de ameaca, crescimento e sinais de alerta da oposicao.
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
