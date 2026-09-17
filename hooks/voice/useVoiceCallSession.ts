"use client";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type RefObject } from "react";

import { apiClient } from "@/lib/api/client";
import { showApiError } from "@/components/feedback/ApiErrorToast";
import { usePermission } from "@/hooks/auth/AuthProvider";
import { useAuth } from "@/hooks/auth/AuthProvider";
import { useRealtimeChannel } from "@/hooks/realtime/useRealtimeChannel";
import { randomId } from "@/lib/random-id";
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
 * - `caiu`        o canal CHEGOU a abrir e a conexão caiu depois. Separado de
 *                 `sem_rota` porque o texto do painel é o que alguém lê para
 *                 diagnosticar: "não abriu" aponta para rede/porta, "caiu"
 *                 aponta para queda no meio — e o fim da ligação, que fecha a
 *                 ponte do lado do WaCalls, também cai aqui.
 * - `falhou`      a tentativa nem chegou à rede: microfone negado ou fechado no
 *                 pedido do navegador, worklet que não carregou, troca de SDP
 *                 recusada. Existe porque a trava contra novas tentativas em
 *                 laço deixava o painel em "Abrindo o áudio…" para sempre, sem
 *                 botão — justo na primeira ligação de quem nunca deu permissão
 *                 ao microfone.
 */
export type EstadoDaMidia = "ociosa" | "negociando" | "aberta" | "com_audio" | "sem_rota" | "caiu" | "falhou";

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

/**
 * A resposta de `POST /voice/calls` COMPLETA a linha que o Realtime já trouxe,
 * em vez de substituí-la.
 *
 * A ponte de eventos grava a ligação ~200 ms antes de a rota responder, e o
 * Realtime entrega essa linha primeiro. Substituir pela resposta trocava uma
 * linha mais fresca por outra mais velha — e, enquanto a resposta não trazia
 * `owner_user_id`, `minha` virava `false` e o painel de quem discou sumia, com
 * o botão de desligar junto. Vale o que o Realtime já tem; a resposta só
 * preenche o que ele trouxe nulo (`created_by`, por exemplo, que a ponte não
 * conhece).
 */
export function mesclarRespostaDaChamada(
  atual: VoiceCallRow | null,
  resposta: VoiceCallRow,
): VoiceCallRow {
  if (!atual || atual.id !== resposta.id) return resposta;
  const mesclada = { ...resposta } as Record<string, unknown>;
  for (const [chave, valor] of Object.entries(atual)) {
    if (valor !== null && valor !== undefined) mesclada[chave] = valor;
  }
  return mesclada as unknown as VoiceCallRow;
}

/**
 * DE QUAL ABA É O ÁUDIO DESTA LIGAÇÃO.
 *
 * O WaCalls guarda UMA ponte de áudio por chamada: a troca de SDP mais recente
 * substitui a anterior e fecha a outra sem erro nem log (`setBridge`,
 * `internal/app/session/session.go`). A versão anterior deste hook abria o
 * áudio em TODO documento do usuário que recebesse o "connected" pelo Realtime.
 * Medido em produção em 2026-09-15: duas abertas, dois `voice.call_media_attached`
 * com 7 ms de diferença, duas assinaturas de `voice_calls` do mesmo usuário
 * abertas — e ninguém ouviu ninguém, porque a ponte que sobrou era a do
 * documento que ninguém estava usando.
 *
 * A marca mora em `sessionStorage`, e é essa a escolha: é por ABA (outra aba e
 * outro aparelho não a enxergam) e sobrevive ao recarregar — que é o único caso
 * em que o áudio precisa reabrir sem um clique. Quem grava é o gesto: "Chamar"
 * e "Atender". Storage bloqueado não afrouxa nada: sem marca, esta aba só abre
 * o áudio pelo clique.
 */
const MARCA_DA_ABA = "voz:midia";
const ID_DA_ABA = "voz:aba";

/** Espelho em memória: com o storage bloqueado, a marca vale até a aba recarregar. */
let marcaEmMemoria: string | null = null;
const ouvintesDaMarca = new Set<() => void>();

function lerMarcaDaAba(): string | null {
  try {
    return window.sessionStorage.getItem(MARCA_DA_ABA);
  } catch {
    return marcaEmMemoria;
  }
}

function gravarMarcaDaAba(callId: string | null): void {
  marcaEmMemoria = callId;
  try {
    if (callId) window.sessionStorage.setItem(MARCA_DA_ABA, callId);
    else window.sessionStorage.removeItem(MARCA_DA_ABA);
  } catch {
    // Storage bloqueado: fica o espelho em memória.
  }
  ouvintesDaMarca.forEach((avisar) => avisar());
}

/** A marca lida no render (`useSyncExternalStore`), sem efeito copiando para estado. */
function assinarMarcaDaAba(avisar: () => void): () => void {
  ouvintesDaMarca.add(avisar);
  return () => {
    ouvintesDaMarca.delete(avisar);
  };
}
const semMarcaNoServidor = () => null;

/**
 * Identificador aleatório desta aba, enviado na troca de SDP e gravado no audit.
 * Não identifica ninguém; existe para a pergunta "quantas abas abriram áudio
 * nesta ligação?" ter resposta no banco sem console de navegador nenhum.
 */
function idDaAba(): string | undefined {
  try {
    let id = window.sessionStorage.getItem(ID_DA_ABA);
    if (!id) {
      // `randomId`, nunca `crypto.randomUUID` cru: em self-host servido por
      // http://IP ele não existe (contexto não seguro) — ver lib/random-id.ts.
      id = randomId();
      window.sessionStorage.setItem(ID_DA_ABA, id);
    }
    return id;
  } catch {
    return undefined;
  }
}

/** Ordem do ciclo de vida — a conferência com o servidor só avança, nunca recua. */
const ORDEM_DO_STATUS: Record<VoiceCallStatus, number> = {
  starting: 0,
  ringing: 1,
  connected: 2,
  ended: 3,
};

/**
 * De quanto em quanto tempo o painel confere a ligação com o servidor.
 *
 * O painel dependia de UMA entrega do Realtime para saber que a ligação acabou.
 * O Realtime entrega no máximo uma vez e não guarda o que passou enquanto o
 * canal estava fora; medido em produção em 2026-09-15, o "ended" nunca chegou e
 * o painel ficou 66 s na tela depois de o celular desligar, até um clique em
 * encerrar. 10 s é o pior caso aceitável para um painel fantasma — e só roda
 * enquanto HÁ ligação, então tela sem ligação não consulta nada.
 */
export const RECONCILIAR_CHAMADA_MS = 10_000;

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
  /** Trava de clique repetido em "Encerrar" — o botão não tinha, e saíram dois DELETE. */
  const encerrandoRef = useRef(false);
  const [encerrando, setEncerrando] = useState(false);
  /** O canal `pcm` chegou a abrir nesta tentativa? Separa `caiu` de `sem_rota`. */
  const canalAbriuRef = useRef(false);
  /**
   * A chamada para a qual esta instância JÁ tentou abrir o áudio.
   *
   * Gravado de forma síncrona, antes do primeiro `await` de `conectarMidia`, e
   * NÃO limpo quando a tentativa falha: sem isso, falha → teardown → efeito →
   * nova tentativa, em laço. Só a troca de chamada ou "Ouvir aqui" liberam.
   */
  const midiaTentadaRef = useRef<string | null>(null);
  /**
   * Geração da mídia: `teardownMedia` e cada `conectarMidia` avançam. Uma
   * tentativa que volta de um `await` numa geração velha abandona o que criou em
   * vez de pendurar microfone e conexão órfãos por cima da tentativa atual.
   */
  const geracaoDaMidiaRef = useRef(0);
  /** Última chamada viva que esta instância acompanhou — para saber quando ELA acabou. */
  const ultimaChamadaRef = useRef<string | null>(null);
  /** Chamadas que esta instância sabe encerradas: nenhuma leitura velha as ressuscita. */
  const encerradasRef = useRef(new Set<string>());
  const marcaDaAba = useSyncExternalStore(assinarMarcaDaAba, lerMarcaDaAba, semMarcaNoServidor);
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

  /**
   * O áudio desta ligação está noutra aba (ou noutro aparelho) deste usuário:
   * a ligação é dele, está conectada, e a marca do áudio não é desta aba.
   * Derivado no render — é o que o painel usa para oferecer "Ouvir aqui".
   */
  const midiaEmOutraAba = minha && call?.status === "connected" && marcaDaAba !== call.id;

  const teardownMedia = useCallback(() => {
    geracaoDaMidiaRef.current++;
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
    // Recarregou no meio da ligação: a marca desta aba diz QUAL ligação é a
    // dela. Sem isso o boot adotava a mais recente da organização — de um
    // colega, ou uma recebida tocando — e a própria ligação não reabria.
    const marcada = lerMarcaDaAba();
    const url = marcada
      ? `/api/v1/voice/calls/history?id=${encodeURIComponent(marcada)}&limit=1`
      : "/api/v1/voice/calls/history?limit=5";
    apiClient
      .get<VoiceCallsListResponse>(url)
      .then(async (res) => {
        let linhas = res.data;
        if (marcada && !linhas.some((r) => r.id === marcada && ehRelevante(r))) {
          linhas = (await apiClient.get<VoiceCallsListResponse>("/api/v1/voice/calls/history?limit=5")).data;
        }
        if (cancelado) return;
        const ativa = linhas.find((r) => ehRelevante(r) && !encerradasRef.current.has(r.id));
        if (ativa) setCall((atual) => atual ?? ativa);
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

  /**
   * Confere a ligação desta tela com o servidor.
   *
   * Só AVANÇA o ciclo de vida (tocando → conectada → encerrada) e nunca adota
   * uma ligação que a tela não tinha: é a rede de segurança do Realtime, não uma
   * segunda fonte que brigue com ele. Erro de leitura não muda nada — a próxima
   * rodada tenta de novo.
   */
  const reconciliar = useCallback(async () => {
    const atual = callRef.current;
    if (!atual || !ehRelevante(atual)) return;
    try {
      // Pelo id, e não "entre as 5 mais recentes": num escritório com várias
      // ligações a desta tela sai da janela, e a rede de segurança deixaria de
      // achar justamente a ligação que precisa fechar.
      const res = await apiClient.get<VoiceCallsListResponse>(
        `/api/v1/voice/calls/history?id=${encodeURIComponent(atual.id)}&limit=1`,
      );
      const noServidor = res.data.find((r) => r.id === atual.id);
      if (!noServidor) return;
      if (noServidor.status === "ended") encerradasRef.current.add(noServidor.id);
      setCall((agora) => {
        if (!agora || agora.id !== noServidor.id) return agora;
        if (ORDEM_DO_STATUS[noServidor.status] <= ORDEM_DO_STATUS[agora.status]) return agora;
        return ehRelevante(noServidor) ? { ...agora, ...noServidor } : null;
      });
    } catch {
      // Sem resposta agora; o intervalo pergunta de novo.
    }
  }, []);

  const onRealtimeChange = useCallback((payload: unknown) => {
    // O canal voltou depois de cair: o que aconteceu enquanto ele esteve fora
    // NÃO vai chegar. Esta entrega sintética era descartada aqui (não tem
    // `.new`), e era justamente o sinal para buscar o que se perdeu.
    if ((payload as { tipo?: string } | null)?.tipo === "reassinado") {
      void reconciliar();
      return;
    }
    const row = (payload as { new?: VoiceCallRow } | null)?.new;
    if (!row?.id) return;
    if (row.status === "ended") encerradasRef.current.add(row.id);
    else if (encerradasRef.current.has(row.id)) return;
    setCall((atual) => {
      // Só substitui se for a MESMA chamada (atualização) ou se não há
      // nenhuma em andamento (nova chamada chegando) — evita uma chamada de
      // outro atendente pisar no painel de quem já está em ligação.
      if (atual && atual.id !== row.id && ehRelevante(atual)) return atual;
      return ehRelevante(row) ? row : null;
    });
  }, [reconciliar]);

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
    midiaTentadaRef.current = callId;
    const geracao = ++geracaoDaMidiaRef.current;
    setConnectingMedia(true);
    setEstadoDaMidia("negociando");
    recebeuAudioRef.current = false;
    canalAbriuRef.current = false;

    // O que ESTA tentativa criou — para abandonar só o que é dela quando uma
    // geração mais nova (encerrar, "Ouvir aqui") passou por cima durante um
    // `await`. Os refs, a essa altura, podem ser de outra tentativa.
    let meuStream: MediaStream | null = null;
    let minhaConexao: RTCPeerConnection | null = null;
    let meuContexto: AudioContext | null = null;
    const superada = () => {
      if (geracaoDaMidiaRef.current === geracao) return false;
      try {
        meuStream?.getTracks().forEach((t) => t.stop());
      } catch {}
      try {
        minhaConexao?.close();
      } catch {}
      try {
        void meuContexto?.close();
      } catch {}
      return true;
    };

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      meuStream = stream;
      if (superada()) return;
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
      minhaConexao = pc;
      pcRef.current = pc;

      // O WaCalls opera áudio via DataChannel rotulado "pcm" com PCM 16kHz mono (Int16 LE)
      const dc = pc.createDataChannel("pcm", { ordered: true });
      dc.binaryType = "arraybuffer";
      dcRef.current = dc;

      // Só a partir daqui existe alguém escutando o transporte de verdade.
      // Antes disto, o único sinal de áudio na tela vinha do banco.
      dc.onopen = () => {
        canalAbriuRef.current = true;
        setEstadoDaMidia(recebeuAudioRef.current ? "com_audio" : "aberta");
      };
      pc.onconnectionstatechange = () => {
        if (geracaoDaMidiaRef.current !== geracao) return;
        const estado = pc.connectionState;
        if (estado === "failed" || estado === "closed" || estado === "disconnected") {
          setEstadoDaMidia(canalAbriuRef.current ? "caiu" : "sem_rota");
          // O fim da ligação fecha a ponte do lado do WaCalls, e é esta a
          // primeira notícia que o navegador tem dele — muito antes do próximo
          // intervalo. Perguntar ao servidor aqui faz o painel sumir em ~1 s.
          void reconciliar();
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
      meuContexto = ctx;
      audioCtxRef.current = ctx;

      await ctx.audioWorklet.addModule("/worklets/capture-processor.js");
      if (superada()) return;
      await ctx.audioWorklet.addModule("/worklets/playback-processor.js");
      if (superada()) return;
      await ctx.resume();
      if (superada()) return;

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
      if (superada()) return;
      await pc.setLocalDescription(offer);
      if (superada()) return;

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

      // A última verificação ANTES do POST é a que importa: depois dele o
      // WaCalls já trocou a ponte, e uma tentativa superada que ainda enviasse a
      // oferta derrubaria a ponte da tentativa vigente.
      if (superada()) return;
      const res = await apiClient.post<{ data: { sdpAnswer: string } }>(
        `/api/v1/voice/calls/${callId}/webrtc`,
        { sdpOffer: pc.localDescription!.sdp, aba: idDaAba() },
      );
      if (superada()) return;
      await pc.setRemoteDescription({ type: "answer", sdp: res.data.sdpAnswer });
    } catch (err) {
      if (geracaoDaMidiaRef.current !== geracao) return;
      showApiError(err);
      teardownMedia();
      // Depois do teardown (que devolve `ociosa`): a tentativa NÃO é refeita
      // sozinha — `midiaTentadaRef` segue marcada, contra o laço —, então o
      // painel precisa dizer que falhou e oferecer o botão.
      setEstadoDaMidia("falhou");
    } finally {
      // Só a tentativa vigente fala pelo estado: uma superada que baixasse o
      // "conectando" apagaria o indicador da tentativa que está em curso.
      if (geracaoDaMidiaRef.current === geracao) setConnectingMedia(false);
    }
  }, [remoteAudioRef, teardownMedia, reconciliar]);

  /**
   * Quem abre o áudio é o GESTO ("Chamar", "Atender"), nesta aba — ver
   * `MARCA_DA_ABA`. Este efeito cobre só o que sobra:
   *
   * - **recarregar no meio da ligação:** a marca sobreviveu no `sessionStorage`
   *   desta aba, a tentativa não (os refs nasceram de novo) — reabre;
   * - **outra aba ou aparelho do mesmo usuário:** a ligação é dele, conectada,
   *   e a marca não é desta aba — NÃO abre, e avisa. Abrir ali trocaria a ponte
   *   do WaCalls e emudeceria a aba que o usuário está usando;
   * - **fim da ligação:** fecha a mídia e apaga a marca.
   *
   * A versão anterior abria em todo documento que recebesse o "connected", com
   * um comentário dizendo que o WaCalls só aceita a troca de SDP depois do
   * atendimento. Não é verdade: `doWebRTC` só exige que a chamada exista
   * (`internal/app/handlers_call.go`), e o cliente oficial troca o SDP logo
   * depois de discar (`client/src/hooks/useStartCall.ts`).
   */
  useEffect(() => {
    const viva = !!call && ehRelevante(call);
    if (viva) ultimaChamadaRef.current = call.id;

    if (!viva) {
      // `midiaTentadaRef` entra na condição: com o pedido de microfone ainda
      // pendente não há conexão nem stream para fechar, mas HÁ tentativa em
      // curso — e sem avançar a geração ela voltaria do `await` e trocaria o
      // SDP de uma ligação que já acabou.
      if (pcRef.current || localStreamRef.current || midiaTentadaRef.current) teardownMedia();
      const acabou = ultimaChamadaRef.current;
      // Só apaga a marca da ligação que ESTA instância viu acabar: no boot,
      // `call` nasce nulo antes de o histórico responder, e apagar ali mataria
      // a reabertura depois de recarregar.
      if (acabou && lerMarcaDaAba() === acabou) gravarMarcaDaAba(null);
      if (acabou) {
        midiaTentadaRef.current = null;
        ultimaChamadaRef.current = null;
      }
      return;
    }

    const conectada = call.status === "connected";
    if (minha && marcaDaAba === call.id && conectada && midiaTentadaRef.current !== call.id && !pcRef.current) {
      void conectarMidia(call.id);
    }
  }, [minha, call, marcaDaAba, conectarMidia, teardownMedia]);

  // Enquanto HÁ ligação: confere com o servidor a cada intervalo e quando a aba
  // volta a ficar visível (o navegador congela timers de aba escondida). O id,
  // e não a linha, na dependência — senão o intervalo reiniciaria a cada UPDATE.
  const idDaChamadaViva = call && ehRelevante(call) ? call.id : null;
  useEffect(() => {
    if (!idDaChamadaViva) return;
    const intervalo = setInterval(() => void reconciliar(), RECONCILIAR_CHAMADA_MS);
    const aoVoltar = () => {
      if (document.visibilityState === "visible") void reconciliar();
    };
    document.addEventListener("visibilitychange", aoVoltar);
    return () => {
      clearInterval(intervalo);
      document.removeEventListener("visibilitychange", aoVoltar);
    };
  }, [idDaChamadaViva, reconciliar]);

  /**
   * Traz o áudio para ESTA aba: grava a marca e abre a mídia de novo. Serve
   * para "o áudio está em outra aba", para "o áudio caiu" e para "não abriu" —
   * o WaCalls fica com a ponte mais recente, então esta passa a ser a viva.
   */
  const ouvirAqui = useCallback(() => {
    const atual = callRef.current;
    if (!atual || !ehRelevante(atual)) return;
    teardownMedia();
    gravarMarcaDaAba(atual.id);
    void conectarMidia(atual.id);
  }, [conectarMidia, teardownMedia]);

  const startCall = useCallback(async (contactId: string) => {
    if (!podeLigar) return;
    let criada: VoiceCallRow;
    try {
      const res = await apiClient.post<{ data: VoiceCallRow }>("/api/v1/voice/calls", { contactId });
      criada = res.data;
    } catch (err) {
      showApiError(err);
      return;
    }
    // O áudio abre AQUI, no gesto e ainda tocando — como o cliente oficial do
    // WaCalls. A primeira palavra de quem atende chega, e só esta aba abre.
    gravarMarcaDaAba(criada.id);
    ultimaChamadaRef.current = criada.id;
    setCall((atual) => mesclarRespostaDaChamada(atual, criada));
    void conectarMidia(criada.id);
  }, [podeLigar, conectarMidia]);

  const acceptCall = useCallback(async () => {
    const atual = callRef.current;
    if (!atual || isAcceptingRef.current) return;
    isAcceptingRef.current = true;
    // A marca antes do POST: o "connected" pode chegar pelo Realtime antes de a
    // resposta voltar, e esta é a aba que atendeu.
    gravarMarcaDaAba(atual.id);
    try {
      await apiClient.post(`/api/v1/voice/calls/${atual.id}/accept`, {});
      void conectarMidia(atual.id);
    } catch (err) {
      gravarMarcaDaAba(null);
      showApiError(err);
    } finally {
      isAcceptingRef.current = false;
    }
  }, [conectarMidia]);

  const rejectCall = useCallback(async () => {
    const atual = callRef.current;
    if (!atual) return;
    try {
      await apiClient.post(`/api/v1/voice/calls/${atual.id}/reject`, {});
    } finally {
      encerradasRef.current.add(atual.id);
      setCall(null);
    }
  }, []);

  const hangUp = useCallback(async () => {
    const atual = callRef.current;
    if (!atual || encerrandoRef.current) return;
    encerrandoRef.current = true;
    setEncerrando(true);
    try {
      await apiClient.delete(`/api/v1/voice/calls/${atual.id}`);
    } catch (err) {
      showApiError(err);
    } finally {
      encerradasRef.current.add(atual.id);
      encerrandoRef.current = false;
      setEncerrando(false);
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
    /** O áudio desta ligação está em outra aba/aparelho deste usuário. */
    midiaEmOutraAba,
    /** Encerrar em voo — o botão fica desabilitado para não sair outro DELETE. */
    encerrando,
    startCall,
    acceptCall,
    rejectCall,
    hangUp,
    toggleMute,
    ouvirAqui,
  };
}
