/**
 * /app/instagram — Hub do canal Instagram
 *
 * Ponto de entrada do motor ManyChat próprio do GIP War Room 2.0.
 * Apresenta atalhos para: Automações, Tokens de Webhook, Etiquetas e
 * métricas básicas do canal (comentários recebidos, DMs enviadas, flows ativos).
 *
 * Acesso: manager+
 */

import { redirect } from "next/navigation";
import Link from "next/link";
import { createServerClient } from "@/lib/supabase/server";
import { getUser } from "@/lib/auth/get-user";
import { resolverOrganizacaoAtiva } from "@/lib/organizations/resolver";

// ── Tipos ──────────────────────────────────────────────────────────────────────

interface MetricasCanal {
  flowsAtivos: number;
  comentariosHoje: number;
  dmsEnviadasHoje: number;
  tokensAtivos: number;
}

// ── Data fetching ──────────────────────────────────────────────────────────────

async function buscarMetricas(organizationId: string): Promise<MetricasCanal> {
  const db = createServerClient();
  const hoje = new Date();
  hoje.setHours(0, 0, 0, 0);
  const hojeISO = hoje.toISOString();

  const [flows, comentarios, dms, tokens] = await Promise.all([
    db
      .from("ig_automation_flows")
      .select("id", { count: "exact", head: true })
      .eq("organization_id", organizationId)
      .eq("ativo", true),

    db
      .from("ig_comment_events")
      .select("id", { count: "exact", head: true })
      .eq("organization_id", organizationId)
      .gte("received_at", hojeISO),

    db
      .from("ig_comment_events")
      .select("id", { count: "exact", head: true })
      .eq("organization_id", organizationId)
      .eq("dm_enviada", true)
      .gte("dm_enviada_at", hojeISO),

    db
      .from("ig_webhook_tokens")
      .select("id", { count: "exact", head: true })
      .eq("organization_id", organizationId)
      .eq("ativo", true),
  ]);

  return {
    flowsAtivos: flows.count ?? 0,
    comentariosHoje: comentarios.count ?? 0,
    dmsEnviadasHoje: dms.count ?? 0,
    tokensAtivos: tokens.count ?? 0,
  };
}

// ── Componente ─────────────────────────────────────────────────────────────────

export default async function InstagramHubPage() {
  const user = await getUser();
  if (!user) redirect("/login");

  const org = await resolverOrganizacaoAtiva(user.id);
  if (!org) redirect("/app/onboarding");

  const metricas = await buscarMetricas(org.id);

  const secoes = [
    {
      href: "/app/instagram/automacoes",
      titulo: "Automações",
      descricao:
        "Crie flows para responder comentários e enviar DMs automaticamente — como o ManyChat, mas seu.",
      icone: "⚡",
      badge: metricas.flowsAtivos > 0 ? `${metricas.flowsAtivos} ativo${metricas.flowsAtivos !== 1 ? "s" : ""}` : null,
    },
    {
      href: "/app/instagram/webhooks",
      titulo: "Tokens de Webhook",
      descricao:
        "Gere e gerencie os tokens de URL que conectam seu Instagram Business ao sistema via Graph API.",
      icone: "🔗",
      badge: metricas.tokensAtivos > 0 ? `${metricas.tokensAtivos} token${metricas.tokensAtivos !== 1 ? "s" : ""}` : null,
    },
    {
      href: "/app/instagram/etiquetas",
      titulo: "Etiquetas",
      descricao:
        "Gerencie as etiquetas que as automações aplicam automaticamente nos contatos ao comentar.",
      icone: "🏷️",
      badge: null,
    },
  ];

  return (
    <div className="mx-auto max-w-4xl px-4 py-8 space-y-8">
      {/* Cabeçalho */}
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Instagram</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Motor ManyChat próprio — responda comentários e envie DMs automaticamente.
        </p>
      </div>

      {/* Métricas do dia */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <MetricaCard
          label="Flows ativos"
          valor={metricas.flowsAtivos}
          icone="⚡"
        />
        <MetricaCard
          label="Comentários hoje"
          valor={metricas.comentariosHoje}
          icone="💬"
        />
        <MetricaCard
          label="DMs enviadas hoje"
          valor={metricas.dmsEnviadasHoje}
          icone="📨"
        />
        <MetricaCard
          label="Tokens ativos"
          valor={metricas.tokensAtivos}
          icone="🔗"
        />
      </div>

      {/* Seções */}
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

      {/* Instrução de configuração — aparece quando não há tokens */}
      {metricas.tokensAtivos === 0 && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200">
          <strong>Para começar:</strong> gere um token de webhook em{" "}
          <Link href="/app/instagram/webhooks" className="font-medium underline underline-offset-4">
            Tokens de Webhook
          </Link>{" "}
          e configure-o no seu App Meta (Instagram Business).
        </div>
      )}
    </div>
  );
}

// ── Sub-componentes ────────────────────────────────────────────────────────────

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
