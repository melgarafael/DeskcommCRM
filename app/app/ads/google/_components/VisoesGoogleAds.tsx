"use client";

import { useState, type ReactNode } from "react";
import { useT } from "@/hooks/i18n/useT";

export function VisoesGoogleAds({ crm, midia }: { crm: ReactNode; midia: ReactNode }) {
  const t = useT();
  const [visao, setVisao] = useState<"crm" | "midia">("crm");
  const [midiaVisitada, setMidiaVisitada] = useState(false);
  return (
    <section
      className="min-h-full bg-bg p-4 text-text sm:p-[clamp(16px,3vw,42px)] [&>div]:mx-auto [&>div]:max-w-[1220px]"
      data-superficie="clara"
      aria-labelledby="titulo-google-ads"
    >
      <header className="mx-auto max-w-[1220px] [&_h1]:mt-2 [&_h1]:mb-4 [&_h1]:text-[clamp(30px,3vw,42px)] [&_h1]:leading-tight [&_h1]:font-semibold [&_h1]:tracking-tight">
        <p className="flex items-center gap-2.5 text-[13px] text-muted-foreground [&_span]:text-text-subtle">
          {t("Análise")} <span aria-hidden="true">/</span> {t("Mídia paga")}
        </p>
        <h1 id="titulo-google-ads">Google Ads</h1>
        <nav
          className="mb-3.5 flex gap-[clamp(13px,3vw,28px)] overflow-x-auto border-b border-border sm:mb-[23px] [&_button]:cursor-pointer [&_button]:border-b-[3px] [&_button]:border-transparent [&_button]:bg-transparent [&_button]:pt-2.5 [&_button]:pb-3 [&_button]:text-sm [&_button]:font-semibold [&_button]:whitespace-nowrap [&_button]:text-muted-foreground [&_button:focus-visible]:outline-2 [&_button:focus-visible]:outline-offset-2 [&_button:focus-visible]:outline-accent [&_button:hover]:text-accent [&_button[aria-pressed=true]]:border-accent [&_button[aria-pressed=true]]:text-accent"
          aria-label={t("Visão do Google Ads")}
        >
          <button type="button" aria-pressed={visao === "crm"} onClick={() => setVisao("crm")}>
            {t("Resultados no CRM")}
          </button>
          <button
            type="button"
            aria-pressed={visao === "midia"}
            onClick={() => {
              setMidiaVisitada(true);
              setVisao("midia");
            }}
          >
            {t("Desempenho no Google")}
          </button>
        </nav>
      </header>
      <div hidden={visao !== "crm"}>{crm}</div>
      <div hidden={visao !== "midia"}>{midiaVisitada && midia}</div>
    </section>
  );
}
