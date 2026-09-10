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

const OPENAI_API_KEY = process.env.OPENAI_API_KEY!;
const REALTIME_MODEL = process.env.OPENAI_REALTIME_MODEL ?? "gpt-realtime";
const REALTIME_URL = `wss://api.openai.com/v1/realtime?model=${REALTIME_MODEL}`;

const FRAME_TYPE = { HANGUP: 0x00, UUID: 0x01, DTMF: 0x03, AUDIO: 0x10 } as const;

export interface AudioSocketCallContext {
  callId: string;
  organizationId: string;
  agentInstructions: string;
  onTranscriptTurn: (turn: { speaker: "agent" | "customer"; text: string }) => void;
  onCallEnded: () => void;
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

  // Fila de PCM16 pendente pra mandar pro Asterisk + um pacer que dreia um
  // frame de 320 bytes a cada 20ms — SEM isto, "response.output_audio.delta"
  // chega em rajadas (a OpenAI gera mais rápido que tempo real) e escrever
  // tudo de uma vez no TCP faz o Asterisk tocar mais rápido que o normal.
  // Ouvido ao vivo: "conversa acelerada e picada". RTP não tem esse problema
  // porque carrega timestamp — jitter buffer do outro lado reconstrói o
  // tempo certo sozinho; AudioSocket é só bytes crus, o pacing é nosso.
  private outboundQueue = Buffer.alloc(0);
  private pacerTimer: NodeJS.Timeout | null = null;

  constructor(
    private socket: Socket,
    private ctx: AudioSocketCallContext,
  ) {
    this.realtimeWs = new WebSocket(REALTIME_URL, {
      headers: { Authorization: `Bearer ${OPENAI_API_KEY}` },
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
    if (this.outboundQueue.length < FRAME_BYTES) return;
    if (this.socket.destroyed) return;

    const frame = this.outboundQueue.subarray(0, FRAME_BYTES);
    this.outboundQueue = this.outboundQueue.subarray(FRAME_BYTES);
    this.socket.write(buildFrame(FRAME_TYPE.AUDIO, frame));
    this.isTalkspurtStart = false;
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
    this.realtimeWs.on("open", () => {
      console.info(`[realtime] call=${this.ctx.callId} websocket aberto, enviando session.update`);
      this.realtimeWs.send(
        JSON.stringify({
          type: "session.update",
          session: {
            type: "realtime",
            model: REALTIME_MODEL,
            output_modalities: ["audio"],
            instructions: this.ctx.agentInstructions,
            audio: {
              input: {
                format: { type: "audio/pcmu" },
                turn_detection: { type: "server_vad" },
                transcription: { model: "whisper-1" },
              },
              output: {
                format: { type: "audio/pcmu" },
                voice: "marin",
              },
            },
          },
        }),
      );
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
        case "response.output_audio_transcript.done":
          this.ctx.onTranscriptTurn({ speaker: "agent", text: event.transcript });
          break;
        case "conversation.item.input_audio_transcription.completed":
          this.ctx.onTranscriptTurn({ speaker: "customer", text: event.transcript });
          break;
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
    if (this.realtimeWs.readyState !== WebSocket.OPEN) return;
    this.realtimeWs.send(
      JSON.stringify({ type: "input_audio_buffer.append", audio: ulawChunk.toString("base64") }),
    );
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
