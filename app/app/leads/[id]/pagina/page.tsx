/**
 * A PÁGINA INTEIRA DE UM NEGÓCIO (#4151).
 *
 * ─── Por que ela mora em `/app/leads/<id>/pagina` ───────────────────────────
 *
 * `/app/leads/<id>` é o link estável do negócio e CONTINUA sendo um resolvedor
 * de funil: redireciona para `/app/pipelines/[id]?lead=` e abre o painel. É
 * para lá que tarefas, agenda, relatório de atividades, captação e avisos de
 * passagem apontam, e esse hábito não muda. A página inteira ganhou caminho
 * próprio, alcançado pelo botão Expandir do painel (`hrefDaPaginaDoNegocio`).
 *
 * Aqui a rota RENDERIZA o negócio em página: cabeçalho com nome e etapa, dados
 * e descrição à esquerda, tarefas e linha do tempo à direita no desktop, uma
 * coluna na tela estreita. Os blocos são OS MESMOS do dossiê (`LeadDossier`,
 * `variante="pagina"`) — nada foi reimplementado.
 *
 * ─── Por que o funil continua fora da URL ──────────────────────────────────
 *
 * O funil é o lugar onde o lead está AGORA, e leads mudam de funil. Um link com
 * o funil dentro apontaria para o quadro errado no dia seguinte. O que entra na
 * URL é o `?voltar=` — a URL do quadro de origem, com o filtro de quem clicou em
 * Expandir —, e ela é validada em `lib/leads/pagina-do-negocio` antes de virar
 * link.
 *
 * Sem `notFound()` para lead inexistente é a RLS quem responde: a consulta já
 * filtra pela organização ativa, e o 404 do app é a resposta certa tanto para
 * "não existe" quanto para "não é seu" — sem revelar a diferença entre os dois.
 */
import { notFound } from "next/navigation";

import { requireAuth, resolveActiveOrg } from "@/lib/auth/server";
import { createClient } from "@/lib/supabase/server";
import { hrefDeVoltar } from "@/lib/leads/pagina-do-negocio";
import { ocultarProvaMetaNaResposta } from "@/lib/leads/prova-meta-lead-submitted";
import type { Lead } from "@/lib/types/leads";
import type { Pipeline, Stage } from "@/lib/kanban/types";
import { PaginaDoNegocio } from "./_pagina";

export const dynamic = "force-dynamic";

export default async function LeadPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  /**
   * Opcional de propósito: no Next ele SEMPRE vem (mesmo que `{}`), e o teste da
   * rota monta a página sem ele. Ler `?.voltar` é mais barato que a página
   * explodir num call site que não é o framework.
   */
  searchParams?: Promise<{ voltar?: string }>;
}) {
  const user = await requireAuth();
  const activeOrg = await resolveActiveOrg(user);
  if (!activeOrg) notFound();

  const { id } = await params;
  const voltar = (await searchParams)?.voltar;

  const supabase = await createClient();
  // A RLS enxerga TODAS as organizações do usuário (`fn_user_org_ids()`), então
  // sem este filtro um link para lead de outra org abriria a ficha de lá —
  // trocando a organização ativa por baixo do usuário sem ele pedir.
  const { data: lead } = await supabase
    .from("crm_leads")
    .select("*")
    .eq("organization_id", activeOrg.orgId)
    .eq("id", id)
    .maybeSingle();

  if (!lead) notFound();

  // A mesma projeção das rotas irmãs (quadro, mover, clonar): tudo o que sai
  // daqui vira prop de componente cliente, isto é, vai para o navegador.
  const linha = ocultarProvaMetaNaResposta(
    lead as unknown as Record<string, unknown>,
  ) as unknown as Lead;
  const { data: pipeline } = await supabase
    .from("crm_pipelines")
    .select("*")
    .eq("organization_id", activeOrg.orgId)
    .eq("id", linha.pipeline_id)
    .maybeSingle();

  if (!pipeline) notFound();

  // As etapas vivas, na mesma leitura leve da página do funil: é o que alimenta
  // o seletor de etapa do cabeçalho (`EtapaNoDossie`).
  const { data: etapas } = await supabase
    .from("crm_stages")
    .select("*")
    .eq("organization_id", activeOrg.orgId)
    .eq("pipeline_id", linha.pipeline_id)
    .eq("is_archived", false)
    .order("position");

  /**
   * O SCORE e a CONVERSA vêm junto, pelos MESMOS critérios da rota do quadro
   * (`app/api/v1/pipelines/[id]/board/route.ts`): LEFT, nunca INNER — negócio
   * sem score e contato sem conversa são estados normais, e sumir com eles
   * esconderia justamente os cards que ninguém atendeu.
   *
   * As duas consultas são por UMA linha cada (aqui não há funil inteiro para
   * varrer), e sem elas a página abriria mais pobre que a gaveta: sem o medidor
   * no cabeçalho e sem a porta da conversa.
   */
  const { data: score } = await supabase
    .from("crm_lead_scores")
    .select(
      "ai_probability, ai_probability_reason, ai_probability_band, ai_probability_evidence, ai_probability_at",
    )
    .eq("organization_id", activeOrg.orgId)
    .eq("lead_id", linha.id)
    .maybeSingle();

  const conversa = linha.contact_id
    ? (
        await supabase
          .from("conversations")
          .select("id, last_message_preview, last_message_at, unread_count_for_assignee")
          .eq("organization_id", activeOrg.orgId)
          .eq("contact_id", linha.contact_id)
          .order("last_message_at", { ascending: false, nullsFirst: false })
          .limit(1)
          .maybeSingle()
      ).data
    : null;

  const negocio: Lead = {
    ...linha,
    ...(score && score.ai_probability !== null && score.ai_probability_band !== null
      ? {
          score: {
            probability: Number(score.ai_probability),
            reason: score.ai_probability_reason ?? "",
            band: score.ai_probability_band as NonNullable<Lead["score"]>["band"],
            factors: Array.isArray(
              (score.ai_probability_evidence as { factors?: unknown } | null)?.factors,
            )
              ? ((score.ai_probability_evidence as { factors: NonNullable<Lead["score"]>["factors"] })
                  .factors)
              : [],
            at: score.ai_probability_at,
          },
        }
      : {}),
    // `null`, nunca ausente, para contato sem conversa: é assim que o bloco
    // sabe mostrar "Abrir conversa" em vez de sumir (#1993).
    ...(linha.contact_id
      ? {
          conversa: conversa
            ? {
                id: conversa.id,
                preview: conversa.last_message_preview,
                last_message_at: conversa.last_message_at,
                unread: conversa.unread_count_for_assignee ?? 0,
              }
            : null,
        }
      : {}),
  };

  return (
    <PaginaDoNegocio
      lead={negocio}
      pipeline={pipeline as unknown as Pipeline}
      etapas={(etapas ?? []) as unknown as Stage[]}
      voltarHref={hrefDeVoltar(voltar, linha.pipeline_id)}
    />
  );
}
