/**
 * As ENTRADAS AUTOMÁTICAS DE CONTATOS — por onde o mundo externo põe gente
 * dentro do CRM sem ninguém digitar (`webhook_sources`).
 *
 * ⚠️ POR QUE A REGRA SAIU DO `route.ts`. A tela e o agente de IA passam a operar
 * as mesmas fontes; SQL duplicado entre os dois faria o sistema mentir para um
 * deles (BRIEFING §3, Decisão 4). Aqui está a regra; a rota e a tool são fachadas.
 *
 * ⚠️ A VALIDAÇÃO DE TENANCY DO FUNIL É REGRA NOVA, E É OBRIGATÓRIA AQUI. A rota
 * usa o client do usuário e a RLS a protege de graça. A tool usa o **service
 * role**, que bypassa RLS: sem o `eq("organization_id", …)` explícito, um
 * `default_pipeline_id` de outro tenant passaria pela FK (que não conhece
 * organização) e a fonte nasceria despejando contatos no funil de outra empresa.
 * A rota ganha a mesma checagem de graça — defesa em profundidade, e o
 * comportamento dela não muda.
 *
 * ⚠️ `secret_encrypted` NUNCA SAI DAQUI. A leitura devolve `has_secret`, como a
 * rota sempre fez: o plaintext aparece uma vez, na resposta de quem o definiu.
 */
import { randomBytes } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";

import { ApiError } from "@/lib/api/types";
import type { Actor } from "@/lib/api/handlers/types";
import { audit } from "@/lib/audit";
import { autoriaDaMudanca } from "@/lib/operacao/autoria";
import type { WebhookFormField } from "@/lib/webhooks/formulario";

type SB = SupabaseClient;

export interface DepsDaOperacao {
  supabase: SB;
  organizationId: string;
  /** Resolvido de fonte confiável pelo chamador — nunca do body. */
  actor: Actor;
  requestId: string;
}

/** A fonte como ela sai para quem lê: sem o segredo, com o fato de haver um. */
export interface FonteVisivel {
  id: string;
  organization_id: string;
  name: string;
  is_active: boolean;
  authorize_ai_on_capture: boolean;
  kind: string;
  path_token: string;
  default_pipeline_id: string;
  default_stage_id: string;
  redirect_to: string | null;
  field_map: Record<string, unknown>;
  form_fields: WebhookFormField[];
  last_received_at: string | null;
  has_secret: boolean;
  created_at: string;
  updated_at: string;
  last_change_actor_kind: string | null;
  last_change_at: string | null;
}

/**
 * ⚠️ LISTA EXPLÍCITA, E NÃO `*`, MAS COBRINDO O QUE A TELA JÁ USA. Enumerar é o
 * que garante que `secret_encrypted` só chega aqui para virar `has_secret` e
 * nunca escapa por descuido num `select("*")`. E a lista cobre `field_map`,
 * `redirect_to` e `kind` porque a tela de fontes os consome — trocar a projeção
 * "de passagem" numa refatoração é como uma tela quebra em silêncio.
 */
const COLUNAS =
  "id, organization_id, name, is_active, kind, path_token, default_pipeline_id, default_stage_id, " +
  "redirect_to, field_map, form_fields, last_received_at, secret_encrypted, created_at, updated_at, " +
  "last_change_actor_kind, last_change_at, authorize_ai_on_capture";

function semSegredo(linha: Record<string, unknown>): FonteVisivel {
  const { secret_encrypted, ...resto } = linha;
  return {
    ...(resto as unknown as Omit<FonteVisivel, "has_secret" | "form_fields">),
    form_fields: Array.isArray(resto.form_fields) ? (resto.form_fields as WebhookFormField[]) : [],
    has_secret: secret_encrypted !== null,
  };
}

export async function listarEntradasAutomaticas(
  deps: DepsDaOperacao,
  opts: { apenasAtivas?: boolean } = {},
): Promise<FonteVisivel[]> {
  let q = deps.supabase
    .from("webhook_sources")
    .select(COLUNAS)
    .eq("organization_id", deps.organizationId)
    .order("created_at", { ascending: false });
  if (opts.apenasAtivas) q = q.eq("is_active", true);

  const { data, error } = await q;
  if (error) throw new ApiError(500, "internal_error", undefined, deps.requestId, error.message);
  return ((data ?? []) as unknown as Array<Record<string, unknown>>).map(semSegredo);
}

/** A fonte desta organização, ou a recusa — `null` de outro tenant vira 404. */
async function fonteDaOrg(
  deps: DepsDaOperacao,
  id: string,
): Promise<{ id: string; name: string; path_token: string; is_active: boolean }> {
  const { data, error } = await deps.supabase
    .from("webhook_sources")
    .select("id, name, path_token, is_active")
    .eq("id", id)
    .eq("organization_id", deps.organizationId)
    .maybeSingle();
  if (error) throw new ApiError(500, "internal_error", undefined, deps.requestId, error.message);
  if (!data) {
    throw new ApiError(
      404,
      "not_found",
      undefined,
      deps.requestId,
      "Essa entrada automática de contatos não existe aqui.",
    );
  }
  return data as unknown as { id: string; name: string; path_token: string; is_active: boolean };
}

/**
 * Recusa o funil/etapa que não é desta organização — ver o aviso no topo.
 *
 * A etapa é conferida contra o funil TAMBÉM: uma etapa da org mas de outro funil
 * faria os contatos entrarem num quadro e caírem numa coluna de outro.
 */
async function destinoValido(
  deps: DepsDaOperacao,
  pipelineId: string,
  stageId: string,
): Promise<void> {
  const { data: funil, error: funilErr } = await deps.supabase
    .from("crm_pipelines")
    .select("id")
    .eq("id", pipelineId)
    .eq("organization_id", deps.organizationId)
    .maybeSingle();
  if (funilErr) {
    throw new ApiError(500, "internal_error", undefined, deps.requestId, funilErr.message);
  }
  if (!funil) {
    throw new ApiError(
      422,
      "unprocessable_entity",
      undefined,
      deps.requestId,
      "Esse funil não existe aqui. Escolha um funil da sua empresa para receber os contatos.",
    );
  }

  const { data: etapa, error: etapaErr } = await deps.supabase
    .from("crm_stages")
    .select("id, is_archived")
    .eq("id", stageId)
    .eq("organization_id", deps.organizationId)
    .eq("pipeline_id", pipelineId)
    .maybeSingle();
  if (etapaErr) {
    throw new ApiError(500, "internal_error", undefined, deps.requestId, etapaErr.message);
  }
  if (!etapa) {
    throw new ApiError(
      422,
      "unprocessable_entity",
      undefined,
      deps.requestId,
      "Essa etapa não pertence ao funil escolhido. Escolha uma etapa do mesmo funil.",
    );
  }
  // Etapa arquivada sumiu do quadro: os contatos entrariam onde ninguém olha.
  if ((etapa as { is_archived: boolean }).is_archived) {
    throw new ApiError(
      422,
      "unprocessable_entity",
      undefined,
      deps.requestId,
      "Essa etapa foi arquivada e não aparece mais no quadro. Escolha uma etapa em uso.",
    );
  }
}

export interface NovaEntradaAutomatica {
  name: string;
  default_pipeline_id: string;
  default_stage_id: string;
  redirect_to?: string | null;
  field_map?: Record<string, string[]>;
  form_fields?: WebhookFormField[];
  /** Já CIFRADO pelo chamador. A operação nunca vê plaintext de segredo. */
  secret_encrypted?: string | null;
}

export async function criarEntradaAutomatica(
  deps: DepsDaOperacao,
  input: NovaEntradaAutomatica,
): Promise<FonteVisivel> {
  await destinoValido(deps, input.default_pipeline_id, input.default_stage_id);

  // `path_token` é a identidade PÚBLICA da URL de captação — mesmo papel que o
  // token de caminho que os adapters de canal já usam —, não um segredo forte.
  // Por isso volta no corpo da resposta.
  //
  // Sem nomear provider aqui de propósito: `pnpm lint:channels` proíbe o nome
  // fora de `lib/channels/` inclusive em comentário, e está certo — prosa é
  // onde o acoplamento reaparece primeiro, porque ninguém a compila.
  const pathToken = randomBytes(24).toString("base64url");

  const { data: created, error } = await deps.supabase
    .from("webhook_sources")
    .insert({
      organization_id: deps.organizationId,
      created_by_user_id: deps.actor.type === "user" ? deps.actor.id : null,
      name: input.name,
      path_token: pathToken,
      secret_encrypted: input.secret_encrypted ?? null,
      default_pipeline_id: input.default_pipeline_id,
      default_stage_id: input.default_stage_id,
      field_map: input.field_map ?? {},
      form_fields: input.form_fields ?? [],
      redirect_to: input.redirect_to ?? null,
      ...autoriaDaMudanca(deps.actor),
    })
    .select(COLUNAS)
    .single();
  if (error || !created) {
    throw new ApiError(
      500,
      "internal_error",
      undefined,
      deps.requestId,
      error?.message ?? "webhook_source_insert_failed",
    );
  }

  await audit({
    action: "webhook.source_created",
    actorUserId: deps.actor.type === "user" ? deps.actor.id : null,
    organizationId: deps.organizationId,
    resourceType: "webhook_source",
    resourceId: (created as unknown as { id: string }).id,
    requestId: deps.requestId,
    metadata: { name: input.name, actor_type: deps.actor.type },
  });

  return semSegredo(created as unknown as Record<string, unknown>);
}

/**
 * Liga ou desliga a entrada — o efeito é IMEDIATO sobre o mundo externo.
 *
 * Desligar faz o formulário que já está no ar do cliente parar de virar contato
 * (`lib/webhooks/inbound.ts` recusa fonte inativa). É por isso que a capacidade
 * equivalente do agente é classificada `critico`: ninguém vê acontecer.
 */
export async function definirEntradaAtiva(
  deps: DepsDaOperacao,
  input: { id: string; ativa: boolean },
): Promise<FonteVisivel> {
  const antes = await fonteDaOrg(deps, input.id);

  const { data: updated, error } = await deps.supabase
    .from("webhook_sources")
    .update({
      is_active: input.ativa,
      updated_at: new Date().toISOString(),
      ...autoriaDaMudanca(deps.actor),
    })
    .eq("id", input.id)
    .eq("organization_id", deps.organizationId)
    .select(COLUNAS)
    .single();
  if (error || !updated) {
    throw new ApiError(
      500,
      "internal_error",
      undefined,
      deps.requestId,
      error?.message ?? "webhook_source_update_failed",
    );
  }

  await audit({
    action: "webhook.source_updated",
    actorUserId: deps.actor.type === "user" ? deps.actor.id : null,
    organizationId: deps.organizationId,
    resourceType: "webhook_source",
    resourceId: input.id,
    requestId: deps.requestId,
    metadata: {
      is_active: input.ativa,
      de: antes.is_active,
      name: antes.name,
      actor_type: deps.actor.type,
    },
  });

  return semSegredo(updated as unknown as Record<string, unknown>);
}

export interface RecebimentoDaEntrada {
  id: string;
  recebido_em: string;
  assinatura_valida: boolean | null;
  status: string | null;
  campos_recebidos: string[];
}

/**
 * O que chegou por uma entrada — a prova de que o formulário do cliente funciona.
 *
 * ⚠️ DEVOLVE OS NOMES DOS CAMPOS, NÃO OS VALORES. `payload_parsed` traz o que a
 * pessoa digitou no formulário: nome, telefone, e-mail. Isso é PII, e este
 * retorno vai para dentro do contexto de um modelo de linguagem. Quem precisa
 * do conteúdo tem o contato criado a partir dele, sob as regras de LGPD do repo;
 * quem precisa diagnosticar ("o formulário manda `full_name` e a fonte espera
 * `name`") precisa só das CHAVES — que é exatamente o que resolve o problema.
 */
export async function recebimentosDaEntrada(
  deps: DepsDaOperacao,
  input: { id: string; limite: number },
): Promise<RecebimentoDaEntrada[]> {
  const fonte = await fonteDaOrg(deps, input.id);

  const { data, error } = await deps.supabase
    .from("webhook_events_log")
    .select("id, received_at, valid_signature, payload_parsed, status")
    .eq("webhook_path_token", fonte.path_token)
    .order("received_at", { ascending: false })
    .limit(input.limite);
  if (error) throw new ApiError(500, "internal_error", undefined, deps.requestId, error.message);

  return ((data ?? []) as unknown as Array<Record<string, unknown>>).map((e) => ({
    id: e.id as string,
    recebido_em: e.received_at as string,
    assinatura_valida: (e.valid_signature as boolean | null) ?? null,
    status: (e.status as string | null) ?? null,
    campos_recebidos: chavesDo(e.payload_parsed),
  }));
}

function chavesDo(payload: unknown): string[] {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return [];
  return Object.keys(payload as Record<string, unknown>);
}
