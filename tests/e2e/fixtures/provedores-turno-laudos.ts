import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage } from "node:http";

import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { z } from "zod";

import type { ProviderRegistry } from "../../../lib/agent-engine/edge/llm/providers";

export type ProvedorDoTurnoLaudos = "anthropic" | "openai";
export const MODELOS_DO_TURNO = {
  anthropic: "claude-sonnet-4-6",
  openai: "gpt-4o-mini",
} as const;
export const RESPOSTA_DA_IA = "Resposta sintética da IA.";

const CHECKPOINT = JSON.stringify({
  commitments: [],
  objections: [],
  next_action: null,
  rolling_summary: "Turno sintético.",
});
const MARCADOR_DO_FECHAMENTO = "Feche o turno AGORA.";
const TETO_DE_CHAMADAS = 3;
const TETO_DE_BYTES = 2 * 1024 * 1024;

const pedidoAnthropic = z.object({
  model: z.string(),
  messages: z.array(z.object({ role: z.string(), content: z.unknown() }).passthrough()).min(1),
  tools: z.array(z.object({ name: z.string(), input_schema: z.unknown() }).passthrough()).optional(),
  stream: z.literal(false).optional(),
}).passthrough();

const pedidoOpenAI = z.object({
  model: z.string(),
  input: z.array(z.unknown()).min(1),
  tools: z.array(z.object({ type: z.string(), name: z.string().optional() }).passthrough()).optional(),
  stream: z.literal(false).optional(),
}).passthrough();

type Fase = "send_message" | "encerramento" | "checkpoint";
interface Observacao {
  provider: ProvedorDoTurnoLaudos;
  path: string;
  model: string;
  fase: Fase;
}
interface Rodada {
  provider: ProvedorDoTurnoLaudos;
  esperaModelo: boolean;
  requests: number;
  observacoes: Observacao[];
  falhas: string[];
}

async function lerJson(req: IncomingMessage): Promise<unknown> {
  const partes: Buffer[] = [];
  let tamanho = 0;
  for await (const parte of req) {
    const bytes = Buffer.isBuffer(parte) ? parte : Buffer.from(String(parte));
    tamanho += bytes.byteLength;
    if (tamanho > TETO_DE_BYTES) throw new Error("corpo_acima_do_teto_da_fixture");
    partes.push(bytes);
  }
  try {
    return JSON.parse(Buffer.concat(partes).toString("utf8")) as unknown;
  } catch {
    // Não propagar o parser: sua mensagem pode citar parte do prompt recebido.
    throw new Error("corpo_json_invalido");
  }
}

function respostaAnthropic(model: string, fase: Fase) {
  return {
    id: `msg_${randomUUID()}`,
    type: "message",
    role: "assistant",
    model,
    content: fase === "send_message"
      ? [{ type: "tool_use", id: `toolu_${randomUUID()}`, name: "send_message", input: { body: RESPOSTA_DA_IA } }]
      : [{ type: "text", text: CHECKPOINT }],
    stop_reason: fase === "send_message" ? "tool_use" : "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 1 },
  };
}

function respostaOpenAI(model: string, fase: Fase) {
  return {
    id: `resp_${randomUUID()}`,
    object: "response",
    created_at: Math.floor(Date.now() / 1000),
    status: "completed",
    model,
    output: fase === "send_message"
      ? [{ type: "function_call", id: `fc_${randomUUID()}`, call_id: `call_${randomUUID()}`, name: "send_message", arguments: JSON.stringify({ body: RESPOSTA_DA_IA }) }]
      : [{ type: "message", id: `msg_${randomUUID()}`, role: "assistant", status: "completed", content: [{ type: "output_text", text: CHECKPOINT, annotations: [] }] }],
    usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
  };
}

/**
 * O motor e os dois SDKs executam de verdade; só o fornecedor HTTP é local e
 * determinístico. Isto mede serialização, leitura de tool call e fechamento,
 * sem afirmar cobertura de chave externa, inferência ou egress do registry
 * padrão de produção. Nenhum corpo ou cabeçalho é guardado nas observações.
 */
export async function criarProvedoresDoTurnoLaudos() {
  let rodada: Rodada | undefined;
  const falhasForaDeRodada: string[] = [];
  const server = createServer(async (req, res) => {
    res.setHeader("content-type", "application/json");
    try {
      if (!rodada) throw new Error("pedido_sem_rodada");
      rodada.requests += 1;
      if (rodada.requests > TETO_DE_CHAMADAS) throw new Error("chamadas_acima_do_teto");
      if (!rodada.esperaModelo) throw new Error("modelo_chamado_na_coleta_deterministica");
      if (req.method !== "POST") throw new Error("metodo_inesperado");
      const caminho = req.url ?? "";
      const esperado = rodada.provider === "anthropic"
        ? "/anthropic/v1/messages"
        : "/openai/v1/responses";
      if (caminho !== esperado) throw new Error("caminho_ou_provedor_inesperado");

      const bruto = await lerJson(req);
      const resultado = rodada.provider === "anthropic"
        ? pedidoAnthropic.safeParse(bruto)
        : pedidoOpenAI.safeParse(bruto);
      if (!resultado.success) throw new Error("contrato_do_sdk_inesperado");
      const pedido = resultado.data;
      if (pedido.model !== MODELOS_DO_TURNO[rodada.provider]) throw new Error("modelo_inesperado");

      const fechamento = JSON.stringify(bruto).includes(MARCADOR_DO_FECHAMENTO);
      const jaEnviou = rodada.observacoes.some((item) => item.fase === "send_message");
      let fase: Fase;
      if (fechamento) {
        if (!jaEnviou || rodada.observacoes.some((item) => item.fase === "checkpoint")) {
          throw new Error("fechamento_fora_de_ordem");
        }
        fase = "checkpoint";
      } else if (!jaEnviou) {
        if (!pedido.tools?.some((ferramenta) => ferramenta.name === "send_message")) {
          throw new Error("send_message_nao_oferecida");
        }
        fase = "send_message";
      } else {
        if (rodada.observacoes.some((item) => item.fase === "encerramento" || item.fase === "checkpoint")) {
          throw new Error("etapa_extra_inesperada");
        }
        fase = "encerramento";
      }
      rodada.observacoes.push({ provider: rodada.provider, path: caminho, model: pedido.model, fase });
      res.end(JSON.stringify(rodada.provider === "anthropic"
        ? respostaAnthropic(pedido.model, fase)
        : respostaOpenAI(pedido.model, fase)));
    } catch (err) {
      // Somente os códigos locais acima: nunca devolver corpo, auth ou stack.
      const codigo = err instanceof Error && /^[a-z_]+$/.test(err.message)
        ? err.message
        : "falha_interna_da_fixture";
      if (rodada) rodada.falhas.push(codigo);
      else falhasForaDeRodada.push(codigo);
      res.statusCode = 500;
      res.end(JSON.stringify({ error: { code: codigo, message: codigo } }));
    }
  });
  server.requestTimeout = 10_000;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const endereco = server.address();
  if (!endereco || typeof endereco === "string") {
    server.close();
    throw new Error("Receiver dos SDKs não informou a porta local.");
  }
  const origem = `http://127.0.0.1:${endereco.port}`;
  const fetchLocal: typeof fetch = async (input, init) => {
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    if (url.origin !== origem) throw new Error("egress_fora_do_receiver_local");
    return fetch(input, init);
  };
  const registry: ProviderRegistry = {
    anthropic: (apiKey, modelId) => createAnthropic({ apiKey, baseURL: `${origem}/anthropic/v1`, fetch: fetchLocal })(modelId),
    // Sem `.chat()`: a factory canônica instalada usa a Responses API.
    openai: (apiKey, modelId) => createOpenAI({ apiKey, baseURL: `${origem}/openai/v1`, fetch: fetchLocal })(modelId),
  };

  function assertHealthy() {
    const falhas = [...falhasForaDeRodada, ...(rodada?.falhas ?? [])];
    if (falhas.length > 0) throw new Error(`Receiver dos SDKs: ${falhas.join(", ")}.`);
    if (!rodada) throw new Error("Nenhuma rodada dos SDKs foi iniciada.");
    if (!rodada.esperaModelo && rodada.requests !== 0) {
      throw new Error("A coleta determinística chamou um modelo.");
    }
    if (rodada.esperaModelo && !rodada.observacoes.some((item) => item.fase === "checkpoint")) {
      throw new Error("O turno esperado da IA não chegou ao fechamento pelo SDK.");
    }
  }

  return {
    registry,
    beginTurn(provider: ProvedorDoTurnoLaudos, esperaModelo = true) {
      if (rodada) assertHealthy();
      rodada = { provider, esperaModelo, requests: 0, observacoes: [], falhas: [] };
    },
    snapshot() {
      if (!rodada) throw new Error("Nenhuma rodada dos SDKs foi iniciada.");
      return structuredClone(rodada);
    },
    assertHealthy,
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        server.close((err) => err ? reject(err) : resolve());
      });
    },
  };
}
