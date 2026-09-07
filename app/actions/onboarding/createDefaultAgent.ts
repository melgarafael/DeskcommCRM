"use server";

/**
 * Server Action: create the tenant's first ai_agent (default) and stamp the
 * onboarding state. Uses canonical Spec 05 defaults baked into ai_agents.
 */
import { redirect } from "next/navigation";
import { z } from "zod";

import { publishFirstVersion } from "@/lib/ai/agents/first-publication";
import { audit } from "@/lib/audit";
import { createAdminClient } from "@/lib/supabase/admin";
import { aiAgentDefaultSchema, type PromptTemplate } from "@/lib/schemas/onboarding";
import { publicarMemoriaDaOrg } from "@/lib/ai/memoria-da-org";
import {
  requireOnboardingCtx,
  patchOnboardingState,
  loadOnboardingState,
  OnboardingError,
} from "./_shared";

/**
 * O jeito de falar do funcionário.
 *
 * Os corpos diziam "loja online" e "e-commerce" em dois dos três — num produto
 * que se declara multi-nicho por escrito, e cuja maioria de adopters roda em
 * clínica, imobiliária e infoproduto. Uma clínica terminava o onboarding com um
 * atendente que se apresentava como sendo de uma loja virtual.
 *
 * Recebem o nome do negócio E o ramo: um funcionário que sabe onde trabalha é o
 * mínimo que se espera de alguém contratado, e saber o QUE o lugar faz é a
 * diferença entre "Olá, como posso ajudar?" e uma primeira frase que já mostra
 * que ele entendeu onde está. O ramo é o que o dono respondeu no primeiro passo;
 * quem não respondeu recebe a versão sem ele, e não uma inventada.
 */
function ondeTrabalha(negocio: string, oQueFaz: string | undefined): string {
  return oQueFaz ? `${negocio}, que é: ${oQueFaz}` : negocio;
}

const PROMPT_BODIES: Record<PromptTemplate, (onde: string) => string> = {
  ecommerce_friendly: (n) =>
    `Você atende os clientes de ${n}. Fale de forma calorosa e próxima, como alguém que gosta de ajudar. Cumprimente, entenda o que a pessoa precisa e ofereça opções claras. Confirme os detalhes antes de agir.`,
  ecommerce_professional: (n) =>
    `Você atende os clientes de ${n}. Fale de forma objetiva, cordial e profissional. Vá direto ao ponto, sem parecer frio, e sempre termine indicando o próximo passo.`,
  support_minimal: (n) =>
    `Você atende os clientes de ${n}. Responda em frases curtas, peça apenas o que for necessário e chame uma pessoa do time assim que a dúvida sair do seu alcance.`,
};

/** O agente padrão desta organização, do jeito que este passo precisa vê-lo. */
interface AgenteDoOnboarding {
  id: string;
  published_version_id: string | null;
}

/**
 * O que aconteceu com a 1ª versão — e por que "não há canal" e "não deu para
 * saber" são desfechos SEPARADOS.
 *
 * `no_channel` é um estado CONHECIDO do produto: quem pulou o WhatsApp não tem
 * número, a versão exige `channel_session_id`, e o agente fica rascunho de
 * propósito (a lista de agentes já mostra "Rascunho"). `failed` é o estado
 * DESCONHECIDO: a consulta não respondeu, então não se sabe se há canal.
 * Colapsar os dois no mesmo `return` seria engolir erro — e engolir erro aqui
 * significa terminar o onboarding com um agente mudo sem ninguém saber por quê.
 */

export type CreateAgentResult =
  /**
   * O agente existe. `publish_error` presente = ficou RASCUNHO porque não deu
   * para decidir a publicação; ausente = publicado (ou rascunho deliberado por
   * ainda não haver número, caso em que o wizard já seguiu com um `redirect`).
   *
   * Mesmo contrato do passo de convites, que também recusa redirecionar quando
   * a parte que podia falhar falhou (`sendOnboardingInvites` → `undelivered`):
   * avançar calado seria a UI mentindo sobre o que o servidor conseguiu fazer.
   */
  /**
   * `publish_blocked_by` diz à tela QUAL causa explicar. Sem ele, o alerta
   * afirmava sempre a causa do canal ("não consegui ler os números de
   * WhatsApp") — e afirmar a causa errada é pior que não afirmar nenhuma:
   * manda a pessoa consertar o que não está quebrado.
   */
  | {
      ok: true;
      agent_id: string;
      publish_error?: string;
      publish_blocked_by?: "canal" | "modelo" | "chave";
      provider?: string;
      /** Catálogo vazio e catálogo sem modelo que sirva pedem conselhos opostos. */
      motivo_do_modelo?: "catalogo_vazio" | "nenhum_com_ferramentas";
      /** As regras da casa não foram gravadas — o agente existe assim mesmo. */
      regras_nao_salvas?: string;
    }
  | {
      ok: false;
      error: "auth_required" | "no_active_org" | "invalid_input" | "db_error";
      details?: unknown;
    };

export async function createDefaultAgent(formData: FormData): Promise<CreateAgentResult> {
  let ctx;
  try {
    ctx = await requireOnboardingCtx();
  } catch (err) {
    if (err instanceof OnboardingError) return { ok: false, error: err.code as never };
    throw err;
  }

  const raw = {
    name: String(formData.get("name") ?? "Atendente IA").trim(),
    prompt_template: String(formData.get("prompt_template") ?? "ecommerce_friendly"),
    regras_da_casa: String(formData.get("regras_da_casa") ?? "").trim() || undefined,
  };

  let input;
  try {
    input = aiAgentDefaultSchema.parse(raw);
  } catch (err) {
    if (err instanceof z.ZodError) {
      return { ok: false, error: "invalid_input", details: err.flatten() };
    }
    throw err;
  }

  const admin = createAdminClient();

  // O ramo que o dono escreveu no primeiro passo. Falha de leitura NÃO derruba o
  // passo: o funcionário nasce sem essa frase, que é degradação honesta — o
  // contrário seria travar a contratação por causa de um adjetivo.
  let oQueFaz: string | undefined;
  try {
    const { state } = await loadOnboardingState(ctx.orgId);
    oQueFaz = state.welcome?.o_que_faz;
  } catch {
    oQueFaz = undefined;
  }

  const systemPrompt = PROMPT_BODIES[input.prompt_template](ondeTrabalha(ctx.orgName, oQueFaz));

  // O agente padrão do onboarding é UM por organização, e o banco já garante
  // isso: `ai_agents_one_default_per_org` é índice único parcial em
  // (organization_id) where is_default. Nenhum outro caminho do produto grava
  // `is_default = true` (todos os outros INSERTs em `ai_agents` gravam false),
  // então "o default desta org" É "o agente que este passo criou" — chave de
  // reaproveitamento que não depende de nenhuma escrita anterior ter dado certo.
  //
  // O código antes fazia o oposto: rebaixava o default existente e inseria
  // outro. Enquanto o passo só terminava em redirect isso nunca aparecia; agora
  // que uma falha na publicação devolve o usuário para esta tela, o segundo
  // clique criaria um "Atendente IA" órfão por clique — todos invisíveis para o
  // runtime, e nenhum deles o padrão. Repetir o passo tem que ser inofensivo.
  const { data: reaproveitado, error: reuseErr } = await admin
    .from("ai_agents")
    .update({ name: input.name, system_prompt: systemPrompt, is_active: true })
    .eq("organization_id", ctx.orgId)
    .eq("is_default", true)
    .select("id, published_version_id")
    .maybeSingle();

  if (reuseErr) {
    return { ok: false, error: "db_error", details: reuseErr.message };
  }

  let agent: AgenteDoOnboarding | null = reaproveitado;
  if (!agent) {
    const { data, error } = await admin
      .from("ai_agents")
      .insert({
        organization_id: ctx.orgId,
        name: input.name,
        system_prompt: systemPrompt,
        // `mcp_agent`, e não o `rag_bot` que o banco tem como padrão.
        //
        // O default do banco é de quando o produto só tinha o formato antigo, e o
        // onboarding nunca escrevia este campo. O resultado: o funcionário que a
        // pessoa acabava de montar abria no EDITOR LEGADO — "Temperature",
        // "Top K", "Similarity threshold" — e as capacidades que ele recebeu
        // ligadas (mexer no contato, no negócio, no funil) ficavam invisíveis
        // para o dono. Funcionavam no runtime e não tinham superfície de
        // configuração, que é o invariante 6 do Sistema Vivo quebrado.
        //
        // O que travava a virada era o editor novo exigir `credential_id`, e
        // instalação pelo kit não ter nenhuma linha em `ai_provider_credentials`.
        // Isso foi resolvido: a versão aceita `credential_id: null` (= a chave da
        // instalação) e o seletor oferece essa opção.
        kind: "mcp_agent",
        is_default: true,
        is_active: true,
        created_by: ctx.userId,
      })
      .select("id, published_version_id")
      .single();

    if (error || !data) {
      return { ok: false, error: "db_error", details: error?.message };
    }
    agent = data;
  }

  // As regras da casa valem para QUALQUER agente da organização, então vão para
  // a memória da org — o mesmo lugar que a tela de Memória edita depois — e não
  // para o prompt deste agente. Enfiá-las no prompt faria a segunda contratação
  // nascer sem elas.
  //
  // Falha aqui NÃO derruba o passo: o agente já existe e o treinamento
  // principal aconteceu. Some do caminho crítico e vira aviso.
  let regrasNaoSalvas: string | null = null;
  if (input.regras_da_casa) {
    const pub = await publicarMemoriaDaOrg(admin, ctx.orgId, ctx.userId, input.regras_da_casa);
    if (!pub.ok) regrasNaoSalvas = pub.mensagem;
  }

  const publicacao = await publishFirstVersion(admin, ctx.orgId, agent, systemPrompt, ctx.userId);

  // Estado, audit e evento saem em QUALQUER desfecho da publicação: o agente
  // existe, e o passo do onboarding é "configurar IA", não "publicar". Deixar
  // de gravá-los por causa da versão era o que fazia o wizard esquecer um passo
  // que na verdade aconteceu.
  try {
    await patchOnboardingState(ctx.orgId, {
      ai: { agent_id: agent.id, prompt_template: input.prompt_template },
    });
  } catch (err) {
    if (err instanceof OnboardingError)
      return { ok: false, error: "db_error", details: err.message };
    throw err;
  }

  await audit({
    action: "onboarding.ai_configured",
    actorUserId: ctx.userId,
    organizationId: ctx.orgId,
    resourceType: "ai_agent",
    resourceId: agent.id,
    metadata: {
      prompt_template: input.prompt_template,
      name: input.name,
      published: publicacao.published,
      ...(publicacao.published ? {} : { publish_blocked_by: publicacao.reason }),
    },
  });

  // Emit a domain event for downstream listeners (Spec 01 §7 event log).
  await admin.from("event_log").insert({
    organization_id: ctx.orgId,
    event_type: "ai_agent.created",
    payload: { agent_id: agent.id, source: "onboarding", published: publicacao.published },
  });

  // Não deu para SABER se há canal: não publica (falha fechado na ação) e não
  // avança (falha aberto na informação) — a tela explica e oferece seguir. Um
  // redirect aqui deixaria como única pista um badge "Rascunho" numa tela que a
  // pessoa ainda não viu.
  if (!publicacao.published && publicacao.reason === "failed") {
    return {
      ok: true,
      agent_id: agent.id,
      publish_error: publicacao.message,
      publish_blocked_by: "canal",
      ...(regrasNaoSalvas ? { regras_nao_salvas: regrasNaoSalvas } : {}),
    };
  }

  // Mesma postura, outra causa: o provedor escolhido na instalação ainda não
  // tem modelo no catálogo desta instalação (o da OpenRouter só chega no cron
  // diário). Avançar calado deixaria a pessoa achar que o funcionário está no
  // ar — e ele não responde uma única mensagem.
  // Sem chave utilizável: o agente fica rascunho e a tela explica. Avançar
  // calado deixaria a pessoa achar que o funcionário está no ar.
  if (!publicacao.published && publicacao.reason === "sem_chave") {
    return {
      ok: true,
      agent_id: agent.id,
      publish_blocked_by: "chave",
      provider: publicacao.provider,
      ...(regrasNaoSalvas ? { regras_nao_salvas: regrasNaoSalvas } : {}),
    };
  }

  if (!publicacao.published && publicacao.reason === "no_model") {
    return {
      ok: true,
      agent_id: agent.id,
      publish_blocked_by: "modelo",
      provider: publicacao.provider,
      motivo_do_modelo: publicacao.motivo,
      ...(regrasNaoSalvas ? { regras_nao_salvas: regrasNaoSalvas } : {}),
    };
  }

  // Publicou o agente, mas as regras da casa não foram gravadas. O passo
  // aconteceu; o que a pessoa escreveu, não. Redirecionar calado apagaria da
  // tela o único lugar onde esse texto existia.
  if (regrasNaoSalvas) {
    return { ok: true, agent_id: agent.id, regras_nao_salvas: regrasNaoSalvas };
  }

  redirect("/onboarding");
}

export async function skipAi(): Promise<void> {
  const ctx = await requireOnboardingCtx();
  await patchOnboardingState(ctx.orgId, {
    ai: { agent_id: "", prompt_template: "skipped", skipped: true },
  });
  redirect("/onboarding");
}
