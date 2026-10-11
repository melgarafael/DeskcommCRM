/**
 * /app/politico/dashboard — Dashboard principal War Room (Fase 4)
 *
 * Painel central com KPIs agregados: leads por nivel/temperatura,
 * eventos, alertas, pesquisas, perfis sociais, adversarios e fila de ligacoes.
 * View: pol_vw_warroom_dashboard + pol_vw_funil_kpis + pol_vw_call_queue_status.
 *
 * Acesso: manager+
 */

import { redirect } from "next/navigation";
import Link from "next/link";
import { createServerClient } from "@/lib/supabase/server";
import { getUser } from "@/lib/auth/get-user";
import { resolverOrganizacaoAtiva } from "@/lib/organizations/resolver";

// -- Tipos -------------------------------------------------------------------

interface DashboardData {
  organization_id: string;
  total_leads: number;
  votos_certos: number;
  militantes: number;
  apoiadores: number;
  simpatizantes: number;
  novos_cadastros: number;
  leads_quentes: number;
  leads_mornos: number;
  leads_frios: number;
  lideres_potenciais: number;
  total_eventos: number;
  eventos_proximos: number;
  alertas_ativos: number;
  alertas_criticos: number;
  pesquisas_ativas: number;
  perfis_monitorados: number;
  adversarios_ativos: number;
  ligacoes_pendentes: number;
}

interface FunilKpis {
  funil_total: number;
  funil_novo_cadastro: number;
  funil_simpatizante: number;
  funil_apoiador: number;
  funil_militante: number;
  funil_voto_certo: number;
  taxa_ativacao_pct: number;
  taxa_conversao_pct: number;
  invisivel_total: number;
  invisivel_awareness: number;
  invisivel_interest: number;
  invisivel_consideration: number;
  invisivel_intent: number;
  invisivel_evaluation: number;
  invisivel_conversion: number;
}

interface CallQueueStatus {
  total_chamadas: number;
  pendentes: number;
  completadas: number;
  sem_resposta: number;
  apoio_confirmado: number;
  indeciso: number;
  recusa: number;
  taxa_sucesso_pct: number;
  media_tentativas: number;
}

// -- Data fetching -----------------------------------------------------------

async function buscarDashboard(organizationId: string) {
  const db = createServerClient();

  const [dashRes, funilRes, callRes] = await Promise.all([
    db
      .from("pol_vw_warroom_dashboard")
      .select("*")
      .eq("organization_id", organizationId)
      .limit(1)
      .maybeSingle(),

    db
      .from("pol_vw_funil_kpis")
      .select("*")
      .eq("organization_id", organizationId)
      .limit(1)
      .maybeSingle(),

    db
      .from("pol_vw_call_queue_status")
      .select("*")
      .eq("organization_id", organizationId)
      .limit(1)
      .maybeSingle(),
  ]);

  if (dashRes.error) console.error("Erro dashboard:", dashRes.error.message);
  if (funilRes.error) console.error("Erro funil:", funilRes.error.message);
  if (callRes.error) console.error("Erro call queue:", callRes.error.message);

  return {
    dash: (dashRes.data ?? null) as DashboardData | null,
    funil: (funilRes.data ?? null) as FunilKpis | null,
    calls: (callRes.data ?? null) as CallQueueStatus | null,
  };
}

// -- Componente --------------------------------------------------------------

export default async function DashboardPage() {
  const user = await getUser();
  if (!user) redirect("/login");

  const org = await resolverOrganizacaoAtiva(user.id);
  if (!org) redirect("/app/onboarding");

  const { dash, funil, calls } = await buscarDashboard(org.id);

  return (
    <div className="mx-auto max-w-6xl px-4 py-8 space-y-8">
      {/* Voltar */}
      <Link
        href="/app/politico"
        className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground transition-colors"
      >
        &larr; War Room
      </Link>

      {/* Cabecalho */}
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Dashboard</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Painel central do War Room com KPIs consolidados da campanha.
        </p>
      </div>

      {dash ? (
        <>
          {/* KPIs principais */}
          <section className="space-y-3">
            <h2 className="text-sm font-medium text-muted-foreground uppercase tracking-wider">
              Visao geral
            </h2>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <KpiCard label="Total de leads" valor={dash.total_leads} icone={"\u{1F465}"} />
              <KpiCard label="Votos certos" valor={dash.votos_certos} icone={"✅"} />
              <KpiCard label="Militantes" valor={dash.militantes} icone={"\u{1F4AA}"} />
              <KpiCard label="Apoiadores" valor={dash.apoiadores} icone={"\u{1F91D}"} />
            </div>
          </section>

          {/* Temperatura */}
          <section className="space-y-3">
            <h2 className="text-sm font-medium text-muted-foreground uppercase tracking-wider">
              Temperatura dos leads
            </h2>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <KpiCard label="Quentes" valor={dash.leads_quentes} cor="text-red-600 dark:text-red-400" />
              <KpiCard label="Mornos" valor={dash.leads_mornos} cor="text-yellow-600 dark:text-yellow-400" />
              <KpiCard label="Frios" valor={dash.leads_frios} cor="text-blue-600 dark:text-blue-400" />
              <KpiCard label="Lideres potenciais" valor={dash.lideres_potenciais} icone={"\u{1F451}"} />
            </div>
          </section>

          {/* Modulos */}
          <section className="space-y-3">
            <h2 className="text-sm font-medium text-muted-foreground uppercase tracking-wider">
              Modulos ativos
            </h2>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <KpiCard label="Eventos" valor={dash.total_eventos} icone={"\u{1F4C5}"} destaque={dash.eventos_proximos > 0 ? `${dash.eventos_proximos} proximos` : undefined} />
              <KpiCard label="Alertas ativos" valor={dash.alertas_ativos} icone={"\u{1F514}"} destaque={dash.alertas_criticos > 0 ? `${dash.alertas_criticos} criticos` : undefined} />
              <KpiCard label="Pesquisas ativas" valor={dash.pesquisas_ativas} icone={"\u{1F4CB}"} />
              <KpiCard label="Perfis sociais" valor={dash.perfis_monitorados} icone={"\u{1F4F1}"} />
            </div>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <KpiCard label="Adversarios" valor={dash.adversarios_ativos} icone={"\u{1F6E1}️"} />
              <KpiCard label="Ligacoes pendentes" valor={dash.ligacoes_pendentes} icone={"\u{1F4DE}"} />
              <KpiCard label="Simpatizantes" valor={dash.simpatizantes} icone={"\u{1F64B}"} />
              <KpiCard label="Novos cadastros" valor={dash.novos_cadastros} icone={"\u{1F195}"} />
            </div>
          </section>
        </>
      ) : (
        <div className="rounded-xl border bg-card p-8 text-center text-sm text-muted-foreground">
          Nenhum dado disponivel. Cadastre leads politicos para ver o dashboard.
        </div>
      )}

      {/* Funil KPIs */}
      {funil && funil.funil_total > 0 && (
        <section className="space-y-3">
          <h2 className="text-sm font-medium text-muted-foreground uppercase tracking-wider">
            Funil politico
          </h2>
          <div className="rounded-xl border bg-card p-5 space-y-4">
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
              <FunilStep label="Novo cadastro" valor={funil.funil_novo_cadastro} total={funil.funil_total} cor="bg-gray-200 dark:bg-gray-700" />
              <FunilStep label="Simpatizante" valor={funil.funil_simpatizante} total={funil.funil_total} cor="bg-blue-200 dark:bg-blue-800" />
              <FunilStep label="Apoiador" valor={funil.funil_apoiador} total={funil.funil_total} cor="bg-yellow-200 dark:bg-yellow-800" />
              <FunilStep label="Militante" valor={funil.funil_militante} total={funil.funil_total} cor="bg-orange-200 dark:bg-orange-800" />
              <FunilStep label="Voto certo" valor={funil.funil_voto_certo} total={funil.funil_total} cor="bg-green-200 dark:bg-green-800" />
            </div>
            <div className="flex flex-wrap gap-4 text-sm text-muted-foreground">
              <span>Taxa de ativacao: <strong className="text-foreground">{funil.taxa_ativacao_pct}%</strong></span>
              <span>Taxa de conversao: <strong className="text-foreground">{funil.taxa_conversao_pct}%</strong></span>
            </div>
          </div>
        </section>
      )}

      {/* Funil Invisivel */}
      {funil && funil.invisivel_total > 0 && (
        <section className="space-y-3">
          <h2 className="text-sm font-medium text-muted-foreground uppercase tracking-wider">
            Funil invisivel
          </h2>
          <div className="rounded-xl border bg-card p-5">
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-6">
              <FunilStep label="Awareness" valor={funil.invisivel_awareness} total={funil.invisivel_total} cor="bg-gray-200 dark:bg-gray-700" />
              <FunilStep label="Interest" valor={funil.invisivel_interest} total={funil.invisivel_total} cor="bg-blue-200 dark:bg-blue-800" />
              <FunilStep label="Consideration" valor={funil.invisivel_consideration} total={funil.invisivel_total} cor="bg-indigo-200 dark:bg-indigo-800" />
              <FunilStep label="Intent" valor={funil.invisivel_intent} total={funil.invisivel_total} cor="bg-purple-200 dark:bg-purple-800" />
              <FunilStep label="Evaluation" valor={funil.invisivel_evaluation} total={funil.invisivel_total} cor="bg-orange-200 dark:bg-orange-800" />
              <FunilStep label="Conversion" valor={funil.invisivel_conversion} total={funil.invisivel_total} cor="bg-green-200 dark:bg-green-800" />
            </div>
          </div>
        </section>
      )}

      {/* Fila de ligacoes */}
      {calls && calls.total_chamadas > 0 && (
        <section className="space-y-3">
          <h2 className="text-sm font-medium text-muted-foreground uppercase tracking-wider">
            Fila de ligacoes
          </h2>
          <div className="rounded-xl border bg-card p-5">
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <KpiCard label="Total" valor={calls.total_chamadas} />
              <KpiCard label="Pendentes" valor={calls.pendentes} />
              <KpiCard label="Completadas" valor={calls.completadas} />
              <KpiCard label="Sem resposta" valor={calls.sem_resposta} />
            </div>
            <div className="mt-4 flex flex-wrap gap-4 text-sm text-muted-foreground">
              <span>Apoio confirmado: <strong className="text-foreground">{calls.apoio_confirmado}</strong></span>
              <span>Indeciso: <strong className="text-foreground">{calls.indeciso}</strong></span>
              <span>Recusa: <strong className="text-foreground">{calls.recusa}</strong></span>
              <span>Taxa de sucesso: <strong className="text-foreground">{calls.taxa_sucesso_pct}%</strong></span>
              <span>Media tentativas: <strong className="text-foreground">{calls.media_tentativas}</strong></span>
            </div>
          </div>
        </section>
      )}
    </div>
  );
}

// -- Sub-componentes ---------------------------------------------------------

function KpiCard({
  label,
  valor,
  icone,
  cor,
  destaque,
}: {
  label: string;
  valor: number;
  icone?: string;
  cor?: string;
  destaque?: string;
}) {
  return (
    <div className="flex flex-col gap-1 rounded-lg border bg-card p-4">
      {icone && <span className="text-lg">{icone}</span>}
      <span className={`text-2xl font-bold tabular-nums ${cor ?? ""}`}>
        {valor.toLocaleString("pt-BR")}
      </span>
      <span className="text-xs text-muted-foreground">{label}</span>
      {destaque && (
        <span className="text-xs font-medium text-amber-600 dark:text-amber-400">{destaque}</span>
      )}
    </div>
  );
}

function FunilStep({
  label,
  valor,
  total,
  cor,
}: {
  label: string;
  valor: number;
  total: number;
  cor: string;
}) {
  const pct = total > 0 ? Math.round((valor / total) * 100) : 0;

  return (
    <div className="flex flex-col gap-1">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className="text-lg font-bold tabular-nums">{valor.toLocaleString("pt-BR")}</span>
      <div className="h-2 rounded-full bg-secondary overflow-hidden">
        <div className={`h-full rounded-full ${cor}`} style={{ width: `${pct}%` }} />
      </div>
      <span className="text-xs text-muted-foreground tabular-nums">{pct}%</span>
    </div>
  );
}
