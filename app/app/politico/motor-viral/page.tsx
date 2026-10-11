/**
 * /app/politico/motor-viral — Motor Viral (Gerador de Conteudo)
 *
 * Listagem paginada de pol_generated_content com metricas agregadas
 * (total de conteudos, gerados por IA, score viral medio).
 * Cards em grid com tipo, plataforma, scores e fonte de geracao.
 *
 * Acesso: manager+
 */

import { redirect } from "next/navigation";
import Link from "next/link";
import { createServerClient } from "@/lib/supabase/server";
import { getUser } from "@/lib/auth/get-user";
import { resolverOrganizacaoAtiva } from "@/lib/organizations/resolver";

// -- Tipos -------------------------------------------------------------------

interface MetricasMotorViral {
  totalConteudos: number;
  geradosPorIA: number;
  scoreViralMedio: number;
}

interface ConteudoGerado {
  id: string;
  title: string;
  topic: string;
  target_audience: string | null;
  content_type: string;
  platform: string | null;
  viral_score: number | null;
  quality_score: number | null;
  generation_source: string;
  created_at: string;
}

// -- Constantes --------------------------------------------------------------

const POR_PAGINA = 12;

const CONTENT_TYPE_LABELS: Record<string, string> = {
  video_script: "Roteiro de Video",
  caption: "Legenda",
  carousel: "Carrossel",
  story: "Story",
  reel_script: "Roteiro de Reel",
  live_script: "Roteiro de Live",
  article: "Artigo",
  thread: "Thread",
  other: "Outro",
};

const PLATFORM_LABELS: Record<string, string> = {
  instagram: "Instagram",
  facebook: "Facebook",
  twitter: "Twitter",
  tiktok: "TikTok",
  youtube: "YouTube",
  linkedin: "LinkedIn",
  whatsapp: "WhatsApp",
  cross_platform: "Multiplataforma",
};

const GENERATION_SOURCE_CONFIG: Record<string, { label: string; cor: string }> = {
  manual: {
    label: "Manual",
    cor: "bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300",
  },
  ai_auto: {
    label: "IA Auto",
    cor: "bg-purple-100 text-purple-800 dark:bg-purple-950 dark:text-purple-200",
  },
  ai_assisted: {
    label: "IA Assistida",
    cor: "bg-blue-100 text-blue-800 dark:bg-blue-950 dark:text-blue-200",
  },
  template: {
    label: "Template",
    cor: "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-200",
  },
};

// -- Data fetching -----------------------------------------------------------

async function buscarMetricas(organizationId: string): Promise<MetricasMotorViral> {
  const db = createServerClient();

  const [totalRes, iaRes, viralRes] = await Promise.all([
    db
      .from("pol_generated_content")
      .select("id", { count: "exact", head: true })
      .eq("organization_id", organizationId),

    db
      .from("pol_generated_content")
      .select("id", { count: "exact", head: true })
      .eq("organization_id", organizationId)
      .in("generation_source", ["ai_auto", "ai_assisted"]),

    db
      .from("pol_generated_content")
      .select("viral_score")
      .eq("organization_id", organizationId)
      .not("viral_score", "is", null),
  ]);

  const scores = (viralRes.data ?? []) as { viral_score: number }[];
  const scoreViralMedio =
    scores.length > 0
      ? scores.reduce((acc, row) => acc + Number(row.viral_score), 0) / scores.length
      : 0;

  return {
    totalConteudos: totalRes.count ?? 0,
    geradosPorIA: iaRes.count ?? 0,
    scoreViralMedio: Math.round(scoreViralMedio * 100) / 100,
  };
}

async function buscarConteudos(
  organizationId: string,
  pagina: number,
): Promise<{ conteudos: ConteudoGerado[]; total: number }> {
  const db = createServerClient();
  const offset = (pagina - 1) * POR_PAGINA;

  const { data, count } = await db
    .from("pol_generated_content")
    .select(
      "id, title, topic, target_audience, content_type, platform, viral_score, quality_score, generation_source, created_at",
      { count: "exact" },
    )
    .eq("organization_id", organizationId)
    .order("created_at", { ascending: false })
    .range(offset, offset + POR_PAGINA - 1);

  return {
    conteudos: (data ?? []) as ConteudoGerado[],
    total: count ?? 0,
  };
}

// -- Componente --------------------------------------------------------------

export default async function MotorViralPage(props: {
  searchParams: Promise<{ pagina?: string }>;
}) {
  const user = await getUser();
  if (!user) redirect("/login");

  const org = await resolverOrganizacaoAtiva(user.id);
  if (!org) redirect("/app/onboarding");

  const searchParams = await props.searchParams;
  const paginaAtual = Math.max(1, parseInt(searchParams.pagina ?? "1", 10) || 1);

  const [metricas, { conteudos, total }] = await Promise.all([
    buscarMetricas(org.id),
    buscarConteudos(org.id, paginaAtual),
  ]);

  const totalPaginas = Math.ceil(total / POR_PAGINA);

  return (
    <div className="mx-auto max-w-4xl px-4 py-8 space-y-8">
      {/* Cabecalho */}
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Motor Viral</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Gere conteudos otimizados por inteligencia artificial para maximizar o alcance e
          engajamento da sua campanha nas redes sociais.
        </p>
      </div>

      {/* Metricas */}
      <div className="grid grid-cols-3 gap-3">
        <MetricaCard label="Total de conteudos" valor={metricas.totalConteudos.toLocaleString("pt-BR")} />
        <MetricaCard label="Gerados por IA" valor={metricas.geradosPorIA.toLocaleString("pt-BR")} />
        <MetricaCard label="Score viral medio" valor={metricas.scoreViralMedio.toFixed(1)} />
      </div>

      {/* Grid de conteudos */}
      {conteudos.length > 0 ? (
        <>
          <div className="grid gap-4 sm:grid-cols-2">
            {conteudos.map((conteudo) => (
              <ConteudoCard key={conteudo.id} conteudo={conteudo} />
            ))}
          </div>

          {/* Paginacao */}
          {totalPaginas > 1 && (
            <div className="flex items-center justify-between rounded-xl border bg-card px-4 py-3 text-sm">
              <span className="text-muted-foreground">
                Pagina {paginaAtual} de {totalPaginas} ({total} conteudos)
              </span>
              <div className="flex gap-2">
                {paginaAtual > 1 && (
                  <Link
                    href={`/app/politico/motor-viral?pagina=${paginaAtual - 1}`}
                    className="rounded-md border px-3 py-1 text-sm hover:bg-accent transition-colors"
                  >
                    Anterior
                  </Link>
                )}
                {paginaAtual < totalPaginas && (
                  <Link
                    href={`/app/politico/motor-viral?pagina=${paginaAtual + 1}`}
                    className="rounded-md border px-3 py-1 text-sm hover:bg-accent transition-colors"
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
          <strong>Para comecar:</strong> crie seu primeiro conteudo com inteligencia artificial para
          impulsionar o engajamento e o alcance da sua campanha nas redes sociais.
        </div>
      )}
    </div>
  );
}

// -- Sub-componentes ---------------------------------------------------------

function MetricaCard({ label, valor }: { label: string; valor: string }) {
  return (
    <div className="flex flex-col gap-1 rounded-lg border bg-card p-4">
      <span className="text-2xl font-bold tabular-nums">{valor}</span>
      <span className="text-xs text-muted-foreground">{label}</span>
    </div>
  );
}

function ScoreDisplay({ score, label }: { score: number | null; label: string }) {
  if (score == null) {
    return (
      <div className="flex items-center gap-1">
        <span className="text-xs text-muted-foreground">{label}:</span>
        <span className="text-xs text-muted-foreground">--</span>
      </div>
    );
  }

  const corTexto =
    score >= 7
      ? "text-green-700 dark:text-green-400"
      : score >= 4
        ? "text-amber-700 dark:text-amber-400"
        : "text-red-700 dark:text-red-400";

  return (
    <div className="flex items-center gap-1">
      <span className="text-xs text-muted-foreground">{label}:</span>
      <span className={`text-sm font-bold tabular-nums ${corTexto}`}>{Number(score).toFixed(1)}</span>
    </div>
  );
}

function ConteudoCard({ conteudo }: { conteudo: ConteudoGerado }) {
  const sourceConfig = GENERATION_SOURCE_CONFIG[conteudo.generation_source] ??
    GENERATION_SOURCE_CONFIG.manual;

  return (
    <div className="flex flex-col gap-3 rounded-xl border bg-card p-4">
      {/* Titulo e topico */}
      <div>
        <h3 className="font-bold leading-snug">{conteudo.title}</h3>
        <p className="mt-0.5 text-sm text-muted-foreground">{conteudo.topic}</p>
      </div>

      {/* Badges */}
      <div className="flex flex-wrap gap-1.5">
        {/* Tipo de conteudo */}
        <span className="rounded-full bg-muted px-2 py-0.5 text-xs font-medium">
          {CONTENT_TYPE_LABELS[conteudo.content_type] ?? conteudo.content_type}
        </span>

        {/* Plataforma */}
        {conteudo.platform && (
          <span className="rounded-full bg-muted px-2 py-0.5 text-xs font-medium">
            {PLATFORM_LABELS[conteudo.platform] ?? conteudo.platform}
          </span>
        )}

        {/* Fonte de geracao */}
        <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${sourceConfig.cor}`}>
          {sourceConfig.label}
        </span>
      </div>

      {/* Scores */}
      <div className="flex items-center gap-4">
        <ScoreDisplay score={conteudo.viral_score} label="Viral" />
        <ScoreDisplay score={conteudo.quality_score} label="Qualidade" />
      </div>

      {/* Publico-alvo e data */}
      <div className="flex items-center justify-between text-xs text-muted-foreground">
        {conteudo.target_audience ? (
          <span className="truncate max-w-[60%]" title={conteudo.target_audience}>
            Publico: {conteudo.target_audience}
          </span>
        ) : (
          <span />
        )}
        <time dateTime={conteudo.created_at}>
          {new Date(conteudo.created_at).toLocaleDateString("pt-BR")}
        </time>
      </div>
    </div>
  );
}
