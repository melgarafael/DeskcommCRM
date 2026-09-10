/**
 * LanguageModel V3 nativo para o backend do Codex.
 *
 * POR QUE NÃO `createOpenAI(...)(model)`: o `.responses()` do `@ai-sdk/openai`
 * v4 é BATCH (Experimental_BatchLanguageModelV4) — não entra em
 * `generateText` — e o chat-completions bateria no caminho errado. O backend
 * do Codex fala Responses API (observado; sem contrato documentado), então a
 * fiação é direta: monta o corpo Responses, POST com o envelope de
 * identidade, lê o terminal do SSE.
 *
 * O QUE VIAJA (e o que deliberadamente NÃO viaja): model, instructions
 * (system), input (mensagens + tool results), tools function, tool_choice,
 * reasoning.effort, max_output_tokens, stream, store. `temperature`/`top_p`/
 * `top_k`/penalties/seed NÃO viajam — o backend rejeita `temperature`, e do
 * resto não há observação. Mandar o que não se mediu é como o 400 mascarado
 * de antes: falha que parece revogação.
 */
import type {
  LanguageModelV3,
  LanguageModelV3CallOptions,
  LanguageModelV3Content,
  LanguageModelV3FinishReason,
  LanguageModelV3StreamPart,
  LanguageModelV3Usage,
} from "@ai-sdk/provider";

import {
  CODEX_INFERENCE_BASE_URL,
  CODEX_RESPONSES_PATH,
} from "./constantes";
import { lerRespostaSSE } from "./execucao";

export type EsforcoDeRaciocinio = "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export interface CodexModeloOpts {
  accessToken: string;
  /** `chatgpt_account_id` — sem ele o backend não monta o envelope. */
  accountId?: string | null;
  modelId: string;
  originator?: string;
  fetchImpl?: (input: string | URL, init?: RequestInit) => Promise<Response>;
  /** Default `xhigh` (pedido do dono; barato no luna). */
  reasoningEffort?: EsforcoDeRaciocinio;
}

type ItemResponses = Record<string, unknown>;

function textoDasPartes(partes: ReadonlyArray<{ type: string; text?: unknown }>): string {
  return partes
    .filter((p) => p.type === "text" && typeof p.text === "string")
    .map((p) => p.text as string)
    .join("");
}

function montarInput(mensagens: LanguageModelV3CallOptions["prompt"]): ItemResponses[] {
  const itens: ItemResponses[] = [];
  for (const msg of mensagens) {
    if (msg.role === "system") continue; // system vira `instructions`, não input
    if (msg.role === "user") {
      itens.push({
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: textoDasPartes(msg.content) }],
      });
      continue;
    }
    if (msg.role === "assistant") {
      for (const parte of msg.content) {
        if (parte.type === "text") {
          itens.push({
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: parte.text }],
          });
        } else if (parte.type === "tool-call") {
          // `input` aqui é OBJETO (o AI SDK já parseou); o Responses exige
          // `arguments` STRING — mandar o objeto dá 400 `invalid_type`.
          itens.push({
            type: "function_call",
            call_id: parte.toolCallId,
            name: parte.toolName,
            arguments: typeof parte.input === "string" ? parte.input : JSON.stringify(parte.input),
          });
        }
        // reasoning/file: internos do modelo, não voltam ao input.
      }
      continue;
    }
    if (msg.role === "tool") {
      for (const parte of msg.content) {
        if (parte.type === "tool-result") {
          itens.push({
            type: "function_call_output",
            call_id: parte.toolCallId,
            output: serializarSaidaDeTool(parte.output),
          });
        }
      }
    }
  }
  return itens;
}

/** Desembrulha o envelope de output do AI SDK para o payload que o Responses espera. */
function serializarSaidaDeTool(output: unknown): string {
  if (typeof output === "string") return output;
  if (typeof output === "object" && output !== null) {
    const env = output as { type?: unknown; value?: unknown };
    if ((env.type === "text" || env.type === "json") && "value" in env) {
      return typeof env.value === "string" ? env.value : JSON.stringify(env.value);
    }
  }
  return JSON.stringify(output);
}

function montarTools(
  tools: LanguageModelV3CallOptions["tools"],
  toolChoice: LanguageModelV3CallOptions["toolChoice"],
): { tools?: ItemResponses[]; tool_choice?: unknown } {
  if (!tools || tools.length === 0) return {};
  const saidas: ItemResponses[] = [];
  for (const t of tools) {
    if (t.type !== "function") continue; // provider-defined não atravessa
    saidas.push({ type: "function", name: t.name, description: t.description ?? "", parameters: t.inputSchema });
  }
  if (saidas.length === 0) return {};
  let tool_choice: unknown = "auto";
  if (toolChoice?.type === "none" || toolChoice?.type === "required") tool_choice = toolChoice.type;
  else if (toolChoice?.type === "tool") tool_choice = { type: "function", name: toolChoice.toolName };
  return { tools: saidas, tool_choice };
}

function mapearConteudo(output: unknown): { conteudo: LanguageModelV3Content[]; temTool: boolean } {
  const conteudo: LanguageModelV3Content[] = [];
  let temTool = false;
  if (!Array.isArray(output)) return { conteudo, temTool };
  for (const item of output as ItemResponses[]) {
    if (item["type"] === "message") {
      const textos = ((item["content"] as ItemResponses[] | undefined) ?? [])
        .filter((c) => c["type"] === "output_text" && typeof c["text"] === "string")
        .map((c) => c["text"] as string)
        .join("");
      const recusas = ((item["content"] as ItemResponses[] | undefined) ?? [])
        .filter((c) => c["type"] === "refusal" && typeof c["refusal"] === "string")
        .map((c) => c["refusal"] as string)
        .join("");
      const texto = textos + recusas;
      if (texto !== "") conteudo.push({ type: "text", text: texto });
    } else if (item["type"] === "function_call") {
      temTool = true;
      conteudo.push({
        type: "tool-call",
        toolCallId: (item["call_id"] as string) ?? (item["id"] as string) ?? `call_${conteudo.length}`,
        toolName: item["name"] as string,
        input: (item["arguments"] as string) ?? "{}",
      });
    }
  }
  return { conteudo, temTool };
}

function mapearUso(usage: unknown): LanguageModelV3Usage {
  const u = (usage ?? {}) as Record<string, unknown>;
  const detalhes = (u["output_tokens_details"] as Record<string, unknown> | undefined) ?? {};
  return {
    inputTokens: {
      total: typeof u["input_tokens"] === "number" ? u["input_tokens"] : undefined,
      noCache: undefined,
      cacheRead: undefined,
      cacheWrite: undefined,
    },
    outputTokens: {
      total: typeof u["output_tokens"] === "number" ? u["output_tokens"] : undefined,
      text: typeof u["output_tokens"] === "number" ? u["output_tokens"] : undefined,
      reasoning: typeof detalhes["reasoning_tokens"] === "number" ? detalhes["reasoning_tokens"] : undefined,
    },
  };
}

export function criarModeloCodex(opts: CodexModeloOpts): LanguageModelV3 {
  const {
    accessToken,
    accountId,
    modelId,
    originator = "deskcomm-crm",
    fetchImpl = globalThis.fetch,
    reasoningEffort = "xhigh",
  } = opts;

  async function executar(
    options: LanguageModelV3CallOptions,
  ): Promise<{
    resposta: Record<string, unknown>;
    deltas: { texto: string; chamadas: Array<{ callId: string; name: string; arguments: string }> };
    corpoEnviado: Record<string, unknown>;
  }> {
    const instructions = options.prompt
      .map((m) => (m.role === "system" ? m.content : ""))
      .filter((t) => t !== "")
      .join("\n\n");
    const { tools, tool_choice } = montarTools(options.tools, options.toolChoice);
    const esforco =
      (options.providerOptions?.["openai-codex"] as { reasoningEffort?: EsforcoDeRaciocinio } | undefined)
        ?.reasoningEffort ?? reasoningEffort;
    const corpo: Record<string, unknown> = {
      model: modelId,
      instructions,
      input: montarInput(options.prompt),
      ...(tools ? { tools, tool_choice } : {}),
      reasoning: { effort: esforco },
      ...(options.maxOutputTokens !== undefined ? { max_output_tokens: options.maxOutputTokens } : {}),
      stream: true,
      store: false,
    };
    const headers: Record<string, string> = {
      authorization: `Bearer ${accessToken}`,
      "content-type": "application/json",
      accept: "text/event-stream",
      originator,
    };
    if (accountId) headers["ChatGPT-Account-ID"] = accountId;

    const res = await fetchImpl(`${CODEX_INFERENCE_BASE_URL}${CODEX_RESPONSES_PATH}`, {
      method: "POST",
      headers,
      body: JSON.stringify(corpo),
      signal: options.abortSignal ?? undefined,
    });
    if (!res.ok || !res.body) {
      const detalhe = await res.text().catch(() => "");
      const err = new Error(`codex_responses_${res.status}: ${detalhe.slice(0, 300)}`) as Error & {
        status?: number;
      };
      err.status = res.status;
      throw err;
    }
    const carga = await lerRespostaSSE(res);
    if (!carga.resposta) throw new Error("codex_sem_terminal: o stream fechou sem response.completed");
    return { resposta: carga.resposta, deltas: { texto: carga.texto, chamadas: carga.chamadas }, corpoEnviado: corpo };
  }

  const modelo: LanguageModelV3 = {
    specificationVersion: "v3",
    provider: "openai-codex",
    modelId,
    supportedUrls: {},
    async doGenerate(options) {
      const { resposta, deltas } = await executar(options);
      // Terminal preenchido manda; terminal vazio (o caso `store:false`
      // medido) cai nos deltas acumulados — nunca resposta vazia silenciosa.
      const terminal = mapearConteudo(resposta["output"]);
      // Chamada sem nome é malformada (o backend às vezes anuncia o item duas
      // vezes, uma sem nome): inexequível pelo AI SDK e 400 no turno seguinte.
      // O acumulador já funde apelidos; o que restar sem nome cai aqui — e se
      // nada restar, o erro é alto (`NoOutputGeneratedError`), nunca 400 mudo.
      const chamadasValidas = deltas.chamadas.filter((c) => c.name !== "");
      const conteudo =
        terminal.conteudo.length > 0
          ? terminal.conteudo
          : [
              ...(deltas.texto !== "" ? [{ type: "text" as const, text: deltas.texto }] : []),
              ...chamadasValidas.map((c) => ({
                type: "tool-call" as const,
                toolCallId: c.callId,
                toolName: c.name,
                input: c.arguments === "" ? "{}" : c.arguments,
              })),
            ];
      const temTool = terminal.temTool || chamadasValidas.length > 0;
      const finishReason: LanguageModelV3FinishReason = temTool
        ? { unified: "tool-calls", raw: "completed" }
        : { unified: "stop", raw: "completed" };
      return {
        content: conteudo,
        finishReason,
        usage: mapearUso(resposta["usage"]),
        providerMetadata: undefined,
        response: {
          id: typeof resposta["id"] === "string" ? resposta["id"] : undefined,
          modelId: typeof resposta["model"] === "string" ? resposta["model"] : undefined,
        },
        warnings: [],
      };
    },
    // Nenhum chamador de produção usa stream (o seam é generateText); o
    // replay abaixo existe para o tipo fechar sem mentir capacidade.
    async doStream(options) {
      const gerado = await modelo.doGenerate(options);
      const partes: LanguageModelV3StreamPart[] = [{ type: "stream-start", warnings: [] }];
      let n = 0;
      for (const item of gerado.content) {
        if (item.type === "text") {
          const id = `txt-${n++}`;
          partes.push({ type: "text-start", id }, { type: "text-delta", id, delta: item.text }, { type: "text-end", id });
        } else if (item.type === "tool-call") {
          partes.push(
            { type: "tool-input-start", id: item.toolCallId, toolName: item.toolName },
            { type: "tool-input-delta", id: item.toolCallId, delta: item.input },
            { type: "tool-input-end", id: item.toolCallId },
            item,
          );
        }
      }
      partes.push({ type: "finish", usage: gerado.usage, finishReason: gerado.finishReason });
      return {
        stream: new ReadableStream<LanguageModelV3StreamPart>({
          start(controlador) {
            for (const p of partes) controlador.enqueue(p);
            controlador.close();
          },
        }),
      };
    },
  };
  return modelo;
}
