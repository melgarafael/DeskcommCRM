/**
 * A URL ESTÁVEL DE UM NEGÓCIO — AGORA UMA PÁGINA, NÃO UM REDIRECIONAMENTO.
 *
 * ─── O que esta rota era, e o que ela é (#3062 → #4151) ────────────────────
 *
 * Ela nasceu (#3062) para dar um endereço ao negócio: o dossiê só abria por
 * clique dentro do quadro, então nenhuma outra tela conseguia apontar para um
 * lead — o histórico de captação tinha o id na mão e nenhum lugar para
 * levá-lo, e um link colado num grupo do time não abria nada. A solução de
 * então era RESOLVER o funil e redirecionar para o quadro com `?lead=`.
 *
 * Isso resolveu o link, mas não o problema do #4151: o destino real continuava
 * sendo o painel lateral, uma coluna estreita. Ler um resumo de caso longo
 * nele é rolar muito com pouca largura. Agora a rota RENDERIZA o negócio em
 * duas colunas (dados do negócio + descrição em área alta de um lado; tarefas e
 * linha do tempo do outro), e é para cá que o botão "Expandir" do dossiê
 * aponta.
 *
 * ─── O funil NÃO entra na URL, e continua não entrando ─────────────────────
 *
 * Ele é o lugar onde o negócio está AGORA, e negócios mudam de funil: um link
 * com o funil dentro apontaria para o lugar errado no dia seguinte. Aqui a
 * resolução é feita na hora.
 *
 * ─── O que veio de graça, e o que se manteve ───────────────────────────────
 *
 * A consulta continua filtrada pela ORGANIZAÇÃO ativa. A RLS enxerga todas as
 * organizações do usuário (`fn_user_org_ids()`); sem este filtro, um link para
 * negócio de outra org abriria a página de lá dentro da organização em que a
 * pessoa está — trocando o contexto por baixo dela sem ela pedir. Negócio de
 * outra org responde `notFound()`, a mesma resposta para "não existe" e "não é
 * seu", sem revelar a diferença.
 *
 * ─── O caminho de volta ────────────────────────────────────────────────────
 *
 * `?voltar=` carrega o quadro COM o filtro de quem clicou em "Expandir" — o
 * painel monta esse valor a partir da URL em que estava. Ele é DADO DE FORA, e
 * por isso é validado: só vale caminho dentro do quadro (`/app/pipelines/…`);
 * qualquer outra coisa cai no quadro do próprio negócio. Sem essa checagem a
 * rota viraria trampolim de redirect aberto.
 */
import { notFound } from "next/navigation";

import { requireAuth, resolveActiveOrg } from "@/lib/auth/server";
import { camposDoFunil, camposPorEscopo } from "@/lib/leads/campos-do-funil";
import { createClient } from "@/lib/supabase/server";
import type { Lead } from "@/lib/types/leads";
import { NegocioEmPagina } from "./_client";

export const dynamic = "force-dynamic";

/** A raiz de onde um retorno é aceito — o quadro do funil, e só ele. */
const RAIZ_DO_QUADRO = "/app/pipelines/";

/**
 * Para onde o "Voltar ao quadro" aponta.
 *
 * O valor chega pela URL e é de quem mandou o link: um `voltar` externo
 * (`https://…`, `//outro-host`) faria desta rota um redirect aberto. Só caminho
 * dentro do quadro passa; o resto cai no quadro DESTE negócio, que é sempre um
 * destino válido.
 */
export function destinoDeVolta(bruto: string | null | undefined, pipelineId: string): string {
  const padrao = `${RAIZ_DO_QUADRO}${pipelineId}`;
  if (!bruto || !bruto.startsWith(RAIZ_DO_QUADRO)) return padrao;
  return bruto;
}

export default async function LeadPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ voltar?: string | string[] }>;
}) {
  const user = await requireAuth();
  const activeOrg = await resolveActiveOrg(user);
  if (!activeOrg) notFound();

  const { id } = await params;
  const { voltar: voltarBruto } = await searchParams;

  const supabase = await createClient();
  const { data: lead } = await supabase
    .from("crm_leads")
    .select("*")
    .eq("organization_id", activeOrg.orgId)
    .eq("id", id)
    .maybeSingle();

  // Sem funil não há onde o negócio mora — e a página não teria como oferecer
  // o retorno. É o mesmo caso que a versão anterior tratava aqui.
  if (!lead?.pipeline_id) notFound();

  /**
   * Três leituras LEVES, e não a do quadro: o funil (para os campos
   * declarados), as etapas vivas (para o NOME da atual — o seletor de mover
   * continua sendo o do quadro, que carrega as regras de campos obrigatórios e
   * motivo de perda) e a conversa mais recente do contato (o mesmo bloco do
   * painel). Todas por chave, nenhuma varredura.
   */
  const { data: funil } = await supabase
    .from("crm_pipelines")
    .select("id, settings")
    .eq("organization_id", activeOrg.orgId)
    .eq("id", lead.pipeline_id)
    .maybeSingle();

  const { data: etapas } = await supabase
    .from("crm_stages")
    .select("id, name")
    .eq("organization_id", activeOrg.orgId)
    .eq("pipeline_id", lead.pipeline_id)
    .eq("is_archived", false)
    .order("position");

  const { data: conversa } = lead.contact_id
    ? await supabase
        .from("conversations")
        .select("id, last_message_preview, last_message_at, unread_count_for_assignee")
        .eq("organization_id", activeOrg.orgId)
        .eq("contact_id", lead.contact_id)
        .order("last_message_at", { ascending: false, nullsFirst: false })
        .limit(1)
        .maybeSingle()
    : { data: null };

  const negocio = {
    ...(lead as unknown as Lead),
    // A MESMA distinção do quadro: `null` = contato sem conversa (o bloco
    // oferece "Abrir conversa"); ausente = negócio sem contato (nada aparece).
    conversa: lead.contact_id
      ? conversa
        ? {
            id: conversa.id as string,
            preview: (conversa.last_message_preview as string | null) ?? null,
            last_message_at: (conversa.last_message_at as string | null) ?? null,
            unread: (conversa.unread_count_for_assignee as number | null) ?? 0,
          }
        : null
      : undefined,
  } as Lead;

  const etapaAtual = (etapas ?? []).find((e) => e.id === lead.stage_id);
  const settings = (funil?.settings ?? null) as Record<string, unknown> | null;

  return (
    <NegocioEmPagina
      lead={negocio}
      pipelineId={lead.pipeline_id}
      stageName={etapaAtual?.name ?? "—"}
      fieldDefs={camposPorEscopo(camposDoFunil(settings), "negocio")}
      voltar={destinoDeVolta(Array.isArray(voltarBruto) ? voltarBruto[0] : voltarBruto, lead.pipeline_id)}
    />
  );
}
