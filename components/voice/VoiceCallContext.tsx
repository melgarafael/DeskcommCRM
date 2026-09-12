"use client";
import { createContext, useContext, useRef, type ReactNode } from "react";

import { useVoiceCallSession } from "@/hooks/voice/useVoiceCallSession";
import { IncomingCallBanner } from "@/components/voice/IncomingCallBanner";
import { ActiveCallPanel } from "@/components/voice/ActiveCallPanel";

type VoiceCallSession = ReturnType<typeof useVoiceCallSession>;

const VoiceCallCtx = createContext<VoiceCallSession | null>(null);

/**
 * Overlay global de chamada de voz — monta UMA vez no shell autenticado
 * (`app/app/layout.tsx`), não por página. Uma ligação sobrevive à navegação
 * entre telas do CRM (spec §5.3: "usuário deve conseguir navegar durante a
 * ligação"), o que só funciona se o RTCPeerConnection não remontar a cada rota.
 *
 * O ref do `<audio>` nasce AQUI, fora do hook, e entra como parâmetro — não
 * como parte do objeto que o hook devolve. Um ref misturado no mesmo objeto
 * que o render consome faz o linter de refs do React tratar toda leitura
 * daquele objeto como "acesso a ref durante o render" (falso positivo do
 * analisador, mas a separação é a correção limpa, não a supressão).
 */
export function VoiceCallProvider({ children }: { children: ReactNode }) {
  const remoteAudioRef = useRef<HTMLAudioElement>(null);
  const session = useVoiceCallSession(remoteAudioRef);
  const { call, minha } = session;

  return (
    <VoiceCallCtx.Provider value={session}>
      {children}
      <audio ref={remoteAudioRef} autoPlay />
      {/* Chamada recebida que ninguém assumiu: banner de decisão (§5.2), e ele
          toca para TODO MUNDO de propósito — é telefone de escritório, quem
          estiver perto atende.

          O painel de chamada em andamento (§5.3) é o oposto: só de quem está na
          linha. Ele aparecia para o escritório inteiro assim que alguém discava,
          com botão de desligar ativo sobre a ligação alheia. */}
      {call?.direction === "inbound" && call.status === "ringing" && !call.owner_user_id ? (
        <IncomingCallBanner />
      ) : minha && call && call.status !== "ended" ? (
        <ActiveCallPanel />
      ) : null}
    </VoiceCallCtx.Provider>
  );
}

/** Nunca fora de `VoiceCallProvider` — erro alto em vez de UI muda sem porquê. */
export function useVoiceCall(): VoiceCallSession {
  const ctx = useContext(VoiceCallCtx);
  if (!ctx) throw new Error("useVoiceCall precisa estar dentro de <VoiceCallProvider>");
  return ctx;
}
