/**
 * /app/politico/funil — Visualizacao do funil politico
 *
 * Barras horizontais por estagio (novo_cadastro -> voto_certo) com contagem.
 * Transicoes recentes (ultimas 10) com nome do contato, from->to, data e autor.
 *
 * Acesso: manager+
 */

import { redirect } from "next/navigation";
import Link from "next/link";
import { createServerClient } from "@/lib/supabase/server";
import { getUser } from "@/lib/auth/get-user";
import { resolverOrganizacaoAtiva } from "@/lib/organizations/resolver";

// -- Constantes --------------------------------------------------------------

const ESTAGIOS_FUNIL = [
  { value: "novo_cadastro", label: "Novo cadastro", cor: "bg-zinc-400 dark:bg-zinc-500" },
  { value: "simpatizante", label: "Simpatizante", cor: "bg-blue-500 dark:bg-blue-600" },
  { value: "apoiador", label: "Apoiador", cor: "bg-emerald-500 dark:bg-emerald-600" },
  { value: "militante", label: "Militante", cor: "bg-amber-500 dark:bg-amber-600" },
  { value: "voto_certo", label: "Voto certo", cor: "bg-green-600 dark:bg-green-500" },
] as const;

function labelDoEstagio(value: string): string {
  return ESTAGIOS_FUNIL.find((e) => e.value === value)?.label ?? value;
}

// -- Tipos -------------------------------------------------------------------

interface TransicaoRow {
  id: string;
  from_stage: string;
  to_stage: string;
  created_at: string;
  reason: string | null;
  contacts: {
    name: string | null;
  } | null;
  changed_by_user: {
    email: string | null;
  } | null;
}

// -- Data fetching -----------------------------------------------------------

async function buscarContagemPorEstagio(
  organizationId: string,
): Promise<Record<string, number>> {
  const db = createServerClient();

  const { data } = await db
    .from("pol_leads")
    .select("support_level")
    .eq("organization_id", organizationId);

  const contagem: Record<string, number> = {};
  for (const estagio of ESTAGIOS_FUNIL) {
    contagem[estagio.value] = 0;
  }
  for (const row of data ?? []) {
    contagem[row.support_level] = (contagem[row.support_level] ?? 0) + 1;
  }
  return contagem;
}

async function buscarTransicoesRecentes(organizationId: string) {
  const db = createServerClient();

  const { data } = await db
    .from("pol_funnel_transitions")
    .select("id, from_stage, to_stage, created_at, reason, contacts(name)")
    .eq("organization_id", organizationId)
    .order("created_at", { ascending: false })
    .limit(10);

  return (data as unknown as TransicaoRow[]) ?? [];
}

// -- Componente --------------------------------------------------------------

export default async function FunilPoliticoPage() {
  const user = await getUser();
  if (!user) redirect("/login");

  const org = await resolverOrganizacaoAtiva(user.id);
  if (!org) redirect("/app/onboarding");

  const [contagem, transicoes] = await Promise.all([
    buscarContagemPorEstagio(org.id),
    buscarTransicoesRecentes(org.id),
  ]);

  const totalLeads = Object.values(contagem).reduce((a, b) => a + b, 0);
  const maiorEstagio = Math.max(...Object.values(contagem), 1);

  return (
    <div className="mx-auto max-w-4xl px-4 py-8 space-y-8">
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
          <h1 className="text-2xl font-bold tracking-tight">Funil Politico</h1>
        </div>
        <p className="mt-1 text-sm text-muted-foreground">
          Jornada dos contatos: de novo cadastro ate voto certo.{" "}
          <span className="tabular-nums font-medium text-foreground">{totalLeads}</span>{" "}
          lead{totalLeads !== 1 ? "s" : ""} no funil.
        </p>
      </div>

      {/* Barras do funil */}
      <div className="rounded-xl border bg-card p-6 space-y-4">
        <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider">
          Distribuicao por estagio
        </h2>
        <div className="space-y-3">
          {ESTAGIOS_FUNIL.map((estagio) => {
            const qtd = contagem[estagio.value] ?? 0;
            const pct = maiorEstagio > 0 ? (qtd / maiorEstagio) * 100 : 0;
            const pctTotal = totalLeads > 0 ? ((qtd / totalLeads) * 100).toFixed(1) : "0.0";

            return (
              <div key={estagio.value} className="space-y-1">
                <div className="flex items-center justify-between text-sm">
                  <span className="font-medium">{estagio.label}</span>
                  <span className="tabular-nums text-muted-foreground">
                    {qtd} <span className="text-xs">({pctTotal}%)</span>
                  </span>
                </div>
                <div className="h-6 w-full rounded-md bg-muted overflow-hidden">
                  <div
                    className={`h-full rounded-md transition-all ${estagio.cor}`}
                    style={{ width: `${Math.max(pct, qtd > 0 ? 2 : 0)}%` }}
                  />
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Transicoes recentes */}
      <div className="rounded-xl border bg-card overflow-hidden">
        <div className="px-6 py-4 border-b">
          <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider">
            Transicoes recentes
          </h2>
        </div>

        {transicoes.length === 0 ? (
          <div className="p-12 text-center">
            <p className="text-sm text-muted-foreground">
              Nenhuma transicao registrada ainda.
            </p>
          </div>
        ) : (
          <div className="divide-y">
            {transicoes.map((t) => {
              const data = new Date(t.created_at);
              const dataFormatada = data.toLocaleDateString("pt-BR", {
                day: "2-digit",
                month: "2-digit",
                year: "numeric",
                hour: "2-digit",
                minute: "2-digit",
              });

              return (
                <div key={t.id} className="flex items-center gap-4 px-6 py-3">
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium truncate">
                      {t.contacts?.name ?? "Contato desconhecido"}
                    </p>
                    <div className="flex items-center gap-1.5 mt-0.5">
                      <span className="text-xs text-muted-foreground">
                        {labelDoEstagio(t.from_stage)}
                      </span>
                      <span className="text-xs text-muted-foreground">{"→"}</span>
                      <span className="text-xs font-medium">
                        {labelDoEstagio(t.to_stage)}
                      </span>
                    </div>
                  </div>
                  <div className="text-right shrink-0">
                    <p className="text-xs text-muted-foreground tabular-nums">
                      {dataFormatada}
                    </p>
                    {t.reason && (
                      <p className="text-xs text-muted-foreground mt-0.5 max-w-[200px] truncate">
                        {t.reason}
                      </p>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
