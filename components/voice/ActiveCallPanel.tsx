"use client";
import { useEffect, useState } from "react";

import { useVoiceCall } from "@/components/voice/VoiceCallContext";
import { useContact } from "@/hooks/contacts/useContact";
import { rotuloDoContato } from "@/lib/contacts/rotulo-do-contato";
import { phoneForDisplay } from "@/lib/channels/phone-variants";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { CircleNotch, Microphone, MicrophoneSlash, PhoneX, Warning } from "@/lib/ui/icons";
import { useT } from "@/hooks/i18n/useT";

function formatarDuracao(segundos: number): string {
  const m = Math.floor(segundos / 60);
  const s = segundos % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

/**
 * Chamada em andamento — painel fixo, não modal (spec §5.3): quem está numa
 * ligação precisa continuar navegando o CRM sem perder o painel de controle.
 */
export function ActiveCallPanel() {
  const {
    call,
    muted,
    connectingMedia,
    estadoDaMidia,
    midiaEmOutraAba,
    encerrando,
    toggleMute,
    hangUp,
    ouvirAqui,
  } = useVoiceCall();
  const contactQuery = useContact(call?.contact_id ?? "");
  const [duracao, setDuracao] = useState(0);
  const t = useT();

  const contact = call?.contact_id ? contactQuery.data?.data : undefined;
  const nome = contact ? rotuloDoContato(contact) : phoneForDisplay(call?.peer_phone ?? "");
  const inicial = (nome || "?").trim().charAt(0).toUpperCase();

  const conectada = call?.status === "connected" && !!call.answered_at;

  // Só liga o ticker quando conectada — a reinicialização pra 0 é o efeito de
  // DESMONTAR este mesmo efeito (a condição vira falsa), não uma segunda
  // chamada de setState no corpo dele.
  useEffect(() => {
    if (!conectada || !call?.answered_at) return;
    const inicio = new Date(call.answered_at).getTime();
    const id = setInterval(
      () => setDuracao(Math.max(0, Math.floor((Date.now() - inicio) / 1000))),
      1000,
    );
    return () => clearInterval(id);
  }, [conectada, call?.answered_at]);

  const duracaoExibida = conectada ? duracao : 0;

  if (!call) return null;

  const rotuloEstado =
    call.status === "connected"
      ? formatarDuracao(duracaoExibida)
      : call.direction === "outbound"
        ? t("Chamando…")
        : t("Conectando…");

  /**
   * A linha que faltava — e a razão desta tela existir como está.
   *
   * O cronômetro acima é honesto sobre a LIGAÇÃO (o WhatsApp atendeu, o outro
   * lado está na linha) e não diz nada sobre o ÁUDIO chegar até aqui. Enquanto
   * ninguém escutava o `RTCPeerConnection`, "0:14 correndo em silêncio total"
   * era indistinguível de uma chamada perfeita, e quem instalou numa VPS com a
   * porta UDP fechada não tinha nenhum fio para puxar.
   *
   * O cronômetro NÃO some quando o áudio falha: a ligação existe mesmo, e
   * escondê-la mentiria para o outro lado. Quem conta a verdade é esta linha.
   */
  const avisoDeMidia: { texto: string; grave: boolean; ouvirAqui?: string } | null = midiaEmOutraAba
    ? // A ligação é desta pessoa, mas o áudio está noutra aba ou aparelho dela.
      // Abrir aqui sozinho trocaria a ponte do serviço de voz e emudeceria a aba
      // que ela está usando — então pergunta, com o botão.
      { texto: t("O áudio desta ligação está em outra aba"), grave: false, ouvirAqui: t("Ouvir aqui") }
    : estadoDaMidia === "falhou"
      ? // Antes do "connected" também: o microfone é pedido no clique, com o
        // telefone ainda tocando, e dá tempo de corrigir antes de o cliente atender.
        { texto: t("Não consegui abrir o áudio. Confira o microfone."), grave: true, ouvirAqui: t("Tentar de novo") }
    : call.status !== "connected" || estadoDaMidia === "com_audio"
      ? null
      : estadoDaMidia === "sem_rota"
        ? { texto: t("Sem áudio: o canal de voz não abriu"), grave: true, ouvirAqui: t("Tentar de novo") }
        : estadoDaMidia === "caiu"
          ? { texto: t("O áudio caiu"), grave: true, ouvirAqui: t("Reconectar o áudio") }
          : { texto: t("Abrindo o áudio…"), grave: false };

  return (
    <div
      role="region"
      aria-label={t("Chamada em andamento")}
      className="fixed bottom-4 right-4 z-50 flex w-[min(320px,calc(100%-2rem))] items-center gap-3 rounded-xl border border-border bg-popover p-3 shadow-2xl animate-in fade-in slide-in-from-bottom-4"
    >
      <Avatar className="h-10 w-10 shrink-0">
        {contact?.id ? (
          <AvatarImage
            src={`/api/v1/contacts/${contact.id}/avatar`}
            alt=""
            className="object-cover"
          />
        ) : null}
        <AvatarFallback className="bg-primary/15 text-sm font-semibold text-primary">
          {inicial}
        </AvatarFallback>
      </Avatar>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-semibold">{nome}</p>
        <p className="flex items-center gap-1 text-xs text-muted-foreground tabular-nums">
          {(call.status !== "connected" || connectingMedia) && (
            <CircleNotch size={12} weight="bold" className="animate-spin" aria-hidden />
          )}
          {rotuloEstado}
        </p>
        {avisoDeMidia ? (
          <p
            role="status"
            className={`flex items-center gap-1 text-[11px] ${
              avisoDeMidia.grave ? "font-medium text-destructive" : "text-muted-foreground"
            }`}
          >
            {avisoDeMidia.grave ? (
              <Warning size={11} weight="fill" className="shrink-0" aria-hidden />
            ) : (
              <CircleNotch size={11} weight="bold" className="shrink-0 animate-spin" aria-hidden />
            )}
            <span className="truncate">{avisoDeMidia.texto}</span>
            {avisoDeMidia.ouvirAqui ? (
              <button
                type="button"
                onClick={ouvirAqui}
                className="ml-1 shrink-0 font-semibold text-foreground underline underline-offset-2"
              >
                {avisoDeMidia.ouvirAqui}
              </button>
            ) : null}
          </p>
        ) : null}
      </div>
      <div className="flex shrink-0 items-center gap-1.5">
        <Button
          size="icon"
          variant="ghost"
          className="rounded-full"
          onClick={toggleMute}
          disabled={call.status !== "connected"}
          aria-pressed={muted}
          aria-label={muted ? t("Reativar microfone") : t("Silenciar microfone")}
        >
          {muted ? (
            <MicrophoneSlash size={16} weight="bold" aria-hidden />
          ) : (
            <Microphone size={16} weight="bold" aria-hidden />
          )}
        </Button>
        <Button
          size="icon"
          variant="destructive"
          className="rounded-full"
          onClick={() => void hangUp()}
          disabled={encerrando}
          aria-busy={encerrando}
          aria-label={t("Encerrar chamada")}
        >
          {encerrando ? (
            <CircleNotch size={16} weight="bold" className="animate-spin" aria-hidden />
          ) : (
            <PhoneX size={16} weight="bold" aria-hidden />
          )}
        </Button>
      </div>
    </div>
  );
}
