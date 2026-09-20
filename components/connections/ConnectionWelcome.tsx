"use client";
import Image from "next/image";
import { ArtisanIcon } from "@/components/brand/ArtisanIcon";
import { useT } from "@/hooks/i18n/useT";
import { Button } from "@/components/ui/button";

export function ConnectionWelcome({ onChoose }: { onChoose: (channel: string) => void }) {
  const t = useT();
  return (
    <>
      <header className="connection-hero relative grid items-center gap-2 md:grid-cols-[1.25fr_1fr]">
        <div className="relative z-10 py-4 md:py-10">
          <p className="mb-4 text-xs font-medium tracking-wide text-muted-foreground">
            {t("Conexões")}
          </p>
          <h1 className="artisan-title max-w-xl">{t("Cada conversa começa com uma conexão.")}</h1>
          <p className="mt-5 max-w-lg text-sm leading-7 text-muted-foreground">
            {t("Traga o WhatsApp e o Instagram para o mesmo lugar. A gente te guia na conexão.")}
          </p>
        </div>
        <Image
          src="/brand/conversation-art.png"
          width={1536}
          height={1024}
          alt=""
          priority
          className="artisan-illustration mx-auto -mt-5 h-28 w-auto max-w-sm rounded-3xl object-contain md:mt-0 md:h-auto md:w-full"
        />
      </header>
      <section
        aria-label={t("Escolha um canal")}
        className="overflow-hidden rounded-[28px] border bg-card shadow-[0_10px_45px_-30px_#173d2d30]"
      >
        {(
          [
            {
              symbol: "whatsapp",
              name: "WhatsApp",
              text: t("Conecte seu número e acompanhe as conversas da sua equipe."),
              action: t("Conectar WhatsApp"),
              target: "numeros",
              color: "channel-green",
            },
            {
              symbol: "instagram",
              name: "Instagram",
              text: t("Veja as opções para receber as mensagens do Instagram no atendimento."),
              action: t("Ver conexão do Instagram"),
              target: "sociais",
              color: "channel-coral",
            },
          ] as const
        ).map((channel) => (
          <div
            key={channel.target}
            className="flex flex-wrap items-center gap-4 border-b p-5 last:border-b-0 sm:flex-nowrap sm:gap-6 sm:p-7"
          >
            <span className={`channel-emblem ${channel.color}`}>
              <ArtisanIcon symbol={channel.symbol} className="h-8 w-8" />
            </span>
            <div className="min-w-0 flex-1 basis-40">
              <h2 className="text-lg font-medium tracking-tight">{channel.name}</h2>
              <p className="mt-1 max-w-md text-sm leading-6 text-muted-foreground">
                {channel.text}
              </p>
            </div>
            <Button
              variant="outline"
              onClick={() => onChoose(channel.target)}
              className="w-full shrink-0 rounded-full sm:w-auto"
            >
              {channel.action}
              <span aria-hidden>↗</span>
            </Button>
          </div>
        ))}
      </section>
      <p className="flex items-center gap-3 px-2 text-sm text-muted-foreground">
        <ArtisanIcon symbol="conversation" className="h-6 w-6 shrink-0" />
        {t("Você escolhe o canal. Nós mostramos o próximo passo.")}
      </p>
    </>
  );
}
