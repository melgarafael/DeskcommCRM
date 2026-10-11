/**
 * /app/politico/social — Hub de Monitoramento Social
 *
 * Ponto de entrada do modulo de monitoramento social do War Room 2.0.
 * Apresenta metricas agregadas e listagem de perfis sociais monitorados.
 *
 * Acesso: manager+
 */

import { redirect } from "next/navigation";
import { createServerClient } from "@/lib/supabase/server";
import { getUser } from "@/lib/auth/get-user";
import { resolverOrganizacaoAtiva } from "@/lib/organizations/resolver";

// -- Tipos -------------------------------------------------------------------

interface MetricasSocial {
  totalPerfis: number;
  influenciadores: number;
  postsColetados: number;
  alertasInteligencia: number;
}

interface PerfilSocial {
  id: string;
  username: string;
  display_name: string | null;
  platform: string;
  followers: number;
  engagement_rate: number;
  category: string;
  active: boolean;
}

// -- Data fetching -----------------------------------------------------------

async function buscarMetricas(organizationId: string): Promise<MetricasSocial> {
  const db = createServerClient();

  const [totalPerfis, influenciadores, postsColetados, alertasInteligencia] = await Promise.all([
    db
      .from("pol_social_profiles")
      .select("id", { count: "exact", head: true })
      .eq("organization_id", organizationId),

    db
      .from("pol_social_profiles")
      .select("id", { count: "exact", head: true })
      .eq("organization_id", organizationId)
      .eq("category", "influencer"),

    db
      .from("pol_social_posts")
      .select("id", { count: "exact", head: true })
      .eq("organization_id", organizationId),

    db
      .from("pol_social_intelligence")
      .select("id", { count: "exact", head: true })
      .eq("organization_id", organizationId),
  ]);

  return {
    totalPerfis: totalPerfis.count ?? 0,
    influenciadores: influenciadores.count ?? 0,
    postsColetados: postsColetados.count ?? 0,
    alertasInteligencia: alertasInteligencia.count ?? 0,
  };
}

async function buscarPerfis(
  organizationId: string,
  pagina: number,
): Promise<{ perfis: PerfilSocial[]; total: number }> {
  const db = createServerClient();
  const limite = 20;
  const offset = (pagina - 1) * limite;

  const { data, count } = await db
    .from("pol_social_profiles")
    .select("id, username, display_name, platform, followers, engagement_rate, category, active", {
      count: "exact",
    })
    .eq("organization_id", organizationId)
    .order("followers", { ascending: false })
    .range(offset, offset + limite - 1);

  return {
    perfis: (data ?? []) as PerfilSocial[],
    total: count ?? 0,
  };
}

// -- Componente --------------------------------------------------------------

export default async function SocialHubPage(props: {
  searchParams: Promise<{ pagina?: string }>;
}) {
  const user = await getUser();
  if (!user) redirect("/login");

  const org = await resolverOrganizacaoAtiva(user.id);
  if (!org) redirect("/app/onboarding");

  const searchParams = await props.searchParams;
  const paginaAtual = Math.max(1, parseInt(searchParams.pagina ?? "1", 10) || 1);

  const [metricas, { perfis, total }] = await Promise.all([
    buscarMetricas(org.id),
    buscarPerfis(org.id, paginaAtual),
  ]);

  const totalPaginas = Math.ceil(total / 20);

  return (
    <div className="mx-auto max-w-4xl px-4 py-8 space-y-8">
      {/* Cabecalho */}
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Monitoramento Social</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Acompanhe perfis, metricas de engajamento e inteligencia de redes sociais da sua campanha.
        </p>
      </div>

      {/* Metricas */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <MetricaCard label="Total de perfis" valor={metricas.totalPerfis} />
        <MetricaCard label="Influenciadores" valor={metricas.influenciadores} />
        <MetricaCard label="Posts coletados" valor={metricas.postsColetados} />
        <MetricaCard label="Alertas de inteligencia" valor={metricas.alertasInteligencia} />
      </div>

      {/* Tabela de perfis */}
      {perfis.length > 0 ? (
        <div className="rounded-xl border bg-card">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left">
                  <th className="px-4 py-3 font-medium text-muted-foreground">Usuario</th>
                  <th className="px-4 py-3 font-medium text-muted-foreground">Plataforma</th>
                  <th className="px-4 py-3 font-medium text-muted-foreground text-right">Seguidores</th>
                  <th className="px-4 py-3 font-medium text-muted-foreground text-right">Engajamento</th>
                  <th className="px-4 py-3 font-medium text-muted-foreground">Categoria</th>
                  <th className="px-4 py-3 font-medium text-muted-foreground">Status</th>
                </tr>
              </thead>
              <tbody>
                {perfis.map((perfil) => (
                  <tr key={perfil.id} className="border-b last:border-b-0 hover:bg-accent/30 transition-colors">
                    <td className="px-4 py-3">
                      <div>
                        <span className="font-medium">@{perfil.username}</span>
                        {perfil.display_name && (
                          <span className="ml-2 text-xs text-muted-foreground">{perfil.display_name}</span>
                        )}
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <span className="rounded-full bg-muted px-2 py-0.5 text-xs font-medium capitalize">
                        {perfil.platform}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums">
                      {perfil.followers.toLocaleString("pt-BR")}
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums">
                      {perfil.engagement_rate.toFixed(2)}%
                    </td>
                    <td className="px-4 py-3">
                      <CategoriaLabel categoria={perfil.category} />
                    </td>
                    <td className="px-4 py-3">
                      <span
                        className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${
                          perfil.active
                            ? "bg-green-100 text-green-800 dark:bg-green-950 dark:text-green-200"
                            : "bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400"
                        }`}
                      >
                        {perfil.active ? "Ativo" : "Inativo"}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Paginacao */}
          {totalPaginas > 1 && (
            <div className="flex items-center justify-between border-t px-4 py-3 text-sm">
              <span className="text-muted-foreground">
                Pagina {paginaAtual} de {totalPaginas} ({total} perfis)
              </span>
              <div className="flex gap-2">
                {paginaAtual > 1 && (
                  <a
                    href={`/app/politico/social?pagina=${paginaAtual - 1}`}
                    className="rounded-md border px-3 py-1 text-sm hover:bg-accent transition-colors"
                  >
                    Anterior
                  </a>
                )}
                {paginaAtual < totalPaginas && (
                  <a
                    href={`/app/politico/social?pagina=${paginaAtual + 1}`}
                    className="rounded-md border px-3 py-1 text-sm hover:bg-accent transition-colors"
                  >
                    Proxima
                  </a>
                )}
              </div>
            </div>
          )}
        </div>
      ) : (
        /* Empty state */
        <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200">
          <strong>Para comecar:</strong> adicione o primeiro perfil social monitorado para
          acompanhar metricas de engajamento, crescimento e inteligencia da sua campanha.
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

const CATEGORIA_LABELS: Record<string, { label: string; cor: string }> = {
  monitorado: { label: "Monitorado", cor: "bg-blue-100 text-blue-800 dark:bg-blue-950 dark:text-blue-200" },
  influencer: { label: "Influenciador", cor: "bg-purple-100 text-purple-800 dark:bg-purple-950 dark:text-purple-200" },
  aliado: { label: "Aliado", cor: "bg-green-100 text-green-800 dark:bg-green-950 dark:text-green-200" },
  neutro: { label: "Neutro", cor: "bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400" },
  adversario: { label: "Adversario", cor: "bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-200" },
};

function CategoriaLabel({ categoria }: { categoria: string }) {
  const config = CATEGORIA_LABELS[categoria] ?? CATEGORIA_LABELS.monitorado;
  return (
    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${config.cor}`}>
      {config.label}
    </span>
  );
}
