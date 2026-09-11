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
import { randomUUID } from "node:crypto";
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
import { resolveOrCreateCallerContact } from "@/lib/voip/resolve-caller";
import { garantirLeadDaConversa } from "@/lib/leads/nascimento-do-lead";
import { buscarConhecimento, resolverAcervoDoAgente } from "@/lib/ai/knowledge/busca";

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

  const callerNumber = channel.caller?.number ?? "unknown";

  // Identificador de ligações: acha (ou cria) o contato pelo número de quem
  // liga. Não bloqueia a chamada se falhar — o pior caso é a tela mostrar só
  // o número, igual antes desta função existir.
  let callerContactId: string | null = null;
  try {
    callerContactId = await resolveOrCreateCallerContact(supabaseAdmin, routing.organization_id, callerNumber);
  } catch (err) {
    console.error(`[voice-agent] falha ao resolver contato de ${callerNumber}:`, err);
  }

  // channel.id é o identificador NATIVO do canal no Asterisk (formato
  // "<epoch>.<sequencia>", ex.: "1789081888.0") — válido pras chamadas REST
  // do ARI (hangup/setChannelVariable/continueDialplan), mas NAO é um UUID:
  // app_audiosocket.c rejeita com "Failed to parse UUID" se receber isto
  // (visto ao vivo, toda chamada de entrada). Na SAÍDA isso nunca aparece
  // porque lá QUEM escolhe channel.id somos nós (route.ts gera o UUID e
  // passa em `channelId` pro ARI no originate) — na ENTRADA o Asterisk já
  // criou o canal, com o id dele, antes deste código rodar. Por isso aqui
  // se gera um UUID SEPARADO só pra correlação do AudioSocket/crm_calls;
  // as chamadas ARI continuam endereçando o canal por channel.id.
  const audioSocketUuid = randomUUID();

  const { data: callRow, error } = await supabaseAdmin
    .from("crm_calls")
    .insert({
      organization_id: routing.organization_id,
      direction: "inbound",
      status: "ringing",
      from_number: callerNumber,
      to_number: dialedNumber,
      contact_id: callerContactId,
      asterisk_channel_id: audioSocketUuid,
      started_at: new Date().toISOString(),
    })
    .select()
    .single();

  if (error || !callRow) {
    console.error(`[voice-agent] falha ao criar crm_calls pra chamada de entrada:`, error?.message);
    await hangupChannel(channel.id, "normal");
    return;
  }

  // A ligação é uma demanda nova, igual a uma mensagem de WhatsApp: sem isto,
  // quem liga e não é atendido fica de fora do funil e do radar de risco (os
  // dois trabalham sobre crm_leads, não sobre crm_calls). Idempotente por
  // contato — reusa o mesmo mecanismo do WhatsApp (nascimento-do-lead.ts),
  // só troca o rótulo/source de origem. Best-effort: não derruba a ligação.
  if (callerContactId) {
    try {
      const nascimento = await garantirLeadDaConversa(supabaseAdmin, {
        organizationId: routing.organization_id,
        contactId: callerContactId,
        conversationId: callRow.id,
        nomeDoContato: channel.caller?.name ?? null,
        origem: { rotulo: "chamada", source: "voip", motivo: "primeira ligação recebida" },
      });
      if (!nascimento.criado) {
        console.info(`[voice-agent] lead não criado para ${callerNumber}: ${nascimento.motivo}`);
      }
    } catch (err) {
      console.error(`[voice-agent] falha ao garantir lead da chamada de ${callerNumber}:`, err);
    }
  }

  // channel.id JÁ é o asterisk_channel_id gravado acima — reusa como UUID do
  // AudioSocket (mesmo padrão da saída), pra handleAudioSocketConnection
  // achar a linha certa assim que a conexão TCP chegar.
  await setChannelVariable(channel.id, "AUDIOSOCKET_UUID", audioSocketUuid);
  await continueDialplan(channel.id, "from-trunk-audiosocket", "s", 1);
}

type RoteamentoInbound = {
  organization_id: string;
  routing_mode: "ai" | "human" | "ai_then_human";
  default_ai_agent_id: string | null;
  fallback_user_id: string | null;
};

async function resolveInboundNumber(dialedNumber: string): Promise<RoteamentoInbound | null> {
  // Trunks de DID único mandam a extensão "s" no Request-URI em vez dos
  // dígitos do número discado (ver extensions.conf, contexto [from-trunk] —
  // "extension not found" antes desta função nem rodar era o sintoma).  Sem
  // DNIS real não dá pra saber QUAL número foi discado — mas com exatamente
  // UM número ativo cadastrado não tem ambiguidade nenhuma: só pode ser ele.
  // Se um dia existir mais de um, isto recusa (ambíguo) em vez de adivinhar.
  if (dialedNumber === "s") {
    const { data, error } = await supabaseAdmin
      .from("phone_numbers")
      .select("organization_id, routing_mode, default_ai_agent_id, fallback_user_id")
      .eq("is_active", true)
      .limit(2);
    if (error || !data || data.length !== 1) {
      console.error(
        `[voice-agent] extensão "s" (trunk de DID único) só resolve com exatamente 1 número ativo — achei ${data?.length ?? 0}`,
      );
      return null;
    }
    return data[0] as RoteamentoInbound;
  }

  const { data, error } = await supabaseAdmin
    .rpc("fn_resolve_inbound_number", { p_number: dialedNumber })
    .single();
  if (error || !data) return null;
  return data as RoteamentoInbound;
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

  // Mesmo acervo que o agente de texto (WhatsApp) já usa — reaproveita
  // resolverAcervoDoAgente/buscarConhecimento em vez de reimplementar RAG
  // pro canal de voz. Sem materiais publicados, a tool nem é oferecida ao
  // modelo (ver audioSocketBridge.ts) — não custa nada e evita ele "chamar
  // no escuro".
  const knowledgeSourceIds = await resolverAcervoDoAgente(
    supabaseAdmin,
    callRow.organization_id,
    agent.id,
  ).catch((err) => {
    console.error(`[audiosocket] falha ao resolver acervo do agente de voz:`, err);
    return [] as string[];
  });

  const bridge = new AudioSocketCallBridge(socket, {
    callId: callRow.id,
    organizationId: callRow.organization_id,
    agentInstructions: agent.systemPrompt,
    voice: agent.voice,
    voiceSpeed: agent.voiceSpeed,
    voiceModel: agent.voiceModel,
    apiKey: agent.apiKey,
    onTranscriptTurn: (turn) => appendAudioSocketTranscriptTurn(uuid, turn),
    onCallEnded: () => finalizeAudioSocketCall(uuid),
    searchKnowledge:
      knowledgeSourceIds.length > 0
        ? async (pergunta: string) => {
            const resultado = await buscarConhecimento(supabaseAdmin, {
              organizationId: callRow.organization_id,
              knowledgeSourceIds,
              pergunta,
              topK: agent.ragTopK,
              limiar: agent.ragSimilarityThreshold,
            });
            return { trechos: resultado.trechos };
          }
        : undefined,
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
