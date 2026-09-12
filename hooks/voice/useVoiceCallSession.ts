"use client";
import { useCallback, useEffect, useRef, useState, type RefObject } from "react";

import { apiClient } from "@/lib/api/client";
import { showApiError } from "@/components/feedback/ApiErrorToast";
import { usePermission } from "@/hooks/auth/AuthProvider";
import { useAuth } from "@/hooks/auth/AuthProvider";
import { useRealtimeChannel } from "@/hooks/realtime/useRealtimeChannel";
import { float32ToInt16LE, int16LEToFloat32 } from "@/lib/wacalls/pcm";

export type VoiceCallStatus = "starting" | "ringing" | "connected" | "ended";

/**
 * O que o CAMINHO DE ÁUDIO está fazendo — medido no `RTCPeerConnection`, não no
 * banco.
 *
 * ═══ POR QUE ISTO EXISTE (a falha-em-verde que o produto tinha) ═══
 *
 * `call.status` vem de `voice_calls`, escrito pela ponte de eventos a partir do
 * WhatsApp: ele diz que a LIGAÇÃO foi atendida, e essa é a verdade dele. Não diz
 * nada sobre o áudio chegar até este navegador — são dois transportes
 * diferentes, e na VPS o segundo é justamente o que quebra (porta UDP não
 * publicada, `WACALLS_PUBLIC_IP` vazio: o WaCalls anuncia como candidato o IP
 * interno do contêiner, `172.x`, que nenhum navegador da internet alcança).
 *
 * Com a versão anterior deste hook, esse cenário produzia o pior desfecho
 * possível: `conectarMidia` terminava sem erro (a troca de SDP é HTTP e
 * funciona), `connectingMedia` voltava a `false`, e o painel mostrava o
 * cronômetro correndo — em silêncio absoluto. NADA no código escutava a
 * `RTCPeerConnection`. Quem instalou não tinha como saber se o problema era a
 * rede dele, o microfone, ou o produto.
 *
 * Os estados abaixo são degraus de PROVA, do mais fraco ao mais forte:
 *
 * - `negociando`  a conexão existe, ICE/DTLS/SCTP ainda não fecharam;
 * - `aberta`      o canal `pcm` abriu. Isto NÃO é detalhe: um DataChannel só
 *                 abre depois de ICE conectar, DTLS handshakear e SCTP
 *                 associar — ou seja, o caminho UDP funciona nos dois sentidos.
 *                 É a prova de que a rede está certa;
 * - `com_audio`   chegou o primeiro quadro de PCM do outro lado. Prova de que
 *                 há SOM, não só rota;
 * - `sem_rota`    ICE falhou, ou o prazo venceu sem o canal abrir.
 */
export type EstadoDaMidia = "ociosa" | "negociando" | "aberta" | "com_audio" | "sem_rota";

/**
 * Quanto tempo o caminho de mídia tem para abrir antes de o painel declarar que
 * não abriu.
 *
 * Existe porque `RTCPeerConnection.connectionState` NÃO é um sinal pontual: o
 * navegador só o move para `failed` depois de esgotar as checagens de
 * conectividade de todos os pares de candidatos, o que numa rede que
 * simplesmente engole UDP leva dezenas de segundos. Sem prazo, o painel ficaria
 * "Abrindo áudio…" por tempo indeterminado — que é a mesma mentira de antes com
 * outra roupa.
 *
 * O prazo NÃO desliga nada e NÃO é definitivo: se o canal abrir em 14s,
 * `dc.onopen` corrige o estado. Ele só impede que "não sei" se disfarce de
 * "quase lá".
 */
const PRAZO_PARA_ABRIR_MS = 12_000;

export interface VoiceCallRow {
  id: string;
  contact_id: string | null;
  direction: "inbound" | "outbound";
  peer_phone: string;
  status: VoiceCallStatus;
  end_reason: string | null;
  started_at: string;
  answered_at: string | null;
  /** Quem está NA LINHA. `null` numa chamada recebida que ninguém atendeu. */
  owner_user_id?: string | null;
  /** Quem discou pelo CRM. `null` em toda ligação recebida. */
  created_by?: string | null;
}

interface VoiceCallsListResponse {
  data: VoiceCallRow[];
}

/** Chamada que a UI mostra AGORA: a mais recente ainda não `ended`. */
function ehRelevante(row: VoiceCallRow): boolean {
  return row.status !== "ended";
}

/**
 * Sessão de chamada de voz — spec docs/specs/18-spec-voice-calls-wacalls.md §5.
 *
 * Um hook só, porque as 3 telas (discador, recebendo, em andamento) são a
 * MESMA máquina de estado vista em 3 momentos, não 3 fluxos independentes.
 * `voice_calls` via Realtime é a fonte de verdade do STATUS (a ponte de
 * eventos do worker escreve lá); o WebRTC aqui é só o transporte de ÁUDIO —
 * os dois avançam em paralelo e podem divergir por um instante (ex.: WebRTC
 * conectado antes do Realtime confirmar `connected`), o que é esperado.
 */
export function useVoiceCallSession(remoteAudioRef: RefObject<HTMLAudioElement | null>) {
  const { user, activeOrg } = useAuth();
  /**
   * Quem NÃO pode ligar também não sonda e não assina.
   *
   * Este provider mora no shell autenticado inteiro (`app/app/layout.tsx`), então
   * o efeito de boot abaixo dispara em TODA tela. `GET /voice/calls/history` pede
   * `agent`; um `viewer` — e um acompanhamento administrativo somente-leitura,
   * que `resolveActiveOrg` rebaixa a `viewer` — levava 403 a cada navegação, com
   * o `.catch` engolindo o erro: invisível na tela, e o `expect(unexpectedDenials)
   * .toEqual([])` de `tests/e2e/suporte-temporario.spec.ts` contando dois.
   *
   * O conserto não é afrouxar o gate da rota: é não pedir. Quem não atende
   * telefone não precisa de painel de chamada, e um banner tocando para quem o
   * botão "Atender" vai recusar com 403 é uma promessa falsa.
   */
  const podeLigar = usePermission("voice.call");
  const orgId = podeLigar ? activeOrg?.orgId : undefined;

  const [call, setCall] = useState<VoiceCallRow | null>(null);
  const [muted, setMuted] = useState(false);
  const [connectingMedia, setConnectingMedia] = useState(false);
  const [estadoDaMidia, setEstadoDaMidia] = useState<EstadoDaMidia>("ociosa");

  const pcRef = useRef<RTCPeerConnection | null>(null);
  const dcRef = useRef<RTCDataChannel | null>(null);
  const prazoRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /**
   * "Já chegou áudio?" mora num ref, e não no estado, de propósito.
   *
   * `dc.onmessage` dispara a cada quadro de PCM — o worklet de captura do
   * WaCalls empacota 128 amostras a 16 kHz, ou seja ~125 mensagens por segundo,
   * em cada sentido. Um `setEstadoDaMidia` incondicional ali re-renderizaria o
   * shell autenticado INTEIRO 125 vezes por segundo durante a ligação toda. O
   * ref deixa o `setState` acontecer exatamente uma vez, no primeiro quadro.
   */
  const recebeuAudioRef = useRef(false);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const callRef = useRef<VoiceCallRow | null>(null);
  const isAcceptingRef = useRef(false);
  // Sincronizado em efeito, não durante o render: `callRef` só serve pra
  // closures de callback (accept/reject/hangUp) lerem o valor mais recente
  // sem entrar nas dependências — nunca é lido durante a renderização em si.
  useEffect(() => {
    callRef.current = call;
  }, [call]);

  /**
   * A ligação é MINHA?
   *
   * O banner de chamada recebida toca para todo mundo, e isso está certo: é um
   * telefone de escritório, e quem estiver perto atende. O PAINEL de chamada em
   * andamento não — ele aparecia para todos os colegas assim que alguém
   * discava, com botão de desligar e de mudo funcionando sobre a ligação de
   * outra pessoa. E o áudio ia junto: `conectarMidia` abria microfone e
   * `RTCPeerConnection` no navegador de quem só estava passando pela tela.
   *
   * A mesma regra que o servidor aplica em `podeEncerrar`
   * (`lib/wacalls/calls.ts`), aqui só para não OFERECER o que lá seria 403.
   */
  const minha =
    !!call &&
    (call.owner_user_id
      ? call.owner_user_id === user.id
      : !!call.created_by && call.created_by === user.id);

  const teardownMedia = useCallback(() => {
    try {
      dcRef.current?.close();
    } catch {}
    dcRef.current = null;

    try {
      pcRef.current?.close();
    } catch {}
    pcRef.current = null;

    try {
      localStreamRef.current?.getTracks().forEach((t) => t.stop());
    } catch {}
    localStreamRef.current = null;

    try {
      void audioCtxRef.current?.close();
    } catch {}
    audioCtxRef.current = null;

    if (prazoRef.current) clearTimeout(prazoRef.current);
    prazoRef.current = null;
    recebeuAudioRef.current = false;

    if (remoteAudioRef.current) remoteAudioRef.current.srcObject = null;
    setMuted(false);
    setConnectingMedia(false);
    setEstadoDaMidia("ociosa");
  }, [remoteAudioRef]);

  // Carrega a chamada em andamento no boot (refresh de página no meio de uma
  // ligação não pode perder o painel — é exatamente o tipo de "sumiu sem
  // explicação" que a doutrina de UI proíbe).
  useEffect(() => {
    if (!orgId) return;
    let cancelado = false;
    apiClient
      .get<VoiceCallsListResponse>("/api/v1/voice/calls/history?limit=5")
      .then((res) => {
        if (cancelado) return;
        const ativa = res.data.find(ehRelevante);
        if (ativa) setCall(ativa);
      })
      .catch(() => {
        // Falha aqui não é crítica: o Realtime pega o próximo evento. Uma
        // ligação já em andamento só não reaparece até a próxima mudança de
        // status — pior caso é um refresh perder o painel por alguns segundos.
      });
    return () => {
      cancelado = true;
    };
  }, [orgId]);

  const onRealtimeChange = useCallback((payload: unknown) => {
    const row = (payload as { new?: VoiceCallRow } | null)?.new;
    if (!row?.id) return;
    setCall((atual) => {
      // Só substitui se for a MESMA chamada (atualização) ou se não há
      // nenhuma em andamento (nova chamada chegando) — evita uma chamada de
      // outro atendente pisar no painel de quem já está em ligação.
      if (atual && atual.id !== row.id && ehRelevante(atual)) return atual;
      return ehRelevante(row) ? row : null;
    });
  }, []);

  useRealtimeChannel({
    name: "voice-calls",
    postgresChanges: {
      event: "*",
      table: "voice_calls",
      filter: orgId ? `organization_id=eq.${orgId}` : undefined,
    },
    onChange: onRealtimeChange,
    enabled: !!orgId,
  });

  /** Abre a RTCPeerConnection, conecta o DataChannel "pcm" e troca o áudio via AudioWorklets. */
  const conectarMidia = useCallback(async (callId: string) => {
    setConnectingMedia(true);
    setEstadoDaMidia("negociando");
    recebeuAudioRef.current = false;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      localStreamRef.current = stream;

      /**
       * `iceServers: []` é DELIBERADO, e vale só porque o outro lado tem
       * endereço público.
       *
       * O WaCalls funila toda a mídia numa porta UDP fixa
       * (`ice.NewMultiUDPMuxFromPort`, `internal/app/webrtc.go`) e reescreve o
       * candidato para `WACALLS_PUBLIC_IP` com tipo `host`. Então o par de
       * candidatos que fecha a conexão é [host privado do navegador] ↔ [host
       * público do servidor]: o navegador manda o Binding request, o NAT dele
       * reescreve a origem, e o pion aprende o endereço mapeado como candidato
       * *peer-reflexive* (RFC 8445 §7.3.1.3). Nenhum dos dois lados precisou de
       * STUN para isso — o servidor já sabe o próprio endereço público porque
       * o operador o declarou.
       *
       * Um STUN aqui só acrescentaria candidatos `srflx` do navegador, que o
       * servidor nunca precisa usar. O que FALTA mesmo, e não é isto, é TURN:
       * numa rede que bloqueia UDP de saída não há travessia possível, e é
       * exatamente esse caso que `sem_rota` passa a nomear em vez de esconder.
       */
      const pc = new RTCPeerConnection({ iceServers: [] });
      pcRef.current = pc;

      // O WaCalls opera áudio via DataChannel rotulado "pcm" com PCM 16kHz mono (Int16 LE)
      const dc = pc.createDataChannel("pcm", { ordered: true });
      dc.binaryType = "arraybuffer";
      dcRef.current = dc;

      // Só a partir daqui existe alguém escutando o transporte de verdade.
      // Antes disto, o único sinal de áudio na tela vinha do banco.
      dc.onopen = () => {
        setEstadoDaMidia(recebeuAudioRef.current ? "com_audio" : "aberta");
      };
      pc.onconnectionstatechange = () => {
        const estado = pc.connectionState;
        if (estado === "failed" || estado === "closed" || estado === "disconnected") {
          setEstadoDaMidia("sem_rota");
          return;
        }
        // Reconexão: `dc.onopen` não dispara de novo num canal que já abriu, e
        // sem esta volta o painel ficaria preso em "sem áudio" depois de um
        // soluço de rede que se resolveu sozinho.
        if (estado === "connected" && dc.readyState === "open") {
          setEstadoDaMidia(recebeuAudioRef.current ? "com_audio" : "aberta");
        }
      };
      prazoRef.current = setTimeout(() => {
        // Functional update: só derruba quem ainda está negociando. Se o canal
        // abriu no intervalo, este disparo é inofensivo.
        setEstadoDaMidia((atual) => (atual === "negociando" ? "sem_rota" : atual));
      }, PRAZO_PARA_ABRIR_MS);

      const AudioContextClass =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      const ctx = new AudioContextClass({ sampleRate: 16000 });
      audioCtxRef.current = ctx;

      await ctx.audioWorklet.addModule("/worklets/capture-processor.js");
      await ctx.audioWorklet.addModule("/worklets/playback-processor.js");
      await ctx.resume();

      // Microfone -> capture-processor -> DataChannel (PCM 16-bit LE)
      const micSource = ctx.createMediaStreamSource(stream);
      const captureNode = new AudioWorkletNode(ctx, "capture-processor");
      captureNode.port.onmessage = (e: MessageEvent<Float32Array>) => {
        if (dc.readyState === "open") {
          dc.send(float32ToInt16LE(e.data));
        }
      };
      micSource.connect(captureNode);
      // Conectar ao destination mantém o AudioWorkletNode ativo no Chromium
      captureNode.connect(ctx.destination);

      // DataChannel (PCM 16-bit LE) -> playback-processor -> MediaStreamDestination -> tag <audio>
      const playbackNode = new AudioWorkletNode(ctx, "playback-processor");
      const streamDest = ctx.createMediaStreamDestination();
      playbackNode.connect(streamDest);
      dc.onmessage = (e: MessageEvent<ArrayBuffer>) => {
        // O primeiro quadro que chega é a prova mais forte que existe de que a
        // ligação tem SOM — mais forte que o canal aberto, e incomparavelmente
        // mais forte que a linha no banco. Ver `recebeuAudioRef` para por que a
        // guarda não é opcional.
        if (!recebeuAudioRef.current) {
          recebeuAudioRef.current = true;
          setEstadoDaMidia("com_audio");
        }
        playbackNode.port.postMessage(int16LEToFloat32(e.data));
      };

      if (remoteAudioRef.current) {
        remoteAudioRef.current.srcObject = streamDest.stream;
        void remoteAudioRef.current.play().catch(() => {});
      }

      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);

      // Aguarda a coleta de candidatos ICE completar para enviar a oferta com todos os candidatos
      await new Promise<void>((resolve) => {
        if (pc.iceGatheringState === "complete") {
          resolve();
        } else {
          const checkState = () => {
            if (pc.iceGatheringState === "complete") {
              pc.removeEventListener("icegatheringstatechange", checkState);
              resolve();
            }
          };
          pc.addEventListener("icegatheringstatechange", checkState);
        }
      });

      const res = await apiClient.post<{ data: { sdpAnswer: string } }>(
        `/api/v1/voice/calls/${callId}/webrtc`,
        { sdpOffer: pc.localDescription!.sdp },
      );
      await pc.setRemoteDescription({ type: "answer", sdp: res.data.sdpAnswer });
    } catch (err) {
      showApiError(err);
      teardownMedia();
    } finally {
      setConnectingMedia(false);
    }
  }, [remoteAudioRef, teardownMedia]);

  // Assim que o Realtime confirma `connected`, abre o áudio — não antes: o
  // WaCalls só aceita a troca de SDP depois que o `<call>` foi realmente
  // aceito do lado do WhatsApp (§4.1 da spec).
  useEffect(() => {
    // `minha` na condição: sem isso, o navegador de todo colega logado abria
    // microfone e RTCPeerConnection na ligação de outra pessoa assim que o
    // Realtime dizia `connected`.
    if (minha && call?.status === "connected" && !pcRef.current && !connectingMedia) {
      void conectarMidia(call.id);
    }
    if ((call?.status === "ended" || !call) && (pcRef.current || localStreamRef.current)) {
      teardownMedia();
    }
  }, [minha, call, connectingMedia, conectarMidia, teardownMedia]);

  const startCall = useCallback(async (contactId: string) => {
    if (!podeLigar) return;
    try {
      const res = await apiClient.post<{ data: VoiceCallRow }>("/api/v1/voice/calls", { contactId });
      setCall(res.data);
    } catch (err) {
      showApiError(err);
    }
  }, [podeLigar]);

  const acceptCall = useCallback(async () => {
    const atual = callRef.current;
    if (!atual || isAcceptingRef.current) return;
    isAcceptingRef.current = true;
    try {
      await apiClient.post(`/api/v1/voice/calls/${atual.id}/accept`, {});
    } catch (err) {
      showApiError(err);
    } finally {
      isAcceptingRef.current = false;
    }
  }, []);

  const rejectCall = useCallback(async () => {
    const atual = callRef.current;
    if (!atual) return;
    try {
      await apiClient.post(`/api/v1/voice/calls/${atual.id}/reject`, {});
    } finally {
      setCall(null);
    }
  }, []);

  const hangUp = useCallback(async () => {
    const atual = callRef.current;
    if (!atual) return;
    try {
      await apiClient.delete(`/api/v1/voice/calls/${atual.id}`);
    } catch (err) {
      showApiError(err);
    } finally {
      setCall(null);
    }
  }, []);

  const toggleMute = useCallback(() => {
    const stream = localStreamRef.current;
    if (!stream) return;
    const next = !muted;
    stream.getAudioTracks().forEach((t) => (t.enabled = !next));
    setMuted(next);
  }, [muted]);

  useEffect(() => teardownMedia, [teardownMedia]);

  return {
    call,
    /** `true` só quando quem está vendo é quem está na linha. */
    minha,
    muted,
    connectingMedia,
    /** O que o transporte de áudio está fazendo DE FATO — ver `EstadoDaMidia`. */
    estadoDaMidia,
    startCall,
    acceptCall,
    rejectCall,
    hangUp,
    toggleMute,
  };
}
