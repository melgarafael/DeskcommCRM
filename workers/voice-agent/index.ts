/**
 * workers/voice-agent/index.ts
 *
 * Processo persistente (mesmo padrão dos outros workers/ — roda no
 * Dockerfile.voice-agent via tsx, um processo, sem HTTP exposto pra fora).
 *
 * TODA mídia (entrada e saída) vai por AudioSocket (TCP puro,
 * audioSocketBridge.ts), não por RTP/externalMedia/bridge ARI. Motivo:
 * testado ao vivo (28/08) que bridge de mixing do Asterisk nunca relay
 * áudio injetado por um canal externalMedia de volta pro outro membro — só
 * silêncio. Limitação conhecida do chan_rtp/externalMedia pra esse padrão
 * de uso, não bug nosso.
 *
 * Dois fluxos:
 *  - SAÍDA (POST /api/v1/calls): originateCall já entrega direto pro
 *    dialplan [voice-agent-out] (context/extension no create, não app) —
 *    esse canal NUNCA passa pela Stasis app deste worker.
 *  - ENTRADA (from-trunk): entra na Stasis só de PASSAGEM — o suficiente
 *    pra resolver org/agente pelo número discado e criar a linha em
 *    crm_calls — e devolve o controle pro dialplan (continueDialplan) rumo
 *    ao [from-trunk-audiosocket], que chama AudioSocket() igual à saída.
 *
 * Os dois fluxos convergem no mesmo lugar: startAudioSocketServer() aceita
 * a conexão TCP, lê o frame de UUID, acha a linha em crm_calls por
 * asterisk_channel_id (== o UUID, de propósito) e sobe UMA
 * AudioSocketCallBridge — não importa se a chamada é de entrada ou saída.
 *
 * Sem publicação em event_log (call.ended etc.): nenhum handler em
 * lib/event-log/register-handlers.ts consumiria esses tipos ainda — ver nota
 * na migration 0232. Sumarização/sentimento pós-chamada fica fora do escopo
 * deste esqueleto até existir consumidor real.
 */

import net from "node:net";
import {
  connectAriEvents,
  hangupChannel,
  setChannelVariable,
  continueDialplan,
  type AriEvent,
} from "@/lib/voip/ariClient";
import { AudioSocketCallBridge } from "./audioSocketBridge";
import { createAdminClient } from "@/lib/supabase/admin";
import { getActiveVoiceAgent } from "@/lib/ai/agents";

const supabaseAdmin = createAdminClient();

const AUDIOSOCKET_PORT = parseInt(process.env.AUDIOSOCKET_PORT ?? "9092", 10);

// ---------- Stasis (só ENTRADA, só de passagem) ----------

async function handleStasisStart(event: AriEvent) {
  const channel = event.channel;
  if (!channel) return;

  // chamada de entrada: resolve o tenant pelo número discado (phone_numbers)
  const dialedNumber = channel.dialplan?.exten ?? "unknown";
  const routing = await resolveInboundNumber(dialedNumber);
  if (!routing) {
    console.error(`[voice-agent] número ${dialedNumber} não mapeado em phone_numbers`);
    await hangupChannel(channel.id, "normal");
    return;
  }

  const { data: callRow, error } = await supabaseAdmin
    .from("crm_calls")
    .insert({
      organization_id: routing.organization_id,
      direction: "inbound",
      status: "ringing",
      from_number: channel.caller?.number ?? "unknown",
      to_number: dialedNumber,
      asterisk_channel_id: channel.id,
      started_at: new Date().toISOString(),
    })
    .select()
    .single();

  if (error || !callRow) {
    console.error(`[voice-agent] falha ao criar crm_calls pra chamada de entrada:`, error?.message);
    await hangupChannel(channel.id, "normal");
    return;
  }

  // channel.id JÁ é o asterisk_channel_id gravado acima — reusa como UUID do
  // AudioSocket (mesmo padrão da saída), pra handleAudioSocketConnection
  // achar a linha certa assim que a conexão TCP chegar.
  await setChannelVariable(channel.id, "AUDIOSOCKET_UUID", channel.id);
  await continueDialplan(channel.id, "from-trunk-audiosocket", "s", 1);
}

async function resolveInboundNumber(dialedNumber: string) {
  const { data, error } = await supabaseAdmin
    .rpc("fn_resolve_inbound_number", { p_number: dialedNumber })
    .single();
  if (error || !data) return null;
  return data as {
    organization_id: string;
    routing_mode: "ai" | "human" | "ai_then_human";
    default_ai_agent_id: string | null;
    fallback_user_id: string | null;
  };
}

// ---------- AudioSocket (entrada E saída convergem aqui) ----------

interface ActiveAudioSocketCall {
  bridge: AudioSocketCallBridge;
  callRowId: string;
  transcript: { speaker: string; text: string; ts: string }[];
}
const activeAudioSocketCalls = new Map<string, ActiveAudioSocketCall>(); // key = uuid (== crm_calls.asterisk_channel_id)

function bytesToUuid(buf: Buffer): string {
  const hex = buf.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

function appendAudioSocketTranscriptTurn(uuid: string, turn: { speaker: string; text: string }) {
  const call = activeAudioSocketCalls.get(uuid);
  if (!call) return;
  call.transcript.push({ ...turn, ts: new Date().toISOString() });
}

async function finalizeAudioSocketCall(uuid: string) {
  const call = activeAudioSocketCalls.get(uuid);
  if (!call) return;
  activeAudioSocketCalls.delete(uuid);

  await supabaseAdmin
    .from("crm_calls")
    .update({ status: "completed", ended_at: new Date().toISOString(), transcript: call.transcript })
    .eq("id", call.callRowId);
}

async function handleAudioSocketConnection(socket: net.Socket, uuid: string, leftover: Buffer) {
  const { data: callRow, error } = await supabaseAdmin
    .from("crm_calls")
    .select("*")
    .eq("asterisk_channel_id", uuid)
    .single();

  if (error || !callRow) {
    console.error(`[audiosocket] uuid ${uuid} não corresponde a nenhuma crm_calls — encerrando`);
    socket.end();
    return;
  }

  const agent = await getActiveVoiceAgent(callRow.organization_id);
  if (!agent) {
    console.error(`[audiosocket] nenhum agente de voz ativo pra org ${callRow.organization_id}`);
    socket.end();
    return;
  }

  const bridge = new AudioSocketCallBridge(socket, {
    callId: callRow.id,
    organizationId: callRow.organization_id,
    agentInstructions: agent.systemPrompt,
    onTranscriptTurn: (turn) => appendAudioSocketTranscriptTurn(uuid, turn),
    onCallEnded: () => finalizeAudioSocketCall(uuid),
  });

  activeAudioSocketCalls.set(uuid, { bridge, callRowId: callRow.id, transcript: [] });

  await supabaseAdmin
    .from("crm_calls")
    .update({ status: "in_progress", answered_at: new Date().toISOString(), handled_by: "ai" })
    .eq("id", callRow.id);

  // Se algum byte de áudio já chegou GRUDADO no mesmo pacote TCP do frame de
  // UUID (TCP é stream contínuo, não datagramas), reinjeta no socket depois
  // que o listener do bridge já está montado (constructor roda síncrono acima).
  if (leftover.length > 0) socket.emit("data", leftover);
}

function startAudioSocketServer() {
  const server = net.createServer((socket) => {
    let recvBuffer = Buffer.alloc(0);

    const onFirstData = (chunk: Buffer) => {
      recvBuffer = Buffer.concat([recvBuffer, chunk]);
      if (recvBuffer.length < 3) return;

      const type = recvBuffer[0] ?? 0;
      const len = recvBuffer.readUInt16BE(1);
      if (recvBuffer.length < 3 + len) return; // frame de UUID incompleto, espera mais

      socket.off("data", onFirstData);

      if (type !== 0x01) {
        console.error(`[audiosocket] primeiro frame não é UUID (tipo 0x${type.toString(16)}) — fechando`);
        socket.end();
        return;
      }

      const uuid = bytesToUuid(recvBuffer.subarray(3, 3 + len));
      const leftover = recvBuffer.subarray(3 + len);
      void handleAudioSocketConnection(socket, uuid, leftover);
    };

    socket.on("data", onFirstData);
    socket.on("error", (err) => console.error("[audiosocket] erro antes do UUID:", err.message));
  });

  server.listen(AUDIOSOCKET_PORT, () => {
    console.info(`[audiosocket] servidor TCP escutando na porta ${AUDIOSOCKET_PORT}`);
  });
}

// ---------- bootstrap ----------

function assertEnv() {
  const required = ["ARI_URL", "ARI_WS_URL", "ARI_USERNAME", "ARI_PASSWORD", "OPENAI_API_KEY"];
  const missing = required.filter((k) => !process.env[k]);
  if (missing.length > 0) {
    throw new Error(`[voice-agent] env faltando: ${missing.join(", ")}`);
  }
}

function main() {
  assertEnv();
  console.info("[voice-agent] worker iniciado, conectando ao ARI...");
  connectAriEvents(async (event) => {
    try {
      if (event.type === "StasisStart") await handleStasisStart(event);
    } catch (err) {
      console.error("[voice-agent] erro processando evento ARI:", err);
    }
  });
  startAudioSocketServer();
}

main();
