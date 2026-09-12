"use client";
import { useEffect } from "react";

import { useVoiceCall } from "@/components/voice/VoiceCallContext";
import { useContact } from "@/hooks/contacts/useContact";
import { rotuloDoContato } from "@/lib/contacts/rotulo-do-contato";
import { phoneForDisplay } from "@/lib/channels/phone-variants";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Phone, PhoneX } from "@/lib/ui/icons";
import { useT } from "@/hooks/i18n/useT";

/**
 * Chamada recebida — overlay global (spec §5.2). Sobrepõe qualquer tela,
 * porque uma ligação chegando é evento do mesmo tipo que uma notificação de
 * sistema, não conteúdo de uma página específica.
 */
export function IncomingCallBanner() {
  const { call, acceptCall, rejectCall } = useVoiceCall();
  const contactQuery = useContact(call?.contact_id ?? "");
  const t = useT();

  const contact = call?.contact_id ? contactQuery.data?.data : undefined;
  const nome = contact ? rotuloDoContato(contact) : phoneForDisplay(call?.peer_phone ?? "");
  const inicial = (nome || "?").trim().charAt(0).toUpperCase();

  // Toque sintetizado via Web Audio (sem arquivo de asset): dois beeps curtos
  // a cada 2s, padrão de toque de telefone. `.catch` silencioso porque
  // autoplay sem interação prévia pode ser bloqueado pelo browser — o BANNER
  // visual é a garantia de que a chamada não passa despercebida, o som é reforço.
  useEffect(() => {
    if (!call) return;
    const AudioCtx = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioCtx) return;
    const ctx = new AudioCtx();
    const beep = (quando: number) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.frequency.value = 880;
      gain.gain.setValueAtTime(0.0001, quando);
      gain.gain.exponentialRampToValueAtTime(0.15, quando + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, quando + 0.35);
      osc.connect(gain).connect(ctx.destination);
      osc.start(quando);
      osc.stop(quando + 0.4);
    };
    let ativo = true;
    const tocar = () => {
      if (!ativo) return;
      const agora = ctx.currentTime;
      beep(agora);
      beep(agora + 0.45);
    };
    tocar();
    const intervalo = setInterval(tocar, 2000);
    return () => {
      ativo = false;
      clearInterval(intervalo);
      void ctx.close().catch(() => {});
    };
  }, [call]);

  if (!call) return null;

  return (
    <div
      role="alertdialog"
      aria-label={t("Chamada de voz recebida")}
      className="fixed inset-x-0 top-4 z-50 mx-auto flex w-[min(420px,calc(100%-2rem))] items-center gap-4 rounded-xl border border-border bg-popover p-4 shadow-2xl animate-in fade-in slide-in-from-top-4"
    >
      <Avatar className="h-12 w-12 shrink-0">
        {contact?.id ? (
          <AvatarImage
            src={`/api/v1/contacts/${contact.id}/avatar`}
            alt=""
            className="object-cover"
          />
        ) : null}
        <AvatarFallback className="bg-primary/15 text-base font-semibold text-primary">
          {inicial}
        </AvatarFallback>
      </Avatar>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-semibold">{nome}</p>
        <p className="text-xs text-muted-foreground">{t("Chamada de voz recebida")}</p>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <Button
          size="icon"
          variant="destructive"
          className="rounded-full"
          onClick={() => void rejectCall()}
          aria-label={t("Recusar chamada")}
        >
          <PhoneX size={18} weight="bold" aria-hidden />
        </Button>
        <Button
          size="icon"
          className="rounded-full bg-success text-white hover:brightness-95"
          onClick={() => void acceptCall()}
          aria-label={t("Atender chamada")}
        >
          <Phone size={18} weight="bold" aria-hidden />
        </Button>
      </div>
    </div>
  );
}
