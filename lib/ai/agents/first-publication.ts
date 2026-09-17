import { listSelectableChannels, type SelectableChannel } from "@/lib/channels/selectable";
import type { createAdminClient } from "@/lib/supabase/admin";
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
  | {
      published: false;
      reason: "sem_chave";
      provider: string;
      /**
       * A chave que a pessoa colou ainda não foi confirmada pelo provedor
       * (`validated_at` nulo). Sem isto a tela só sabia dizer "não achei chave
       * de X" — e para quem acabou de colar uma chave esse diagnóstico é falso:
       * a chave existe, está gravada, e o que falta é o provedor confirmar. A
       * #1007 é exatamente esse conselho errado, com o provedor errado.
       */
      chaveEmVerificacao?: string;
    }
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
 * O provedor de IA que a ORGANIZAÇÃO escolheu.
 *
 * Duas portas gravam a resposta de "qual inteligência artificial vai atender
 * seus clientes?" `organizations.settings.llm.provider`: o instalador, no menu
 * do kit, e o passo da chave do onboarding, quando a pessoa cola a chave de
 * outro provedor (`app/actions/onboarding/chaveDaIa.ts` →
 * `lib/ai/pontos/padrao-da-organizacao.ts`). Este passo publicava `"anthropic"`
 * literal, e como o provider da VERSÃO vence o da organização em
 * `resolveOrgLlmConfig`, quem escolheu outro terminava o wizard com um agente
 * "Publicado" que morre em toda mensagem pedindo uma chave que ele nunca teve.
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
  // Reconciliação legado pede um canal concreto: sem ele não há o que
  // republicar, e inventar um rascunho aqui misturaria dois fluxos. O
  // onboarding (sem `selection`) segue mesmo sem canal — grava o rascunho
  // configurado e só recusa colocar no atendimento.
  if (selection && !canal) return { published: false, reason: "no_channel" };

  // Erro de leitura aqui NÃO pode virar "assume anthropic": publicar sem saber
  // qual provedor a instalação escolheu é exatamente o defeito de origem, com
  // outra roupa.
  const { data: org, error: orgErr } = await admin
    .from("organizations")
    .select("settings")
    .eq("id", orgId)
    .maybeSingle();
  if (orgErr) return { published: false, reason: "failed", message: orgErr.message };

  // Só LEITURA daqui para baixo: depois da decisão da #1007, a escolha do
  // onboarding é gravada na EMPRESA (no passo da chave, `chaveDaIa.ts`) e a
  // publicação não move mais o provedor — o que ela escolhe é por onde publica,
  // e por isso `const` (o `let` era de quando este passo adotava outra chave).
  const provider = selection?.provider ?? provedorDaInstalacao(org?.settings);

  /*
   * ⚠️ QUAL CHAVE ESTA VERSÃO USA — e por que o provedor NÃO muda mais aqui.
   *
   * As duas origens de chave continuam valendo: credencial validada da
   * organização vence; na falta dela, `credential_id: null` significa "a chave
   * da instalação", que é o caso mais comum do kit.
   *
   * O terceiro caso era o da #1007, e ele caía entre os dois: a chave que a
   * pessoa colou no passo "Configurar IA" sendo de OUTRO provedor que não o da
   * empresa. A publicação partia do provedor da empresa, não achava a chave que
   * estava ali, e o onboarding terminava com o atendente em rascunho pedindo
   * uma chave de outro provedor.
   *
   * A primeira versão deste PR resolvia isso AQUI, adotando a credencial
   * validada mais recente da organização, de qualquer provedor. A decisão do
   * dono do produto mudou o lugar da resposta: quem cola a chave no wizard
   * escolhe o provedor da EMPRESA, e a escolha se grava em
   * `organizations.settings.llm` no passo em que a chave é guardada
   * (`lib/ai/pontos/padrao-da-organizacao.ts`). Publicar por adoção seria uma
   * segunda semântica, e pior: poria o ATENDENTE num provedor em que a EMPRESA
   * não está — e é o provedor da versão que vence o da organização em
   * `resolveOrgLlmConfig`. O ponto de IA mais visível do produto apontaria para
   * um provedor que ninguém escolheu, que é exatamente o que a decisão proíbe.
   *
   * Então aqui só se LÊ o provedor da organização. Provedor e modelo continuam
   * saindo da mesma origem, e a leitura do catálogo abaixo é a do provedor lido.
   */
  let credentialId: string | null = selection ? selection.credentialId : null;
  /** Provedor cuja credencial colada ainda não foi confirmada pelo provedor. */
  let chaveEmVerificacao: string | undefined;

  if (!selection) {
    const { data: credencialDoProvedor } = await admin
      .from("ai_provider_credentials")
      .select("id")
      .eq("organization_id", orgId)
      .eq("provider", provider)
      .eq("is_active", true)
      // `validated_at` não nulo é exigência de `loadCredential`, não capricho:
      // uma credencial que o provedor ainda não confirmou não é utilizável no
      // turno — publicar com ela entrega um agente que erra em toda mensagem.
      .not("validated_at", "is", null)
      .limit(1)
      .maybeSingle();

    credentialId = (credencialDoProvedor?.id as string | undefined) ?? null;

    if (!credentialId && !chaveDePlataforma(provider)) {
      // Nada utilizável — mas pode haver uma chave colada esperando o provedor
      // confirmar. Nomear isso é o que separa "cole a chave" de "espere um
      // instante": são causas e conselhos diferentes, e sem o nome do provedor
      // a tela dizia "não achei chave de X" para quem tinha acabado de colar
      // uma. A busca é do provedor DA ORGANIZAÇÃO porque, depois da decisão, é
      // esse o provedor da chave colada no wizard: um passo que grava
      // `settings.llm` antes de publicar.
      const { data: pendente } = await admin
        .from("ai_provider_credentials")
        .select("provider")
        .eq("organization_id", orgId)
        .eq("provider", provider)
        .eq("is_active", true)
        .is("validated_at", null)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (pendente?.provider) chaveEmVerificacao = pendente.provider as string;
    }
  }


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

  // Sem chave NENHUMA (nem da organização, nem da instalação) não se publica:
  // o agente responderia erro em toda mensagem e o dono só descobriria com o
  // primeiro cliente. A chave já foi resolvida lá em cima, no provedor da
  // ORGANIZAÇÃO — que é o que a decisão do dono manda ler aqui; aqui só resta o
  // veredito.
  //
  // E ele continua DEPOIS da escolha do modelo de propósito: catálogo sem
  // nenhum modelo utilizável é defeito de instalação que se resolve antes da
  // chave, e inverter isso mudaria a causa que a tela recebe para quem tem os
  // dois problemas — sem necessidade nenhuma para a #1007.
  if (!credentialId && !chaveDePlataforma(provider)) {
    return {
      published: false,
      reason: "sem_chave",
      provider,
      ...(chaveEmVerificacao ? { chaveEmVerificacao } : {}),
    };
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
      channel_session_id: canal?.id ?? null,
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

  // O cartão lê `ai_agents.model`; o editor lê a versão. Gravar o id NU do
  // catálogo aqui faz os dois mostrarem a mesma coisa. Falha neste UPDATE não
  // desfaz o rascunho: a versão já é a fonte do ensaio.
  await admin.from("ai_agents").update({ model: modelId }).eq("organization_id", orgId).eq("id", agent.id);

  // Sem canal o rascunho existe e pode ser ensaiado no CRM. Publicar de
  // verdade — `published_version_id` + runtime de atendimento — continua
  // bloqueado. `no_channel` no audit é o mesmo desfecho de antes; o que
  // mudou é que agora há versão para o editor hidratar e o ensaio executar.
  if (!canal) return { published: false, reason: "no_channel" };

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
