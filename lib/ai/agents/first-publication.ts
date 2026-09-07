import { listSelectableChannels, type SelectableChannel } from "@/lib/channels/selectable";
import { createAdminClient } from "@/lib/supabase/admin";
import { capacidadesPadraoDoOnboarding } from "./capacidades-padrao";
import { escolherModeloDoProvedor } from "./escolher-modelo";
import { chaveDePlataforma } from "@/lib/ai/runtime/agent";
import { publishAgentVersion } from "./publish";
interface AgenteDoOnboarding {
  id: string;
  published_version_id: string | null;
}
/** Shared first-publication recipe. Explicit reconciliation never grants tools or pipeline scope.
 * A pre-existing version is preserved and requires selection/review through the editor.
 */
export type PublishOutcome =
  | { published: true }
  | { published: false; reason: "no_channel" }
  /**
   * Há provedor e modelo, mas nenhuma chave utilizável: nem credencial validada
   * da organização, nem chave da instalação no ambiente. Publicar assim entrega
   * um funcionário que morre em toda mensagem.
   */
  | { published: false; reason: "sem_chave"; provider: string }
  | {
      published: false;
      reason: "no_model";
      provider: string;
      /**
       * As duas causas pedem conselhos OPOSTOS: catálogo vazio pede esperar (ou
       * forçar) a sincronização; catálogo cheio sem nenhum modelo que sirva pede
       * trocar de provedor. Dizer "ainda não baixamos a lista" para quem já tem
       * 400 modelos é o conselho que nunca resolve.
       */
      motivo: "catalogo_vazio" | "nenhum_com_ferramentas";
    }
  | { published: false; reason: "failed"; message: string };

/**
 * O provedor de IA que a instalação escolheu.
 *
 * O instalador pergunta "qual inteligência artificial vai atender seus
 * clientes?" e grava a resposta em `organizations.settings.llm.provider`. Este
 * passo publicava `"anthropic"` literal, e como o provider da VERSÃO vence o da
 * organização em `resolveOrgLlmConfig`, quem escolheu outro terminava o wizard
 * com um agente "Publicado" que morre em toda mensagem pedindo uma chave que
 * ele nunca teve.
 *
 * `settings` é jsonb livre: leitura defensiva, igual à do agent-engine.
 */
function provedorDaInstalacao(settings: unknown): string {
  const llm = (settings as { llm?: unknown } | null)?.llm;
  const provider = (llm as { provider?: unknown } | null | undefined)?.provider;
  return typeof provider === "string" && provider.trim() !== "" ? provider : "anthropic";
}

function mensagemDoErro(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Publica a 1ª versão do agente criado no onboarding. **Nunca lança**: devolve
 * o desfecho para quem chama decidir o que a tela mostra.
 *
 * Sem isso, o passo "Configurar IA" gravava só a linha em `ai_agents` — formato
 * do `rag_bot` legado. Só que os dois runtimes atuais (o dispatcher do CRM e o
 * agent-engine) resolvem o agente por
 * `join ai_agent_versions on v.id = a.published_version_id`, então um agente
 * sem versão publicada é invisível para ambos: a pessoa terminava o onboarding
 * com um "Atendente IA" que nunca responderia uma única mensagem.
 */
export async function publishFirstVersion(
  admin: ReturnType<typeof createAdminClient>,
  orgId: string,
  agent: AgenteDoOnboarding,
  systemPrompt: string,
  userId: string,
  selection?: { channelId: string; provider: string; model: string; credentialId: string | null },
): Promise<PublishOutcome> {
  // Já publicado numa passagem anterior: republicar colidiria com
  // `ai_agent_versions_unique_number` sem ganhar nada.
  if (agent.published_version_id) return { published: true };

  // Mesma lista que os seletores das telas de IA: canal arquivado não é destino
  // válido de agente, e publicar uma versão apontando para um deixaria o
  // onboarding terminar com um agente que nunca receberia uma mensagem.
  //
  // Ela LANÇA em erro de banco, e isso é correto lá: um seletor que devolve
  // lista vazia quando a consulta falhou é indistinguível de "esta organização
  // não tem número", e convida a parear de novo um aparelho que já está no ar.
  // Aqui não é um seletor — é a decisão "publica ou fica rascunho", tomada
  // DEPOIS de a linha em `ai_agents` já existir. Deixar o throw subir furava o
  // `CreateAgentResult` (que trata todos os outros pontos de falha) e o passo
  // terminava sem gravar estado, sem audit, sem evento e sem dizer nada na tela.
  let canais: SelectableChannel[];
  try {
    canais = await listSelectableChannels(admin, orgId);
  } catch (err) {
    return { published: false, reason: "failed", message: mensagemDoErro(err) };
  }
  const canal = selection ? canais.find((c) => c.id === selection.channelId) : canais[0];
  if (!canal) return { published: false, reason: "no_channel" };

  // Erro de leitura aqui NÃO pode virar "assume anthropic": publicar sem saber
  // qual provedor a instalação escolheu é exatamente o defeito de origem, com
  // outra roupa.
  const { data: org, error: orgErr } = await admin
    .from("organizations")
    .select("settings")
    .eq("id", orgId)
    .maybeSingle();
  if (orgErr) return { published: false, reason: "failed", message: orgErr.message };

  const provider = selection?.provider ?? provedorDaInstalacao(org?.settings);

  // O modelo daquele provedor. Não existe fallback literal: um id de outro
  // provedor (ou inventado) produz o pior desfecho do produto — o agente
  // responde texto plausível e nunca cria o lead nem move o card.
  //
  // Buscar SÓ o `is_default_for_provider` travava a OpenRouter, que é a opção
  // [1] do instalador: medido num ambiente real, ela chega com 400 modelos
  // sincronizados e NENHUM marcado como padrão, porque o cron de catálogo não
  // escreve esse campo. A regra de escolha (com o requisito de ferramentas)
  // vive em `escolherModeloDoProvedor`.
  const { data: modelos } = await admin
    .from("ai_models")
    .select(
      "model_id, is_default_for_provider, supports_tools, input_price_per_million_cents, output_price_per_million_cents",
    )
    .eq("provider", provider)
    .is("deprecated_at", null);

  const escolha = escolherModeloDoProvedor(
    (modelos ?? []) as Parameters<typeof escolherModeloDoProvedor>[0],
  );
  if (!escolha.escolhido) {
    return { published: false, reason: "no_model", provider, motivo: escolha.motivo };
  }
  const modelId = selection?.model ?? escolha.modelId;
  if (selection && !(modelos ?? []).some((m) => m.model_id === modelId && m.supports_tools))
    return { published: false, reason: "failed", message: "model_not_found" };

  // "Em que negócios ele pode mexer". Toda organização nasce com um funil de
  // entrada, criado por gatilho no INSERT de `organizations`. Sem preencher
  // isto, `pipeline_ids` fica vazio — e vazio significa NENHUM, então toda
  // escrita de lead é recusada e o card nunca sai do lugar.
  //
  // Falha ou ausência = escopo vazio, nunca um funil chutado: mexer no funil
  // errado é pior que não mexer em nenhum.
  const { data: funil } = await admin
    .from("crm_pipelines")
    .select("id")
    .eq("organization_id", orgId)
    .eq("is_default", true)
    .eq("is_archived", false)
    .maybeSingle();
  const pipelineIds = !selection && funil?.id ? [funil.id as string] : [];

  // QUAL CHAVE ESTA VERSÃO USA — e as duas origens são legítimas.
  //
  // Credencial validada da organização vence (quem colou a chave no wizard, ou
  // cadastrou pela tela); na falta dela, `credential_id: null` significa "a chave
  // da instalação", que é o caso mais comum do kit. Sem NENHUMA das duas, não se
  // publica: o agente responderia erro em toda mensagem e o dono só descobriria
  // com o primeiro cliente.
  //
  // `validated_at` não nulo é exigência de `loadCredential`, não capricho: uma
  // credencial que o provedor ainda não confirmou não é utilizável pelo turno.
  const { data: credencial } = await admin
    .from("ai_provider_credentials")
    .select("id")
    .eq("organization_id", orgId)
    .eq("provider", provider)
    .eq("is_active", true)
    .not("validated_at", "is", null)
    .limit(1)
    .maybeSingle();

  const credentialId = selection
    ? selection.credentialId
    : ((credencial?.id as string | undefined) ?? null);
  if (!credentialId && !chaveDePlataforma(provider)) {
    return { published: false, reason: "sem_chave", provider };
  }

  const { data: version, error: versionErr } = await admin
    .from("ai_agent_versions")
    .insert({
      organization_id: orgId,
      agent_id: agent.id,
      version_number: 1,
      provisioning_origin: selection ? "legacy_reconciliation" : "onboarding",
      system_prompt: systemPrompt,
      // Provedor e modelo saem SEMPRE da mesma origem — o par é indivisível.
      // Emprestar só o id do modelo de outro provedor manda um nome que o
      // endpoint não conhece.
      provider,
      model: modelId,
      // Sem capacidades o turno não monta ferramenta nenhuma: o agente
      // entregue conversa e não alcança contato, lead nem funil.
      credential_id: credentialId,
      tool_ids: selection ? [] : capacidadesPadraoDoOnboarding(),
      pipeline_ids: pipelineIds,
      channel_session_id: canal.id,
      status: "draft",
      created_by: userId,
    })
    .select("id")
    .single();

  let versionId = version?.id;
  if (!versionId && versionErr?.code === "23505") {
    const { data: existing, error } = await admin
      .from("ai_agent_versions")
      .select("id,provisioning_origin,status")
      .eq("organization_id", orgId)
      .eq("agent_id", agent.id)
      .order("version_number");
    if (error) return { published: false, reason: "failed", message: error.message };
    const own = existing?.length === 1 ? existing[0] : null;
    if (own?.provisioning_origin === (selection ? "legacy_reconciliation" : "onboarding"))
      versionId = own.id;
  }
  if (!versionId)
    return {
      published: false,
      reason: "failed",
      message:
        versionErr?.code === "23505"
          ? "existing_version_requires_review"
          : (versionErr?.message ?? "version_insert_failed"),
    };
  const { data: current } = await admin
    .from("ai_agents")
    .select("published_version_id")
    .eq("organization_id", orgId)
    .eq("id", agent.id)
    .maybeSingle();
  if (current?.published_version_id === versionId) return { published: true };

  const published = await publishAgentVersion(admin, {
    orgId,
    agentId: agent.id,
    versionId,
    expectedProvenance: selection ? "legacy_reconciliation" : "onboarding",
  });
  if (!published.ok) {
    const { data: latest } = await admin
      .from("ai_agents")
      .select("published_version_id")
      .eq("organization_id", orgId)
      .eq("id", agent.id)
      .maybeSingle();
    if (latest?.published_version_id === versionId) return { published: true };
    return { published: false, reason: "failed", message: published.message };
  }

  return { published: true };
}
