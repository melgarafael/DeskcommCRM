/**
 * @deprecated Fase 0 da convergência (spec 2026-07-23): fora do caminho quente.
 * O runtime canônico é lib/agent-engine (workers/agent-worker). Remoção física
 * planejada após um ciclo de estabilidade. Não adicionar features aqui.
 *
 * `runAgent({ runId, override? })` — heart of EPIC-13 (S-13.08).
 *
 * Sequence (Spec 10 §6):
 *   1. Load run + version + decrypt credential
 *   2. Sentinel keyword check on inbound → finalizeHandoff('keyword_match')
 *   3. Mint ephemeral api_token + setup MCP context
 *   4. Build tool set (in-process bridge to lib/mcp/tools)
 *   5. Load history sliding window
 *   6. generateText with stopWhen=[stepCountIs(maxSteps), budgetGuard]
 *   7. Detect handoff signal → finalizeHandoff('agent_invoked_tool')
 *   8. !dry_run → outbound message via sendMessageHandler (canal da sessão)
 *   9. finalizeRun
 *  10. revoke ephemeral token (always)
 *
 * Robustness:
 *   - Try/catch global: any throw → finalizeRun('failed', error_message=...).
 *   - Dry-run path bypasses concurrency unique guard, channel dispatch, outbound row.
 *   - Plaintext API keys are never logged.
 */
import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createOpenAI } from "@ai-sdk/openai";
import { generateText, stepCountIs, type LanguageModel, type StopCondition, type ToolSet } from "ai";

// Fonte única do endpoint — a mesma constante que o registry de produção usa.
// Repetir a URL aqui criaria dois lugares para consertar quando ela mudar.
import {
  cabecalhosDeAtribuicaoOpenRouter,
  OPENROUTER_ENDPOINT,
} from "@/lib/agent-engine/edge/llm/providers";
import { CredentialUnavailableError, loadCredential } from "@/lib/ai/credentials";
import { decidirElegibilidadeDaConversaViaSupabase } from "@/lib/ai/elegibilidade/consulta-supabase";
import { ttlDaAutorizacaoMs } from "@/lib/ai/elegibilidade/gate";
import { createAdminClient } from "@/lib/supabase/admin";
import { audit } from "@/lib/audit";
import type { McpAuthResult } from "@/lib/mcp/auth";
import type { McpContext } from "@/lib/mcp/types";
import { computeCostCents } from "./cost";
import { finalizeRun } from "./finalize";
import { sendFinalResponse } from "./finalize";
import { finalizeHandoff } from "./handoff";
import { loadHistoryWithBudget } from "./history";
import { mintEphemeralToken, revokeEphemeralToken } from "./mcp_token";
import { pickToolsFromMcp, type RuntimeHandoffSignal } from "./tools";
import { serializeSteps } from "./serialize";
import {
  CHANNEL_SESSION_REF_COLUMNS,
  DEFAULT_CHANNEL_PROVIDER,
  getAdapter,
  resolveSessionRef,
  type ChannelSessionRef,
} from "@/lib/channels";

export interface RunAgentInput {
  runId: string;
  /** Optional override for test mode invocations from /ai/agents/:id/versions/:vid/test. */
  override?: {
    sampleMessage?: string;
    sampleContact?: { name?: string; phone?: string };
  };
}

export interface RunAgentResult {
  run_id: string;
  status: "completed" | "failed" | "aborted" | "handoff" | "skipped";
  final_text?: string;
  tool_calls?: ReturnType<typeof serializeSteps>;
  tokens_in?: number;
  tokens_out?: number;
  cost_cents?: number;
  latency_ms?: number;
  steps_count?: number;
  abort_reason?: string;
  error_code?: string;
  error_message?: string;
  would_send_to?: { session: string | null; chat_id: string | null };
}

interface RunRow {
  id: string;
  organization_id: string;
  agent_id: string;
  agent_version_id: string;
  conversation_id: string | null;
  contact_id: string | null;
  channel_session_id: string | null;
  inbound_message_id: string | null;
  status: string;
  is_dry_run: boolean;
}

interface VersionRow {
  id: string;
  organization_id: string;
  agent_id: string;
  system_prompt: string;
  provider: string;
  model: string;
  credential_id: string | null;
  tool_ids: string[];
  channel_session_id: string;
  max_steps: number;
  token_budget: number;
  cost_budget_cents: number;
  history_message_window: number;
  history_token_window: number;
  handoff_keywords: string[];
  handoff_tool_enabled: boolean;
  created_by: string | null;
}

interface AgentRow {
  id: string;
  organization_id: string;
  created_by: string | null;
}

function buildSentinelRegex(keywords: string[]): RegExp | null {
  const cleaned = keywords.filter((k) => typeof k === "string" && k.trim().length > 0);
  if (cleaned.length === 0) return null;
  const escaped = cleaned.map((k) => k.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  return new RegExp(`(${escaped.join("|")})`, "i");
}

/**
 * Builds the LM directly against the provider's own API using the org's BYOK
 * credential (`ai_provider_credentials`, decrypted by `loadCredential`).
 *
 * NOT routed through Vercel AI Gateway (`createGateway`): the Gateway
 * authenticates the CALLER with a Vercel-issued `AI_GATEWAY_API_KEY`, then
 * uses Vercel's own configured provider keys — it does not accept a tenant's
 * raw Anthropic/OpenAI/Google key as a substitute credential. Passing
 * `credentialApiKey` to `createGateway({ apiKey })` always failed with
 * "Unauthenticated. Configure AI_GATEWAY_API_KEY or use a provider module.",
 * which is exactly what this does — a direct provider module per `provider`.
 */
/**
 * Exportada por causa do invariante: este switch é o SEGUNDO lugar que precisa
 * conhecer um provedor novo (o primeiro é `createDefaultRegistry`, em
 * `lib/agent-engine/edge/llm/providers.ts`), e ficou três casos atrás dele.
 * `tests/unit/provedores-x-registry.test.ts` chama esta função para cada id de
 * `IDS_DE_PROVEDOR` — sem export, a única guarda possível seria procurar
 * `case "..."` no texto do arquivo, que passa com um switch que compila e não
 * executa.
 */
/**
 * A chave de plataforma do provedor — as mesmas variáveis que
 * `llmEdgeConfigFromEnv` lê no turno de produção. Google não tem: o runtime
 * real também não tem ramo de fallback para ele, e prometer aqui um caminho que
 * lá não existe faria o ensaio passar e a mensagem real falhar.
 */
export function chaveDePlataforma(provider: string): string | null {
  const nome = { anthropic: "ANTHROPIC_API_KEY", openai: "OPENAI_API_KEY", openrouter: "OPENROUTER_API_KEY" }[
    provider
  ];
  if (!nome) return null;
  const v = (process.env[nome] ?? "").trim();
  return v === "" ? null : v;
}

export function buildModel(provider: string, apiKey: string, modelId: string): LanguageModel {
  switch (provider) {
    case "anthropic":
      return createAnthropic({ apiKey })(modelId);
    case "openai":
      return createOpenAI({ apiKey })(modelId);
    case "google":
      return createGoogleGenerativeAI({ apiKey })(modelId);
    // O ensaio precisa alcançar o mesmo provedor que o turno real alcança.
    // Sem este caso, o dono que instalou pela opção [1] do instalador publica
    // o agente, clica em "Teste" para conferir antes de confiar, e recebe
    // `unsupported_provider` — enquanto a mensagem de verdade seria respondida
    // normalmente pelo worker. Erro no ensaio lê-se como produto quebrado.
    case "openrouter":
      return createOpenAI({
        apiKey,
        baseURL: OPENROUTER_ENDPOINT,
        headers: cabecalhosDeAtribuicaoOpenRouter(),
      })(modelId);
    default:
      throw new Error(`unsupported_provider: ${provider}`);
  }
}

function totalUsage(steps: ReadonlyArray<{ usage?: { inputTokens?: number; outputTokens?: number } }>) {
  let inputTokens = 0;
  let outputTokens = 0;
  for (const s of steps) {
    inputTokens += s.usage?.inputTokens ?? 0;
    outputTokens += s.usage?.outputTokens ?? 0;
  }
  return { inputTokens, outputTokens };
}

export async function runAgent(input: RunAgentInput): Promise<RunAgentResult> {
  const admin = createAdminClient();
  const startedAt = Date.now();

  // 1) Load run row.
  const { data: runRaw } = await admin
    .from("ai_agent_runs")
    .select(
      "id, organization_id, agent_id, agent_version_id, conversation_id, contact_id, channel_session_id, inbound_message_id, status, is_dry_run",
    )
    .eq("id", input.runId)
    .maybeSingle();

  const run = runRaw as RunRow | null;
  if (!run) {
    return { run_id: input.runId, status: "failed", error_code: "run_not_found" };
  }

  // Idempotency: terminal states early-return; running is treated as in-flight elsewhere.
  if (
    run.status === "completed" ||
    run.status === "failed" ||
    run.status === "aborted" ||
    run.status === "handoff"
  ) {
    return { run_id: run.id, status: "skipped" };
  }

  // 2) Promote to running. For non-dry-run rows, the partial unique index
  // (status='running' AND is_dry_run=false) protects from double-execution.
  const { error: promoteErr } = await admin
    .from("ai_agent_runs")
    .update({ status: "running" })
    .eq("id", run.id)
    .eq("organization_id", run.organization_id);
  if (promoteErr) {
    if (promoteErr.code === "23505") {
      // Conversation already has a running run.
      return { run_id: run.id, status: "skipped", abort_reason: "conv_busy" };
    }
    return failFast(run, "internal_error", `promote_failed: ${promoteErr.message}`, startedAt);
  }

  void audit({
    action: "ai_agent.run_started",
    organizationId: run.organization_id,
    resourceType: "ai_agent_run",
    resourceId: run.id,
    metadata: { agent_id: run.agent_id, agent_version_id: run.agent_version_id, is_dry_run: run.is_dry_run },
  });
  await admin.rpc("emit_event" as never, {
    p_event_type: "ai_agent.run_started",
    p_entity_kind: "ai_agent_run",
    p_entity_id: run.id,
    p_payload: { run_id: run.id, agent_id: run.agent_id, is_dry_run: run.is_dry_run },
    p_metadata: { source: "agent-runtime" },
    p_organization_id: run.organization_id,
  } as never);

  let ephemeralTokenId: string | null = null;

  try {
    // 3) Load version.
    const { data: versionRaw } = await admin
      .from("ai_agent_versions")
      .select(
        // `pipeline_ids` e `knowledge_source_ids` ENTRAM no SELECT.
        //
        // A linha 445 lia `version.pipeline_ids` de um objeto que este SELECT
        // nunca trouxe: o `?? []` do call site absorvia o `undefined` e o escopo
        // ficava SEMPRE vazio neste runtime — a marcação da tela existia e não
        // valia aqui. Coluna lida que o SELECT não pede é o defeito que
        // `agent-version-columns-drift.test.ts` existe para pegar nas cópias
        // vigiadas; esta não é uma delas.
        "id, organization_id, agent_id, system_prompt, provider, model, credential_id, tool_ids, channel_session_id, max_steps, token_budget, cost_budget_cents, history_message_window, history_token_window, handoff_keywords, handoff_tool_enabled, created_by, pipeline_ids, knowledge_source_ids",
      )
      .eq("id", run.agent_version_id)
      .eq("organization_id", run.organization_id)
      .maybeSingle();
    const version = versionRaw as VersionRow | null;
    if (!version) {
      return await failRun(run, "version_not_found", "agent version missing", startedAt);
    }

    const { data: agentRaw } = await admin
      .from("ai_agents")
      .select("id, organization_id, created_by")
      .eq("id", run.agent_id)
      .eq("organization_id", run.organization_id)
      .maybeSingle();
    const agent = agentRaw as AgentRow | null;

    // 4) Load credential. Plaintext lives only in this scope.
    //
    // Duas origens, na MESMA ordem que `resolveOrgLlmConfig` aplica no turno de
    // produção: a credencial cadastrada pela tela vence, e na falta dela vale a
    // chave de plataforma que veio na instalação.
    //
    // Sem o segundo caminho, o ensaio recusava com "version has no credential"
    // justamente na instalação mais comum — a que rodou o `install.sh`, colou a
    // chave no `.env` e nunca abriu a tela de Credenciais. O agente atendia um
    // cliente de verdade normalmente, e o botão de testar dizia que não dava.
    // Ensaio mais rígido que a produção não é cautela: é dizer que está
    // quebrado o que está funcionando.
    let credentialApiKey: string;
    if (version.credential_id) {
      try {
        const credential = await loadCredential(version.credential_id, run.organization_id);
        credentialApiKey = credential.apiKey;
      } catch (err) {
        const reason = err instanceof CredentialUnavailableError ? err.reason : "decrypt_failed";
        return await failRun(run, `credential_${reason}`, "credential unavailable", startedAt);
      }
    } else {
      const daInstalacao = chaveDePlataforma(version.provider);
      if (!daInstalacao) {
        return await failRun(
          run,
          "credential_invalid",
          `sem chave para ${version.provider}: cadastre em IA › Credenciais ou configure a chave desta instalação`,
          startedAt,
        );
      }
      credentialApiKey = daInstalacao;
    }

    // 5) Resolve inbound text + dispatch context.
    let inboundBody: string | null = null;
    let chatId: string | null = null;
    let waSessionName: string | null = null;
    const conversationIdForHandoff: string | null = run.conversation_id;

    if (run.is_dry_run) {
      inboundBody = input.override?.sampleMessage?.trim() ?? null;
      chatId = input.override?.sampleContact?.phone ?? null;
    } else if (run.inbound_message_id) {
      const { data: msg } = await admin
        .from("messages")
        .select("body")
        .eq("id", run.inbound_message_id)
        .eq("organization_id", run.organization_id)
        .maybeSingle();
      inboundBody = (msg?.body as string | null) ?? null;
    }

    // For non-dry-run, prefetch session_name + contact phone (chatId).
    if (!run.is_dry_run && run.conversation_id) {
      const { data: convRaw } = await admin
        .from("conversations")
        .select(
          `id, group_chat_id, is_group, contacts:contact_id(phone_number, wa_identity, wa_lid), channel_sessions:channel_session_id(${CHANNEL_SESSION_REF_COLUMNS})`,
        )
        .eq("id", run.conversation_id)
        .eq("organization_id", run.organization_id)
        .maybeSingle();
      const conv = convRaw as unknown as {
        id: string;
        group_chat_id: string | null;
        is_group: boolean;
        contacts: { phone_number: string | null; wa_identity: string | null; wa_lid: string | null } | null;
        channel_sessions: ChannelSessionRef | null;
      } | null;
      if (conv) {
        // Mesmo seam do handler de envio: quem sabe de que coluna sai o ref da
        // sessão, e como o telefone vira endereço, é `lib/channels/`.
        waSessionName = conv.channel_sessions ? resolveSessionRef(conv.channel_sessions) : null;
        chatId = getAdapter(conv.channel_sessions?.provider ?? DEFAULT_CHANNEL_PROVIDER).resolveRecipient({
          isGroup: conv.is_group,
          groupChatId: conv.group_chat_id,
          phoneNumber: conv.contacts?.phone_number,
          waIdentity: conv.contacts?.wa_identity,
          waLid: conv.contacts?.wa_lid,
        });
      }

      // GATE DE ELEGIBILIDADE — este runtime legado (@deprecated, hoje só o
      // dispatcher aposentado o alcança com envio real) TAMBÉM não pode
      // responder uma conversa que uma origem elegível não autorizou. Mesma
      // regra pura do drain/turno. Fail-closed: erro de leitura → falha o run
      // antes de qualquer custo de LLM.
      try {
        const elegib = await decidirElegibilidadeDaConversaViaSupabase(admin, {
          organizationId: run.organization_id,
          conversationId: run.conversation_id,
          agora: new Date(),
          ttlMs: ttlDaAutorizacaoMs(process.env),
        });
        if (elegib !== null && !elegib.permite) {
          return await failRun(run, "nao_elegivel_para_ia", `elegibilidade: ${elegib.motivo}`, startedAt);
        }
      } catch (err) {
        return await failRun(
          run,
          "nao_elegivel_para_ia",
          `elegibilidade indeterminada: ${err instanceof Error ? err.message.slice(0, 120) : "erro"}`,
          startedAt,
        );
      }
    }

    if (!inboundBody) {
      return await failRun(run, "inbound_missing", "no inbound body to process", startedAt);
    }

    // 6) Sentinel keyword check (BEFORE LLM cost).
    const sentinel = buildSentinelRegex(version.handoff_keywords ?? []);
    if (sentinel && sentinel.test(inboundBody)) {
      await finalizeHandoff({
        runId: run.id,
        organizationId: run.organization_id,
        conversationId: conversationIdForHandoff,
        reason: "requested_human",
        source: "sentinel",
        latencyMs: Date.now() - startedAt,
        isDryRun: run.is_dry_run,
      });
      return {
        run_id: run.id,
        status: "handoff",
        abort_reason: "sentinel:requested_human",
        latency_ms: Date.now() - startedAt,
        tokens_in: 0,
        tokens_out: 0,
        cost_cents: 0,
        steps_count: 0,
        would_send_to: { session: waSessionName, chat_id: chatId },
      };
    }

    // 7) Mint ephemeral token + build MCP context.
    const ephemeral = await mintEphemeralToken({
      organizationId: run.organization_id,
      runId: run.id,
      versionCreatedBy: version.created_by,
      agentCreatedBy: agent?.created_by,
    });
    ephemeralTokenId = ephemeral.id;

    const auth: McpAuthResult = {
      organizationId: run.organization_id,
      role: "ai_operator",
      actor: {
        type: "ai_agent",
        // `id` é o RUN — é o que correlaciona a chamada de tool com o turno no
        // audit. `agent_id` é a linha em `ai_agents`, e é a única que pode ir
        // para `crm_lead_activities.actor_agent_id` (FK). Enquanto só existia
        // `id`, toda tool de escrita chamada por este runtime perdia a atividade
        // na FK: o lead mudava e a timeline não registrava. Ver `Actor` em
        // lib/api/handlers/types.ts.
        id: run.id,
        agent_id: run.agent_id,
        role: "ai_operator",
        api_token_id: ephemeral.id,
      },
      apiTokenId: ephemeral.id,
      scopes: [
        "mcp:read",
        "mcp:write",
        "actor:ai_agent",
        `agent_run:${run.id}`,
        "role:ai_operator",
      ],
    };
    const ctx: McpContext = {
      organizationId: run.organization_id,
      role: "ai_operator",
      actor: auth.actor,
      apiTokenId: ephemeral.id,
      requestId: run.id,
      supabase: admin,
    };
    const handoffSignal: RuntimeHandoffSignal = { triggered: false };
    const tools = pickToolsFromMcp({
      supabase: admin,
      ctx,
      auth,
      toolIds: version.tool_ids ?? [],
      handoffToolEnabled: version.handoff_tool_enabled,
      // `?? []` — o clone sem a coluna 0125 nasce FECHADO.
      pipelineIds: (version as { pipeline_ids?: string[] }).pipeline_ids ?? [],
      handoffSignal,
    });

    // 8) Load history with budget.
    const history = run.conversation_id
      ? await loadHistoryWithBudget(admin, {
          conversationId: run.conversation_id,
          organizationId: run.organization_id,
          messageWindow: version.history_message_window,
          tokenWindow: version.history_token_window,
          excludeMessageId: run.inbound_message_id ?? undefined,
        })
      : [];

    // 9) Build LM directly against the provider (BYOK credential — see buildModel doc).
    const model = buildModel(version.provider, credentialApiKey, version.model);

    // 10) Cost/token guard. Fires BEFORE the next step is taken.
    let abortReason: string | null = null;
    const budgetGuard: StopCondition<ToolSet> = async ({ steps }) => {
      if (handoffSignal.triggered) {
        abortReason = "handoff_tool";
        return true;
      }
      const usage = totalUsage(steps as Array<{ usage?: { inputTokens?: number; outputTokens?: number } }>);
      const totalTokens = usage.inputTokens + usage.outputTokens;
      if (totalTokens > version.token_budget) {
        abortReason = "token_budget_exceeded";
        return true;
      }
      const cost = await computeCostCents({
        provider: version.provider,
        model: version.model,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
      });
      if (cost > version.cost_budget_cents) {
        abortReason = "cost_budget_exceeded";
        return true;
      }
      return false;
    };

    // 11) Run the loop.
    const messages = [
      ...history.map((m) => ({ role: m.role, content: m.content })),
      { role: "user" as const, content: inboundBody },
    ];

    const result = await generateText({
      model,
      system: version.system_prompt,
      messages,
      tools,
      stopWhen: [stepCountIs(version.max_steps), budgetGuard],
    });

    // 12) Aggregate metrics.
    const usage = totalUsage(result.steps as Array<{ usage?: { inputTokens?: number; outputTokens?: number } }>);
    const cost = await computeCostCents({
      provider: version.provider,
      model: version.model,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
    });
    const latencyMs = Date.now() - startedAt;
    const trace = serializeSteps(result.steps as never);

    // 13) Handoff via tool call?
    if (handoffSignal.triggered) {
      await finalizeHandoff({
        runId: run.id,
        organizationId: run.organization_id,
        conversationId: conversationIdForHandoff,
        reason: (handoffSignal.reason as never) ?? "requested_human",
        source: "tool",
        latencyMs,
        tokensIn: usage.inputTokens,
        tokensOut: usage.outputTokens,
        costCents: cost,
        stepsCount: result.steps.length,
        toolCalls: trace,
        isDryRun: run.is_dry_run,
      });
      return {
        run_id: run.id,
        status: "handoff",
        abort_reason: `tool:${handoffSignal.reason ?? "requested_human"}`,
        tokens_in: usage.inputTokens,
        tokens_out: usage.outputTokens,
        cost_cents: cost,
        latency_ms: latencyMs,
        steps_count: result.steps.length,
        tool_calls: trace,
        would_send_to: { session: waSessionName, chat_id: chatId },
      };
    }

    // 14) Budget abort detected via stopWhen?
    if (abortReason) {
      await finalizeRun({
        runId: run.id,
        organizationId: run.organization_id,
        status: "aborted",
        tokensIn: usage.inputTokens,
        tokensOut: usage.outputTokens,
        costCents: cost,
        latencyMs,
        stepsCount: result.steps.length,
        toolCalls: trace,
        abortReason,
        isDryRun: run.is_dry_run,
      });
      return {
        run_id: run.id,
        status: "aborted",
        abort_reason: abortReason,
        tokens_in: usage.inputTokens,
        tokens_out: usage.outputTokens,
        cost_cents: cost,
        latency_ms: latencyMs,
        steps_count: result.steps.length,
        tool_calls: trace,
        would_send_to: { session: waSessionName, chat_id: chatId },
      };
    }

    // 15) Hit max steps without natural finish?
    if (result.steps.length >= version.max_steps && result.finishReason !== "stop") {
      await finalizeRun({
        runId: run.id,
        organizationId: run.organization_id,
        status: "aborted",
        tokensIn: usage.inputTokens,
        tokensOut: usage.outputTokens,
        costCents: cost,
        latencyMs,
        stepsCount: result.steps.length,
        toolCalls: trace,
        abortReason: "max_steps_reached",
        isDryRun: run.is_dry_run,
      });
      return {
        run_id: run.id,
        status: "aborted",
        abort_reason: "max_steps_reached",
        tokens_in: usage.inputTokens,
        tokens_out: usage.outputTokens,
        cost_cents: cost,
        latency_ms: latencyMs,
        steps_count: result.steps.length,
        tool_calls: trace,
        would_send_to: { session: waSessionName, chat_id: chatId },
      };
    }

    // 16) Happy path. Send the reply through the channel when not dry-run.
    let outboundMessageId: string | null = null;
    const finalText = (result.text ?? "").trim();
    if (!run.is_dry_run && finalText && run.conversation_id) {
      outboundMessageId = await sendFinalResponse({
        supabase: admin,
        organizationId: run.organization_id,
        runId: run.id,
        agentId: run.agent_id,
        conversationId: run.conversation_id,
        text: finalText,
        requestId: run.id,
      });
    }

    await finalizeRun({
      runId: run.id,
      organizationId: run.organization_id,
      status: "completed",
      tokensIn: usage.inputTokens,
      tokensOut: usage.outputTokens,
      costCents: cost,
      latencyMs,
      stepsCount: result.steps.length,
      toolCalls: trace,
      outboundMessageId,
      isDryRun: run.is_dry_run,
    });

    return {
      run_id: run.id,
      status: "completed",
      final_text: finalText,
      tokens_in: usage.inputTokens,
      tokens_out: usage.outputTokens,
      cost_cents: cost,
      latency_ms: latencyMs,
      steps_count: result.steps.length,
      tool_calls: trace,
      would_send_to: { session: waSessionName, chat_id: chatId },
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return await failRun(run, "runtime_error", message, startedAt);
  } finally {
    if (ephemeralTokenId) {
      await revokeEphemeralToken(ephemeralTokenId).catch(() => {
        // Token TTL=300s; lingering revoke failure is non-critical.
      });
    }
  }
}

async function failRun(
  run: RunRow,
  code: string,
  message: string,
  startedAt: number,
): Promise<RunAgentResult> {
  const latencyMs = Date.now() - startedAt;
  await finalizeRun({
    runId: run.id,
    organizationId: run.organization_id,
    status: "failed",
    errorCode: code,
    errorMessage: message,
    latencyMs,
    isDryRun: run.is_dry_run,
  });
  return {
    run_id: run.id,
    status: "failed",
    error_code: code,
    error_message: message,
    latency_ms: latencyMs,
  };
}

function failFast(
  run: RunRow,
  code: string,
  message: string,
  startedAt: number,
): RunAgentResult {
  // Used when we couldn't even promote to running — no row mutation here.
  return {
    run_id: run.id,
    status: "failed",
    error_code: code,
    error_message: message,
    latency_ms: Date.now() - startedAt,
  };
}
