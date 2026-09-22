import { RTCPeerConnection } from "werift";
import WebSocket from "ws";
import { z } from "zod";
import type { VoiceUsage } from "./cost";
import { PcmQueue, PcmResampler } from "./pcm";

export const VOICE_MODEL = "gpt-realtime-2.1";
export type TranscriptLine = { role: "agent" | "user"; text: string };
export const callResult = z
  .object({
    summary: z.string().min(1).max(2000),
    next_step: z.string().min(1).max(1000),
    outcome: z.enum(["resolved", "pending", "declined"]),
  })
  .strict();
export type RealtimeUsage = VoiceUsage;

/** The provider is ready BEFORE exchange may dial. No browser microphone participates. */
export async function audioBridge(options: {
  apiKey: string;
  instructions: string;
  signal: AbortSignal;
  exchange: (sdp: string) => Promise<string>;
  onConversation: (id: string) => Promise<void>;
  onReady: () => Promise<void>;
  onUsage: (usage: RealtimeUsage) => void;
}) {
  const pc = new RTCPeerConnection({ iceServers: [] });
  const dc = pc.createDataChannel("pcm", { ordered: true });
  const queue = new PcmQueue();
  const input = new PcmResampler(16000, 24000);
  let output = new PcmResampler(24000, 16000);
  const transcript: TranscriptLine[] = [];
  let result: z.infer<typeof callResult> | null = null;
  let socket: WebSocket | undefined, timer: ReturnType<typeof setInterval> | undefined;
  let ready = false,
    closed = false,
    endRequested = false,
    speaking = false;
  let resolveEnd!: () => void, rejectEnd!: (e: Error) => void, resolveProvider!: () => void;
  const finished = new Promise<void>((resolve, reject) => {
    resolveEnd = resolve;
    rejectEnd = reject;
  });
  void finished.catch(() => {});
  const providerReady = new Promise<void>((resolve) => {
    resolveProvider = resolve;
  });
  const send = (value: unknown) => {
    if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(value));
  };
  const abort = () => resolveEnd();
  options.signal.addEventListener("abort", abort, { once: true });
  const setupTimeout = setTimeout(() => rejectEnd(new Error("voice_setup_timeout")), 60000);
  try {
    if (options.signal.aborted) return { transcript, result, error: null as string | null };
    socket = new WebSocket(`wss://api.openai.com/v1/realtime?model=${VOICE_MODEL}`, {
      headers: { Authorization: `Bearer ${options.apiKey}` },
      handshakeTimeout: 15000,
      maxPayload: 2_000_000,
    });
    socket.on("error", () => rejectEnd(new Error("voice_provider_connection_failed")));
    socket.on("close", () => {
      if (!closed) rejectEnd(new Error("voice_provider_disconnected"));
    });
    socket.on("message", (raw) => {
      try {
        const e = JSON.parse(raw.toString());
        if (e.type === "session.created") {
          if (typeof e.session?.id !== "string") throw new Error("invalid_session");
          void options
            .onConversation(e.session.id)
            .then(() =>
              send({
                type: "session.update",
                session: {
                  type: "realtime",
                  model: VOICE_MODEL,
                  output_modalities: ["audio"],
                  instructions:
                    options.instructions +
                    "\nFale em português brasileiro. Siga a abertura natural orientada acima: cumprimente, apresente-se brevemente e pergunte se pode falar um minutinho. Ao terminar, despeça-se em voz e só depois chame end_call com o resultado e próximo passo. Não chame end_call antes de o cliente falar.",
                  audio: {
                    input: {
                      format: { type: "audio/pcm", rate: 24000 },
                      transcription: { model: "gpt-4o-mini-transcribe", language: "pt" },
                      turn_detection: {
                        type: "server_vad",
                        silence_duration_ms: 700,
                        interrupt_response: true,
                        create_response: true,
                      },
                    },
                    output: { format: { type: "audio/pcm", rate: 24000 }, voice: "marin" },
                  },
                  tools: [
                    {
                      type: "function",
                      name: "end_call",
                      description:
                        "Encerra esta ligação depois da despedida e registra o resultado para a equipe.",
                      parameters: {
                        type: "object",
                        properties: {
                          summary: { type: "string" },
                          next_step: { type: "string" },
                          outcome: { type: "string", enum: ["resolved", "pending", "declined"] },
                        },
                        required: ["summary", "next_step", "outcome"],
                        additionalProperties: false,
                      },
                    },
                  ],
                  tool_choice: "auto",
                },
              }),
            )
            .catch(() => rejectEnd(new Error("voice_state_save_failed")));
        } else if (e.type === "session.updated") {
          resolveProvider();
        } else if (e.type === "error") {
          rejectEnd(new Error("voice_provider_rejected_event"));
        } else if (e.type === "response.output_audio.delta") {
          if (typeof e.delta !== "string" || typeof e.item_id !== "string")
            throw new Error("invalid_audio");
          queue.push(output.push(Buffer.from(e.delta, "base64")), e.item_id, e.content_index ?? 0);
        } else if (e.type === "input_audio_buffer.speech_started") {
          speaking = true;
          endRequested = false;
          result = null;
          for (const item of queue.clear()) send({ type: "conversation.item.truncate", ...item });
          output = new PcmResampler(24000, 16000);
        } else if (e.type === "input_audio_buffer.speech_stopped") {
          speaking = false;
        } else if (
          e.type === "conversation.item.input_audio_transcription.completed" ||
          e.type === "response.output_audio_transcript.done"
        ) {
          if (e.type.startsWith("conversation.") && e.usage)
            options.onUsage({ id: e.item_id, kind: "transcription", usage: e.usage });
          if (typeof e.transcript === "string" && transcript.length < 500)
            transcript.push({
              role: e.type.startsWith("conversation.") ? "user" : "agent",
              text: e.transcript.slice(0, 5000),
            });
        } else if (e.type === "response.done") {
          if (e.response?.usage)
            options.onUsage({ id: e.response.id, kind: "realtime", usage: e.response.usage });
          if (e.response?.status === "failed") throw new Error("voice_response_failed");
          for (const item of e.response?.output ?? [])
            if (item.type === "function_call" && item.name === "end_call") {
              const parsed = callResult.safeParse(JSON.parse(item.arguments));
              if (!parsed.success || !transcript.some((t) => t.role === "user") || speaking) {
                send({
                  type: "conversation.item.create",
                  item: {
                    type: "function_call_output",
                    call_id: item.call_id,
                    output: JSON.stringify({
                      error: "Continue a conversa e escute o contato antes de encerrar.",
                    }),
                  },
                });
                send({ type: "response.create" });
                continue;
              }
              result = parsed.data;
              endRequested = true;
            }
        }
      } catch {
        rejectEnd(new Error("voice_stream_failed"));
      }
    });
    await Promise.race([
      providerReady,
      finished.then(() => {
        throw new Error("voice_cancelled");
      }),
    ]);
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    const answer = await options.exchange(pc.localDescription!.sdp);
    if (options.signal.aborted) return { transcript, result, error: null as string | null };
    const media = new Promise<void>((resolve) =>
      dc.stateChange.subscribe((state) => {
        if (state === "open") resolve();
        else if (state === "closed") rejectEnd(new Error("voice_audio_closed"));
      }),
    );
    await pc.setRemoteDescription({ type: "answer", sdp: answer });
    if (dc.readyState !== "open")
      await Promise.race([
        media,
        finished.then(() => {
          throw new Error("voice_cancelled");
        }),
      ]);
    await options.onReady();
    if (options.signal.aborted) return { transcript, result, error: null as string | null };
    ready = true;
    clearTimeout(setupTimeout);
    dc.onMessage.subscribe((data) => {
      if (!ready || !Buffer.isBuffer(data) || socket?.readyState !== WebSocket.OPEN) return;
      if (socket.bufferedAmount > 128000) {
        rejectEnd(new Error("voice_upload_stalled"));
        return;
      }
      try {
        send({ type: "input_audio_buffer.append", audio: input.push(data).toString("base64") });
      } catch {
        rejectEnd(new Error("invalid_input_audio"));
      }
    });
    send({ type: "response.create" });
    let drainedAt = 0;
    timer = setInterval(() => {
      try {
        if (dc.readyState !== "open") return;
        if (dc.bufferedAmount > 64000) throw new Error("voice_playback_stalled");
        const frame = queue.next();
        if (frame) dc.send(frame);
        if (endRequested && !speaking && queue.empty && dc.bufferedAmount === 0) {
          if (!drainedAt) drainedAt = Date.now();
          if (Date.now() - drainedAt > 500) resolveEnd();
        } else drainedAt = 0;
      } catch {
        rejectEnd(new Error("voice_playback_failed"));
      }
    }, 20);
    await finished;
    return { transcript, result, error: null as string | null };
  } catch (error) {
    return { transcript, result, error: error instanceof Error ? error.message : "voice_failed" };
  } finally {
    closed = true;
    ready = false;
    clearTimeout(setupTimeout);
    if (timer) clearInterval(timer);
    options.signal.removeEventListener("abort", abort);
    queue.clear();
    socket?.terminate();
    await pc.close();
  }
}
