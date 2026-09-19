/**
 * workers/voice-agent/audioSocketBridge.ts
 *
 * Ponte de áudio via Asterisk AudioSocket (TCP), não RTP/externalMedia.
 *
 * Por quê: testado ao vivo (madrugada de 28/08) — um único OU dois canais
 * externalMedia numa bridge ARI "mixing" recebem nosso áudio de volta
 * corretamente (confirmado por captura: payload real chega no Asterisk),
 * mas o Asterisk NUNCA relay isso pra ponta PJSIP — só manda silêncio
 * (0xff cru) pro trunk, em todas as variações tentadas (1 canal, 2 canais,
 * canais com portas únicas, marker bit RTP). É limitação conhecida do
 * chan_rtp/externalMedia + bridge de mixing do Asterisk pra esse padrão de
 * uso, não bug nosso — confirmado por pesquisa na comunidade Asterisk.
 *
 * AudioSocket evita o problema por completo: o Asterisk CONECTA em nós via
 * TCP simples (AudioSocket() no dialplan, não ARI/Stasis) e o áudio flui
 * DIRETO no path do canal, sem bridge-mixing nenhum no meio. Formato é
 * SLIN16 (PCM 16-bit, 8kHz) — convertido daqui pra μ-law e vice-versa
 * (lib/voip/ulaw.ts), porque a sessão OpenAI já está provada funcionando
 * com audio/pcmu.
 *
 * Framing (protocolo AudioSocket): 1 byte tipo + 2 bytes tamanho (BE) +
 * payload.
 *   0x01 UUID     — primeira mensagem, 16 bytes binários
 *   0x10 ÁUDIO     — PCM16 8kHz mono, tipicamente 320 bytes (20ms)
 *   0x00 HANGUP    — Asterisk avisando que a chamada terminou
 */

import WebSocket from "ws";
import type { Socket } from "node:net";
import { pcm16ToUlaw, ulawToPcm16 } from "@/lib/voip/ulaw";

// Fallback só pra quem ainda não configurou nada na aba Voz do agente
// (config.voice_model) -- normalmente this.ctx.voiceModel já vem preenchido
// pelo worker, que lê do agente antes de instanciar esta classe.
// `??` NÃO serve aqui: o `.env.example` entrega `OPENAI_REALTIME_MODEL=` VAZIA,
// e quem copia o exemplo receberia a string vazia no lugar do padrão — o nome
// do modelo iria vazio para a API. Vazio (ou só espaço) conta como ausente,
// mesma regra de `graphVersion()` em lib/graph-version.ts.
const REALTIME_MODEL_FALLBACK = process.env.OPENAI_REALTIME_MODEL?.trim() || "gpt-realtime";

const FRAME_TYPE = { HANGUP: 0x00, UUID: 0x01, DTMF: 0x03, AUDIO: 0x10 } as const;

/**
 * Sem isto a ligação só termina quando o CLIENTE desliga — a IA nunca
 * desliga sozinha, mesmo tendo se despedido (ouvido ao vivo: a chamada
 * ficava pendurada em silêncio até o cliente encerrar do lado dele). O
 * modelo chama esta function DEPOIS de dizer a despedida; o áudio da
 * resposta ainda é tocado até o fim — só então a ligação é encerrada (ver
 * `pumpOutboundQueue`, que drena a fila pendente antes de fechar o socket).
 */
const ENCERRAR_CHAMADA_TOOL_NAME = "encerrar_chamada";
const CONSULTAR_CONHECIMENTO_TOOL_NAME = "consultar_conhecimento";

const INSTRUCAO_ENCERRAR_CHAMADA = `

Quando a conversa chegar a uma conclusão natural (o cliente se despediu, o
assunto foi resolvido, ou não há mais nada a tratar), diga a despedida em
voz e, na mesma resposta, chame a function "${ENCERRAR_CHAMADA_TOOL_NAME}"
para desligar a ligação. Não chame antes de terminar de falar a despedida.

Quando o cliente perguntar algo específico da empresa (preço, política,
horário, procedimento, catálogo) que você não tem certeza, chame a function
"${CONSULTAR_CONHECIMENTO_TOOL_NAME}" com a pergunta antes de responder — não
invente. Se a busca não achar nada, diga que vai verificar e retornar, não
afirme um fato sem fonte.`;

export interface AudioSocketCallContext {
  callId: string;
  organizationId: string;
  agentInstructions: string;
  /** Voz da Realtime API (marin, cedar, alloy, ...) -- configuravel por
   *  agente em Configuracoes > Agente > aba Voz. */
  voice: string;
  /** 0.25-1.5, 1.0 = padrao do modelo. */
  voiceSpeed: number;
  /** Modelo Realtime (gpt-realtime, gpt-realtime-2.1, ...) -- ver guardrails-schema.ts. */
  voiceModel?: string;
  /** Chave da OpenAI pra esta org -- ver resolverChaveOpenAiDaVoz em lib/ai/agents.ts. */
  apiKey?: string;
  onTranscriptTurn: (turn: { speaker: "agent" | "customer"; text: string }) => void;
  onCallEnded: () => void;
  /**
   * Resolvida em PARALELO com a abertura deste WebSocket (index.ts dispara
   * os dois ao mesmo tempo, não aguarda uma coisa antes da outra) — o
   * session.update só é enviado depois que isto resolve, pra saber se
   * oferece a tool de RAG ao modelo. Antes disto rodava em série (aguardado
   * em index.ts antes até de abrir o WS), e a soma dos dois round-trips era
   * demora real sentida antes da primeira interação.
   */
  knowledgeSourceIdsPromise: Promise<string[]>;
  /**
   * Busca na base de conhecimento da org (mesmo acervo do agente de texto).
   * Sempre fornecida — quem decide OFERECER a tool ao modelo ou não é o
   * tools[] montado em setupRealtime a partir de knowledgeSourceIdsPromise,
   * não a presença desta função.
   */
  searchKnowledge: (pergunta: string) => Promise<{
    trechos: Array<{ content: string; source_name?: string | null }>;
  }>;
}

/** Monta um frame AudioSocket (tipo + tamanho BE + payload). */
function buildFrame(type: number, payload: Buffer): Buffer {
  const header = Buffer.alloc(3);
  header[0] = type;
  header.writeUInt16BE(payload.length, 1);
  return Buffer.concat([header, payload]);
}

const FRAME_MS = 20;
const FRAME_BYTES = 320; // 20ms @ 8kHz, PCM16 mono

export class AudioSocketCallBridge {
  private realtimeWs: WebSocket;
  private recvBuffer = Buffer.alloc(0);
  private isTalkspurtStart = true;
  private closed = false;
  /** setado quando o modelo chama a function de encerrar — a fila de
   *  áudio pendente ainda drena normalmente antes do hangup de fato. */
  private endCallRequested = false;
  /** call_id -> nome da function, preenchido em response.output_item.added
   *  (onde o nome chega) e consumido em response.function_call_arguments.done
   *  (onde os argumentos chegam completos, mas sem o nome de novo). */
  private pendingFunctionCalls = new Map<string, string>();

  /**
   * false até o session.update ser enviado com sucesso (ver setupRealtime,
   * evento "open"). Áudio do cliente que chega ANTES disso (handshake TLS +
   * round-trip de knowledgeSourceIdsPromise) ia direto pro método antigo, que
   * só mandava pra OpenAI se `readyState === OPEN` — e descartava em
   * silêncio o resto. Reportado ao vivo como "demora na primeira interação":
   * quem falava assim que a ligação atendia tinha a fala inicial jogada
   * fora. Agora esse áudio fica em `preOpenAudioBuffer` e é drenado assim
   * que a sessão fica pronta.
   */
  private realtimeReady = false;
  private preOpenAudioBuffer: Buffer[] = [];

  // Fila de PCM16 pendente pra mandar pro Asterisk + um pacer que dreia um
  // frame de 320 bytes a cada 20ms — SEM isto, "response.output_audio.delta"
  // chega em rajadas (a OpenAI gera mais rápido que tempo real) e escrever
  // tudo de uma vez no TCP faz o Asterisk tocar mais rápido que o normal.
  // Ouvido ao vivo: "conversa acelerada e picada". RTP não tem esse problema
  // porque carrega timestamp — jitter buffer do outro lado reconstrói o
  // tempo certo sozinho; AudioSocket é só bytes crus, o pacing é nosso.
  private outboundQueue = Buffer.alloc(0);
  private pacerTimer: NodeJS.Timeout | null = null;

  private readonly realtimeModel: string;

  constructor(
    private socket: Socket,
    private ctx: AudioSocketCallContext,
  ) {
    this.realtimeModel = ctx.voiceModel ?? REALTIME_MODEL_FALLBACK;
    const apiKey = ctx.apiKey || process.env.OPENAI_API_KEY!;
    const realtimeUrl = `wss://api.openai.com/v1/realtime?model=${this.realtimeModel}`;
    this.realtimeWs = new WebSocket(realtimeUrl, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });

    // Sem isto o algoritmo de Nagle empaca nossos writes pequenos e
    // frequentes (frames de 323 bytes a cada 20ms) esperando encher um
    // buffer maior antes de mandar — ouvido ao vivo como áudio picado
    // mesmo com os frames certos chegando no Asterisk.
    this.socket.setNoDelay(true);

    this.setupSocket();
    this.setupRealtime();

    this.pacerTimer = setInterval(() => this.pumpOutboundQueue(), FRAME_MS);
  }

  /** Roda a cada 20ms — manda NO MÁXIMO um frame por tick, nunca a fila inteira de uma vez. */
  private pumpOutboundQueue() {
    if (this.socket.destroyed) return;

    if (this.outboundQueue.length >= FRAME_BYTES) {
      const frame = this.outboundQueue.subarray(0, FRAME_BYTES);
      this.outboundQueue = this.outboundQueue.subarray(FRAME_BYTES);
      this.socket.write(buildFrame(FRAME_TYPE.AUDIO, frame));
      this.isTalkspurtStart = false;
      return;
    }

    // Sem áudio cheio de 320 bytes pendente: só encerra se o modelo já
    // pediu (endCallRequested) — a despedida some do meio da frase se a
    // gente fechar sem antes drenar o restinho que sobrou (< 1 frame).
    if (!this.endCallRequested) return;
    if (this.outboundQueue.length > 0) {
      this.socket.write(buildFrame(FRAME_TYPE.AUDIO, this.outboundQueue));
      this.outboundQueue = Buffer.alloc(0);
      return; // mais um tick de 20ms pro Asterisk tocar isto antes do hangup
    }
    this.handleEnd("ia encerrou a chamada");
  }

  private setupSocket() {
    this.socket.on("data", (chunk) => {
      this.recvBuffer = Buffer.concat([this.recvBuffer, chunk]);
      this.drainFrames();
    });
    this.socket.on("close", () => this.handleEnd("socket fechado"));
    this.socket.on("error", (err) => console.error(`[audiosocket] call=${this.ctx.callId} erro no socket:`, err.message));
  }

  /** Consome quantos frames completos já estiverem no buffer acumulado. */
  private drainFrames() {
    while (this.recvBuffer.length >= 3) {
      const type = this.recvBuffer[0];
      const len = this.recvBuffer.readUInt16BE(1);
      if (this.recvBuffer.length < 3 + len) return; // frame incompleto, espera mais dados

      const payload = this.recvBuffer.subarray(3, 3 + len);
      this.recvBuffer = this.recvBuffer.subarray(3 + len);

      if (type === FRAME_TYPE.AUDIO) {
        this.sendAudioToRealtime(pcm16ToUlaw(payload));
      } else if (type === FRAME_TYPE.HANGUP) {
        this.handleEnd("hangup frame");
      }
      // UUID (0x01) já foi consumido por quem aceitou a conexão, antes de
      // instanciar esta classe — DTMF (0x03) ignorado, sem uso ainda.
    }
  }

  private handleEnd(reason: string) {
    if (this.closed) return;
    this.closed = true;
    console.info(`[audiosocket] call=${this.ctx.callId} encerrando (${reason})`);
    this.ctx.onCallEnded();
    this.close();
  }

  private setupRealtime() {
    this.realtimeWs.on("open", async () => {
      // Roda em paralelo com o handshake deste WS (index.ts dispara os dois
      // ao mesmo tempo) — só espera aqui, no momento em que já precisamos
      // saber se oferece a tool de RAG ou não.
      const knowledgeSourceIds = await this.ctx.knowledgeSourceIdsPromise;

      console.info(`[realtime] call=${this.ctx.callId} websocket aberto, enviando session.update`);
      this.realtimeWs.send(
        JSON.stringify({
          type: "session.update",
          session: {
            type: "realtime",
            model: this.realtimeModel,
            output_modalities: ["audio"],
            instructions: this.ctx.agentInstructions + INSTRUCAO_ENCERRAR_CHAMADA,
            audio: {
              input: {
                format: { type: "audio/pcmu" },
                // server_vad com threshold alto ainda disparava com ruído de
                // linha/eco de viva-voz -- ele julga só volume, sem saber se o
                // som é fala de verdade. semantic_vad usa um classificador que
                // avalia o CONTEÚDO (é fala? faz sentido como turno
                // terminado?), não só amplitude -- muito mais resistente a
                // ruído/eco. eagerness "low": espera mais confiança antes de
                // considerar que a pessoa terminou de falar, custa alguma
                // latência mas evita a IA emendar resposta em cima de nada.
                turn_detection: { type: "semantic_vad", eagerness: "low" },
                // Sem `language`, o Whisper detecta automaticamente a cada
                // trecho -- e erra de vez em quando (ruído de linha, palavra
                // ambígua), transcrevendo em outro idioma no meio da
                // ligação. Forçar "pt" corta a detecção errada de vez.
                transcription: { model: "whisper-1", language: "pt" },
              },
              output: {
                format: { type: "audio/pcmu" },
                // Configuráveis por agente (Configurações > Agente > aba
                // Voz) -- default "marin"/0.85, ver AGENT_CONFIG_DEFAULTS.
                voice: this.ctx.voice,
                speed: this.ctx.voiceSpeed,
              },
            },
            tools: [
              {
                type: "function",
                name: ENCERRAR_CHAMADA_TOOL_NAME,
                description:
                  "Encerra a ligação. Use depois de dizer a despedida final ao cliente, quando a conversa chegou a uma conclusão natural.",
                parameters: { type: "object", properties: {}, required: [] },
              },
              ...(knowledgeSourceIds.length > 0
                ? [
                    {
                      type: "function" as const,
                      name: CONSULTAR_CONHECIMENTO_TOOL_NAME,
                      description:
                        "Busca na base de conhecimento da empresa (documentos, FAQ, políticas, catálogo) por uma pergunta específica do cliente. Use antes de responder algo que dependa de informação da empresa que você não tem certeza.",
                      parameters: {
                        type: "object",
                        properties: {
                          pergunta: {
                            type: "string",
                            description: "A pergunta ou tópico a buscar na base de conhecimento.",
                          },
                        },
                        required: ["pergunta"],
                      },
                    },
                  ]
                : []),
            ],
            tool_choice: "auto",
          },
        }),
      );

      // Sessão configurada — agora sim dá pra mandar áudio pra API. Drena o
      // que ficou acumulado em preOpenAudioBuffer enquanto o WS ainda abria
      // (ver comentário do campo).
      this.realtimeReady = true;
      for (const chunk of this.preOpenAudioBuffer) {
        this.realtimeWs.send(JSON.stringify({ type: "input_audio_buffer.append", audio: chunk.toString("base64") }));
      }
      this.preOpenAudioBuffer = [];
    });

    this.realtimeWs.on("message", (raw) => {
      const event = JSON.parse(raw.toString());

      if (event.type !== "response.output_audio.delta") {
        console.info(`[realtime] call=${this.ctx.callId} evento: ${event.type}`);
      }

      switch (event.type) {
        case "response.created":
          this.isTalkspurtStart = true;
          break;
        case "response.output_audio.delta":
          this.sendAudioToAsterisk(Buffer.from(event.delta, "base64"));
          break;
        case "response.output_audio_transcript.done": {
          // Visto ao vivo em 17/09: o modelo às vezes NARRA a function em vez
          // de chamá-la de verdade -- duas variações JÁ vistas na mesma
          // sessão de testes: "...Até mais! \n\n(functions.encerrar_chamada)"
          // e "...\n\n{chamar função: encerrar_chamada}" -- sem nenhum
          // response.function_call_arguments.done correspondente em nenhuma
          // das duas. Não é um formato fixo (parênteses/chaves, inglês/
          // português variam), então a detecção é só pelo NOME da tool
          // aparecer no texto -- um identificador técnico que não ocorre em
          // fala natural -- em vez de casar uma sintaxe específica. Sem isto
          // a ligação nunca desliga sozinha nesses casos: response.done
          // (abaixo) só vê function_call de verdade quando o mecanismo
          // estruturado da Realtime API é usado, que aqui não aconteceu.
          const narracaoDeEncerrar = new RegExp(ENCERRAR_CHAMADA_TOOL_NAME, "i").test(event.transcript);
          if (narracaoDeEncerrar) {
            console.info(`[realtime] call=${this.ctx.callId} modelo narrou a function de encerrar em texto (fallback ativado)`);
            this.endCallRequested = true;
          }
          // A limpeza tira qualquer trecho entre parênteses/chaves que
          // mencione a tool, mais a forma solta sem wrapper nenhum -- não dá
          // pra saber de antemão qual sintaxe o modelo vai improvisar.
          const transcriptLimpo = event.transcript
            .replace(new RegExp(`[\\(\\{][^)}]*${ENCERRAR_CHAMADA_TOOL_NAME}[^)}]*[\\)\\}]`, "gi"), "")
            .replace(new RegExp(`functions?\\.${ENCERRAR_CHAMADA_TOOL_NAME}`, "gi"), "")
            .trim();
          this.ctx.onTranscriptTurn({ speaker: "agent", text: transcriptLimpo });
          break;
        }
        case "conversation.item.input_audio_transcription.completed":
          this.ctx.onTranscriptTurn({ speaker: "customer", text: event.transcript });
          break;
        case "response.output_item.added": {
          const item = event.item as { type?: string; call_id?: string; name?: string } | undefined;
          if (item?.type === "function_call" && item.call_id && item.name) {
            this.pendingFunctionCalls.set(item.call_id, item.name);
          }
          break;
        }
        case "response.function_call_arguments.done": {
          const nome = this.pendingFunctionCalls.get(event.call_id);
          this.pendingFunctionCalls.delete(event.call_id);
          if (nome === CONSULTAR_CONHECIMENTO_TOOL_NAME) {
            void this.handleKnowledgeQuery(event.call_id, event.arguments);
          }
          break;
        }
        case "response.done": {
          const output = (event.response?.output ?? []) as Array<{ type?: string; name?: string }>;
          const pediuEncerrar = output.some(
            (item) => item.type === "function_call" && item.name === ENCERRAR_CHAMADA_TOOL_NAME,
          );
          if (pediuEncerrar) {
            console.info(`[realtime] call=${this.ctx.callId} agente pediu pra encerrar a chamada`);
            this.endCallRequested = true;
          }
          break;
        }
        case "error":
          console.error(`[realtime] call=${this.ctx.callId} erro:`, JSON.stringify(event.error));
          break;
      }
    });

    this.realtimeWs.on("unexpected-response", (_req, res) => {
      let body = "";
      res.on("data", (chunk) => (body += chunk));
      res.on("end", () =>
        console.error(`[realtime] call=${this.ctx.callId} handshake rejeitado, HTTP ${res.statusCode}: ${body}`),
      );
    });

    this.realtimeWs.on("close", (code, reason) => {
      console.info(`[realtime] call=${this.ctx.callId} ws fechado, code=${code} reason=${reason}`);
      this.handleEnd("openai ws fechado");
    });
  }

  private sendAudioToRealtime(ulawChunk: Buffer) {
    if (!this.realtimeReady) {
      this.preOpenAudioBuffer.push(ulawChunk);
      return;
    }
    if (this.realtimeWs.readyState !== WebSocket.OPEN) return;
    this.realtimeWs.send(
      JSON.stringify({ type: "input_audio_buffer.append", audio: ulawChunk.toString("base64") }),
    );
  }

  /**
   * Roda a busca, devolve o resultado como function_call_output e pede uma
   * NOVA resposta (response.create) pro modelo continuar falando com a
   * informação em mãos — sem isto o turno fica parado esperando algo que
   * nunca chega, porque o resultado da function sozinho não dispara resposta.
   */
  private async handleKnowledgeQuery(callId: string, argsJson: string) {
    let pergunta = "";
    try {
      pergunta = (JSON.parse(argsJson) as { pergunta?: string }).pergunta ?? "";
    } catch {
      // argumentos malformados -- segue com pergunta vazia, cai no "nada encontrado" abaixo
    }

    let output: string;
    try {
      const resultado = pergunta.trim() === "" ? { trechos: [] } : await this.ctx.searchKnowledge(pergunta);
      output =
        resultado.trechos.length > 0
          ? resultado.trechos.map((t) => `[${t.source_name ?? "material"}] ${t.content}`).join("\n\n")
          : "Nada encontrado na base de conhecimento para esta pergunta -- responda com o que você já sabe e não invente fatos.";
    } catch (err) {
      console.error(
        `[realtime] call=${this.ctx.callId} busca de conhecimento falhou:`,
        err instanceof Error ? err.message : err,
      );
      output = "A base de conhecimento está indisponível agora -- responda com o que você já sabe e não invente fatos.";
    }

    if (this.realtimeWs.readyState !== WebSocket.OPEN) return;
    this.realtimeWs.send(
      JSON.stringify({
        type: "conversation.item.create",
        item: { type: "function_call_output", call_id: callId, output },
      }),
    );
    this.realtimeWs.send(JSON.stringify({ type: "response.create" }));
  }

  private outboundFramesLogged = false;

  /** NÃO escreve direto — só enfileira. Quem escreve é o pacer (pumpOutboundQueue), um frame por tick de 20ms. */
  private sendAudioToAsterisk(ulawChunk: Buffer) {
    if (!this.outboundFramesLogged) {
      this.outboundFramesLogged = true;
      console.info(`[audiosocket] call=${this.ctx.callId} primeiro trecho de resposta enfileirado (pacing a 20ms/frame)`);
    }
    this.outboundQueue = Buffer.concat([this.outboundQueue, ulawToPcm16(ulawChunk)]);
  }

  close() {
    if (this.pacerTimer) clearInterval(this.pacerTimer);
    this.realtimeWs.close();
    if (!this.socket.destroyed) this.socket.end();
  }
}
