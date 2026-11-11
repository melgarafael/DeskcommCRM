import { notFound, redirect } from "next/navigation";

import { requireAuth, resolveActiveOrg } from "@/lib/auth/server";
import { ROLE_RANK } from "@/lib/auth/types";
import { listClassifierModels } from "@/lib/ai/classifier-models";
import { listSelectableChannels } from "@/lib/channels/selectable";
import { createClient } from "@/lib/supabase/server";
import type { RouterDetailState } from "@/hooks/ai/useRouters";
import { RouterEditorClient } from "./_client";

export const dynamic = "force-dynamic";

const ROUTER_DETAIL_COLUMNS = "id, name, channel_session_id, is_active, config, fallback_agent_id";
// #2415 — SEM pipeline_id/stage_id aqui, o initialState do SSR nascia sem
// destino: o draft montado a partir dele mostrava "Sem destino" a cada recarga,
// mesmo com os campos gravados no banco (a API de detalhe já trazia os dois).
const MEMBER_COLUMNS =
  "id, agent_id, intent_name, intent_description, examples, position, flow_pointer_id, pipeline_id, stage_id";

export default async function RouterEditorPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  const user = await requireAuth();
  const activeOrg = await resolveActiveOrg(user);
  if (!activeOrg) redirect("/app");
  if (!(user.is_platform_admin && !user.support) && ROLE_RANK[activeOrg.role] < ROLE_RANK.manager) {
    redirect("/403");
  }

  const supabase = await createClient();

  const [{ data: routerRow }, { data: memberRows }, { data: agentRows }, channelSessions] =
    await Promise.all([
      supabase
        .from("ai_routers")
        .select(ROUTER_DETAIL_COLUMNS)
        .eq("id", id)
        .eq("organization_id", activeOrg.orgId)
        .maybeSingle(),
      supabase
        .from("ai_router_members")
        .select(MEMBER_COLUMNS)
        .eq("router_id", id)
        .eq("organization_id", activeOrg.orgId)
        .order("position", { ascending: true }),
      supabase
        .from("ai_agents")
        .select("id, name")
        .eq("organization_id", activeOrg.orgId)
        .is("archived_at", null)
        .order("name", { ascending: true }),
      listSelectableChannels(supabase, activeOrg.orgId),
    ]);

  if (!routerRow) notFound();

  // #4340 — o número deste roteador pode ter sido remoto/arquivado: ele some da
  // lista de canais oferecíveis (`listSelectableChannels` filtra
  // `archived_at`). A tela já escrevia "Número removido", mas o roteador
  // seguia "ativo" e o operador não sabia que aquele número não roteia mais
  // nada — nem que as conversas do número NOVO caem no agente principal.
  const numeroRemovido = !channelSessions.some((c) => c.id === routerRow.channel_session_id);

  // Só os modelos que esta organização consegue usar de fato — ver a razão em
  // lib/ai/classifier-models.
  const classifierModels = await listClassifierModels(supabase, activeOrg.orgId, {
    anthropic: Boolean(process.env.ANTHROPIC_API_KEY),
    openai: Boolean(process.env.OPENAI_API_KEY),
  });

  const initialState: RouterDetailState = {
    // O formulário recebe o `is_active` GRAVADO. Entregar `false` aqui por
    // causa do número removido faria o próximo "Salvar" gravar a desativação
    // sem o operador ter escolhido. Quem mostra o estado efetivo (não roteia)
    // é a tela, pela flag `numeroRemovido`.
    router: routerRow as RouterDetailState["router"],
    members: (memberRows ?? []) as RouterDetailState["members"],
  };

  const agents = agentRows ?? [];

  return (
    <div className="flex h-full flex-col gap-6 p-6">
      <RouterEditorClient
        routerId={id}
        initialState={initialState}
        agents={agents}
        channelSessions={channelSessions}
        classifierModels={classifierModels}
        numeroRemovido={numeroRemovido}
      />
    </div>
  );
}
