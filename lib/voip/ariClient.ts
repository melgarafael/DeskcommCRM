/**
 * workers/voice-agent/ariClient.ts
 *
 * Cliente fino para a Asterisk REST Interface (ARI).
 * Duas superfícies:
 *  - REST: originar chamada, answer, hangup, setar variável, devolver canal
 *    pro dialplan (continueDialplan) — mídia em si vai por AudioSocket (TCP),
 *    não por aqui.
 *  - WebSocket: eventos Stasis (StasisStart, ChannelHangupRequest, etc.)
 *
 * Env esperadas:
 *  ARI_URL           ex: http://asterisk:8088
 *  ARI_WS_URL        ex: ws://asterisk:8088/ari/events
 *  ARI_USERNAME
 *  ARI_PASSWORD
 *  ARI_APP           nome da Stasis app, ex: "voice-agent"
 */

import WebSocket from "ws";

const ARI_URL = process.env.ARI_URL!;
const ARI_USERNAME = process.env.ARI_USERNAME!;
const ARI_PASSWORD = process.env.ARI_PASSWORD!;
const ARI_APP = process.env.ARI_APP ?? "voice-agent";

function authHeader() {
  const token = Buffer.from(`${ARI_USERNAME}:${ARI_PASSWORD}`).toString("base64");
  return { Authorization: `Basic ${token}` };
}

async function ariFetch(path: string, init: RequestInit = {}) {
  const res = await fetch(`${ARI_URL}${path}`, {
    ...init,
    headers: { ...authHeader(), "Content-Type": "application/json", ...(init.headers ?? {}) },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`ARI ${init.method ?? "GET"} ${path} -> ${res.status}: ${body}`);
  }
  const ct = res.headers.get("content-type") ?? "";
  return ct.includes("application/json") ? res.json() : null;
}

// ---------- Chamadas de saída (originate) ----------

export interface OriginateParams {
  toNumber: string;        // número de destino, ex: "5551999998888"
  fromNumber?: string;     // caller ID opcional
  trunkEndpoint: string;   // ex: "PJSIP/meu-trunk" (tech/nome-do-endpoint)
  callerLabel?: string;    // vira variable no dialplan, útil pra correlacionar com crm_calls
  /**
   * ID que o PRÓPRIO chamador escolhe pro canal (ARI aceita `channelId` no
   * create). Existe pra fechar uma race real: sem isto, `crm_calls.
   * asterisk_channel_id` só é gravado DEPOIS que o POST retorna — e o
   * StasisStart no worker (processo separado, via WebSocket) pode chegar
   * ANTES dessa segunda escrita, e o worker não acha a linha (visto ao vivo
   * num teste: "número s não mapeado", porque caiu no fallback de inbound).
   * Gerando o id ANTES e gravando na mesma INSERT que cria `crm_calls`,
   * elimina o gap — não tem update() separado esperando o retorno do ARI.
   */
  channelId: string;
}

/**
 * Origina uma chamada de saída e entrega direto pro dialplan (contexto
 * [voice-agent-out] em extensions.conf), NÃO pra Stasis app.
 *
 * Isto NÃO é o padrão ARI usual (a maioria dos exemplos manda pra Stasis) —
 * é assim de propósito: testado ao vivo que uma bridge ARI "mixing" com um
 * canal externalMedia nunca relay o áudio injetado de volta pro trunk (só
 * silêncio, confirmado por captura de payload em várias tentativas). O
 * dialplan chama AudioSocket(${AUDIOSOCKET_UUID}, voice-agent:9092) — TCP
 * puro, sem bridge nenhuma no meio, e o Asterisk cuida da transcodificação
 * pra PCM16 sozinho. `channelId` é reusado como o UUID do AudioSocket (é
 * uma string UUID válida de qualquer forma, gerada em route.ts) — assim o
 * worker sabe qual crm_calls essa conexão TCP corresponde assim que o
 * primeiro frame (tipo UUID) chega, sem StasisStart, sem race.
 */
export async function originateCall(params: OriginateParams) {
  // PJSIP rejeita "+" no dial string ("Could not create dialog to invalid
  // URI") — E.164 com "+" é o formato de armazenamento/exibição (crm_calls,
  // phone_numbers), não o que vai na URI SIP. Provedores variam bastante
  // aqui (alguns querem prefixo "00", outros nada); "+" cru nunca funciona.
  const dialNumber = params.toNumber.replace(/^\+/, "");

  // Formato PJSIP/<endpoint>/<uri> falha com "Could not create dialog to
  // invalid URI" pra número cru (testado ao vivo, os dois com e sem "+").
  // PJSIP/<destino>@<nome-do-endpoint> é o que este trunk aceita — Asterisk
  // resolve o host/porta pelo AOR do endpoint, não pelo que vem depois do "/".
  const [tech, endpointName] = params.trunkEndpoint.split("/");
  const endpoint = `${tech}/${dialNumber}@${endpointName}`;

  return ariFetch("/ari/channels", {
    method: "POST",
    body: JSON.stringify({
      endpoint,
      context: "voice-agent-out",
      extension: "s",
      priority: 1,
      channelId: params.channelId,
      callerId: params.fromNumber,
      variables: {
        AUDIOSOCKET_UUID: params.channelId,
        ...(params.callerLabel ? { CALL_LABEL: params.callerLabel } : {}),
      },
    }),
  });
}

// ---------- Controle de canal ----------

export async function answerChannel(channelId: string) {
  return ariFetch(`/ari/channels/${channelId}/answer`, { method: "POST" });
}

export async function hangupChannel(channelId: string, reason = "normal") {
  return ariFetch(`/ari/channels/${channelId}?reason=${reason}`, { method: "DELETE" });
}

// ---------- Entrega pro dialplan (AudioSocket, chamadas de ENTRADA) ----------
//
// externalMedia + bridge (RTP/UDP) foram REMOVIDOS daqui — testado ao vivo,
// várias variações (1 canal, 2 canais, portas únicas, marker bit RTP): uma
// bridge ARI "mixing" nunca relay áudio injetado por um canal externalMedia
// de volta pro outro membro, só manda silêncio. Limitação conhecida do
// chan_rtp/externalMedia do Asterisk pra esse padrão de uso — não bug
// nosso, confirmado por pesquisa na comunidade Asterisk. AudioSocket (TCP
// puro, sem bridge no meio) resolve por completo — ver
// workers/voice-agent/audioSocketBridge.ts.

/**
 * Seta uma variável de canal — usado pra passar o UUID do AudioSocket antes
 * de devolver o canal pro dialplan (`continueDialplan`).
 */
export async function setChannelVariable(channelId: string, variable: string, value: string) {
  return ariFetch(`/ari/channels/${channelId}/variable?variable=${encodeURIComponent(variable)}&value=${encodeURIComponent(value)}`, {
    method: "POST",
  });
}

/**
 * Devolve o controle do canal pro dialplan, num contexto/extensão/prioridade
 * específicos — usado pra sair da Stasis app depois que o worker já resolveu
 * a org/agente (chamada de ENTRADA) e seguir pro AudioSocket() no
 * extensions.conf, sem bridge nenhuma no meio.
 */
export async function continueDialplan(channelId: string, context: string, extension: string, priority = 1) {
  return ariFetch(`/ari/channels/${channelId}/continue`, {
    method: "POST",
    body: JSON.stringify({ context, extension, priority }),
  });
}

// ---------- Eventos (WebSocket) ----------

/** Só os campos que o worker de voz lê — o envelope ARI real tem muito mais. */
export interface AriChannel {
  id: string;
  dialplan?: { exten?: string };
  caller?: { number?: string; name?: string };
}

export interface AriEvent {
  type: string;
  channel?: AriChannel;
}

export type AriEventHandler = (event: AriEvent) => void | Promise<void>;

export function connectAriEvents(onEvent: AriEventHandler): WebSocket {
  const wsUrl = `${process.env.ARI_WS_URL}?app=${ARI_APP}&api_key=${ARI_USERNAME}:${ARI_PASSWORD}&subscribeAll=true`;
  const ws = new WebSocket(wsUrl);

  ws.on("message", (raw) => {
    try {
      const event = JSON.parse(raw.toString());
      void onEvent(event);
    } catch (err) {
      console.error("[ari] evento inválido:", err);
    }
  });

  ws.on("close", () => console.warn("[ari] websocket fechado — reconectar via supervisor do worker"));
  ws.on("error", (err) => console.error("[ari] erro de websocket:", err));

  return ws;
}
