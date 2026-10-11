/**
 * /app/politico — Hub politico (War Room 2.0)
 *
 * Ponto de entrada do modulo politico do DeskcommCRM.
 * Apresenta metricas e atalhos para: Leads Politicos, Territorios e Funil Politico.
 *
 * Acesso: manager+
 */

import { redirect } from "next/navigation";
import Link from "next/link";
import { createServerClient } from "@/lib/supabase/server";
import { getUser } from "@/lib/auth/get-user";
import { resolverOrganizacaoAtiva } from "@/lib/organizations/resolver";

// -- Tipos -------------------------------------------------------------------

interface MetricasPoliticas {
  totalLeads: number;
  votosCertos: number;
  territorios: number;
  transicoesHoje: number;
}

// -- Data fetching -----------------------------------------------------------

async function buscarMetricas(organizationId: string): Promise<MetricasPoliticas> {
  const db = createServerClient();
  const hoje = new Date();
  hoje.setHours(0, 0, 0, 0);
  const hojeISO = hoje.toISOString();

  const [totalLeads, votosCertos, territorios, transicoesHoje] = await Promise.all([
    db
      .from("pol_leads")
      .select("id", { count: "exact", head: true })
      .eq("organization_id", organizationId),

    db
      .from("pol_leads")
      .select("id", { count: "exact", head: true })
      .eq("organization_id", organizationId)
      .eq("support_level", "voto_certo"),

    db
      .from("pol_territories")
      .select("id", { count: "exact", head: true })
      .eq("organization_id", organizationId),

    db
      .from("pol_funnel_transitions")
      .select("id", { count: "exact", head: true })
      .eq("organization_id", organizationId)
      .gte("created_at", hojeISO),
  ]);

  return {
    totalLeads: totalLeads.count ?? 0,
    votosCertos: votosCertos.count ?? 0,
    territorios: territorios.count ?? 0,
    transicoesHoje: transicoesHoje.count ?? 0,
  };
}

// -- Componente --------------------------------------------------------------

export default async function PoliticoHubPage() {
  const user = await getUser();
  if (!user) redirect("/login");

  const org = await resolverOrganizacaoAtiva(user.id);
  if (!org) redirect("/app/onboarding");

  const metricas = await buscarMetricas(org.id);

  const secoes = [
    {
      href: "/app/politico/leads",
      titulo: "Leads Politicos",
      descricao:
        "Gerencie sua base de apoiadores, simpatizantes e militantes com scoring politico e funil dedicado.",
      icone: "\u{1F465}",
      badge:
        metricas.totalLeads > 0
          ? `${metricas.totalLeads} lead${metricas.totalLeads !== 1 ? "s" : ""}`
          : null,
    },
    {
      href: "/app/politico/territorios",
      titulo: "Territorios",
      descricao:
        "Mapeie estados, cidades, bairros e zonas eleitorais com dados do IBGE e TSE integrados.",
      icone: "\u{1F5FA}️",
      badge:
        metricas.territorios > 0
          ? `${metricas.territorios} territorio${metricas.territorios !== 1 ? "s" : ""}`
          : null,
    },
    {
      href: "/app/politico/funil",
      titulo: "Funil Politico",
      descricao:
        "Acompanhe a jornada dos contatos pelo funil: de novo cadastro ate voto certo, com historico de transicoes.",
      icone: "\u{1F4CA}",
      badge:
        metricas.transicoesHoje > 0
          ? `${metricas.transicoesHoje} hoje`
          : null,
    },
    {
      href: "/app/politico/social",
      titulo: "Social",
      descricao:
        "Monitore perfis sociais, acompanhe metricas e analise posts coletados das redes.",
      icone: "\u{1F4F1}",
      badge: null,
    },
    {
      href: "/app/politico/adversarios",
      titulo: "Adversarios",
      descricao:
        "Rastreie oponentes politicos com nivel de risco, ameaca e sinais de alerta.",
      icone: "\u{1F6E1}️",
      badge: null,
    },
    {
      href: "/app/politico/narrativas",
      titulo: "Narrativas",
      descricao:
        "Radar de narrativas ativas com sentimento, forca e status estrategico por plataforma.",
      icone: "\u{1F4E1}",
      badge: null,
    },
    {
      href: "/app/politico/motor-viral",
      titulo: "Motor Viral",
      descricao:
        "Gere conteudo por IA — scripts de video, captions, roteiros com scoring de viralidade.",
      icone: "\u{26A1}",
      badge: null,
    },
    {
      href: "/app/politico/ligacoes",
      titulo: "Ligacoes",
      descricao:
        "Fila de ligacoes com lock otimista, resultado politico e controle de tentativas.",
      icone: "\u{1F4DE}",
      badge: null,
    },
    {
      href: "/app/politico/eventos",
      titulo: "Eventos",
      descricao:
        "Eventos politicos com controle de presenca, participantes e dados institucionais.",
      icone: "\u{1F4C5}",
      badge: null,
    },
    {
      href: "/app/politico/funil-invisivel",
      titulo: "Funil Invisivel",
      descricao:
        "Nurturing automatico com scoring de afinidade e rastreamento de engajamento.",
      icone: "\u{1F441}️",
      badge: null,
    },
    {
      href: "/app/politico/pesquisas",
      titulo: "Pesquisas",
      descricao:
        "Pesquisas de campo com formularios publicos e respostas geolocalizadas.",
      icone: "\u{1F4CB}",
      badge: null,
    },
    {
      href: "/app/politico/alertas",
      titulo: "Alertas",
      descricao:
        "Sistema unificado de alertas — sentimento, crise, fake news e adversarios.",
      icone: "\u{1F514}",
      badge: null,
    },
  ];

  return (
    <div className="mx-auto max-w-4xl px-4 py-8 space-y-8">
      {/* Cabecalho */}
      <div>
        <h1 className="text-2xl font-bold tracking-tight">War Room</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Modulo politico — gerencie leads, territorios e o funil de apoio da sua campanha.
        </p>
      </div>

      {/* Metricas */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <MetricaCard label="Total de leads" valor={metricas.totalLeads} icone={"\u{1F465}"} />
        <MetricaCard label="Votos certos" valor={metricas.votosCertos} icone={"✅"} />
        <MetricaCard label="Territorios" valor={metricas.territorios} icone={"\u{1F5FA}️"} />
        <MetricaCard label="Transicoes hoje" valor={metricas.transicoesHoje} icone={"\u{1F504}"} />
      </div>

      {/* Secoes */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {secoes.map((secao) => (
          <Link
            key={secao.href}
            href={secao.href}
            className="group relative flex flex-col gap-3 rounded-xl border bg-card p-5 transition-colors hover:bg-accent/30"
          >
            <div className="flex items-center justify-between">
              <span className="text-2xl">{secao.icone}</span>
              {secao.badge && (
                <span className="rounded-full bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary">
                  {secao.badge}
                </span>
              )}
            </div>
            <div>
              <h2 className="font-semibold group-hover:text-primary transition-colors">
                {secao.titulo}
              </h2>
              <p className="mt-1 text-sm text-muted-foreground leading-snug">
                {secao.descricao}
              </p>
            </div>
          </Link>
        ))}
      </div>

      {/* Instrucao quando vazio */}
      {metricas.totalLeads === 0 && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200">
          <strong>Para comecar:</strong> cadastre seus primeiros leads politicos em{" "}
          <Link href="/app/politico/leads" className="font-medium underline underline-offset-4">
            Leads Politicos
          </Link>{" "}
          e mapeie seus territorios de atuacao.
        </div>
      )}
    </div>
  );
}

// -- Sub-componentes ---------------------------------------------------------

function MetricaCard({
  label,
  valor,
  icone,
}: {
  label: string;
  valor: number;
  icone: string;
}) {
  return (
    <div className="flex flex-col gap-1 rounded-lg border bg-card p-4">
      <span className="text-lg">{icone}</span>
      <span className="text-2xl font-bold tabular-nums">{valor}</span>
      <span className="text-xs text-muted-foreground">{label}</span>
    </div>
  );
}
