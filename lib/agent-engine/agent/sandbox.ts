import type pg from "pg";
import { loadAgentVersionConfig } from "./agent-config";
import { runAgentPreview, type InboundTurnDeps } from "./inbound-turn";
import { newPreviewResult, scenarioContext } from "./preview";
import type { LeadContextMessage } from "../edge/crm/get-lead-context";
import { trimTranscriptToBudget } from "./compaction";

/** Uma mensagem anterior do teste — o que o admin digitou e o que a IA respondeu. */
export interface TesteHistoryMessage {
  direction: "inbound" | "outbound";
  body: string;
}

export async function testAgentVersion(
  pool: pg.Pool,
  deps: InboundTurnDeps,
  input: {
    organizationId: string;
    agentId: string;
    versionId: string;
    runId: string;
    sampleMessage: string;
    /**
     * #4424 — a conversa do teste até aqui. Cada disparo reenvia os turnos
     * anteriores; sem eles o motor avaliava a mensagem nova sozinha e não dava
     * para ver objeção, mudança de assunto ou volta ao preço. O rascunho vive
     * só no estado da tela: o corpo da requisição é o único transporte.
     */
    history?: TesteHistoryMessage[];
    sampleContact?: { name?: string; phone?: string };
    /** Etiquetas simuladas (spec 27, fatia 3): entram no matcher de skills desta prévia. */
    sampleTags?: string[];
    channelId: string | null;
  },
) {
  const agent = await loadAgentVersionConfig(
    pool,
    input.organizationId,
    input.agentId,
    input.versionId,
  );
  if (!agent) throw new Error("preview_version_unavailable");
  const result = newPreviewResult();

  /**
   * O CONTEXTO DO TESTE É A CONVERSA — e ele passa pelas MESMAS duas peneiras do
   * turno real, para a conversa de teste não virar custo ilimitado:
   *
   *   • `history_message_window` (default 20) — só as últimas N mensagens;
   *   • `history_token_window` (default 8.000) — o mesmo orçamento de tokens que
   *     `getLeadContext` aplica no turno real, medido pela heurística de
   *     `countPayloadTokens` (`trimTranscriptToBudget`, a função pura da
   *     compactação).
   *
   * A mensagem nova é SEMPRE a última e é o que o turno responde; se o
   * orçamento não couber nem ela, o contexto cai para ela sozinha em vez de
   * mandar um turno vazio ao modelo.
   */
  const agora = deps.clock?.() ?? new Date();
  const anteriores: LeadContextMessage[] = (input.history ?? []).map((m, i, todos) => ({
    direction: m.direction,
    body: m.body,
    // Horários crescentes e fictícios: só ordenam a leitura no prompt.
    sent_at: new Date(agora.getTime() - (todos.length - i) * 60_000).toISOString(),
  }));
  const novaMensagem: LeadContextMessage = {
    direction: "inbound",
    body: input.sampleMessage,
    sent_at: agora.toISOString(),
  };
  const janelaDeMensagens = Math.max(1, agent.historyMessageWindow);
  const naJanela = [...anteriores, novaMensagem].slice(-janelaDeMensagens);
  const orcado = trimTranscriptToBudget(naJanela, agent.historyTokenWindow);
  const mensagensDoContexto = orcado.length > 0 ? orcado : [novaMensagem];

  const context = scenarioContext(mensagensDoContexto, input.sampleContact);
  await runAgentPreview(deps, pool, {
    kind: "sandbox",
    organizationId: input.organizationId,
    runId: input.runId,
    agent,
    context,
    contactId: null,
    channelId: input.channelId,
    tags: input.sampleTags,
    result,
  });
  return result;
}
