"use client";

import { useState, type ReactNode } from "react";
import { useT } from "@/hooks/i18n/useT";
import styles from "./VisoesGoogleAds.module.css";

export function VisoesGoogleAds({ crm, midia }: { crm: ReactNode; midia: ReactNode }) {
  const t = useT();
  const [visao, setVisao] = useState<"crm" | "midia">("crm");
  const [midiaVisitada, setMidiaVisitada] = useState(false);
  return (
    <section className={styles.shell} data-superficie="clara" aria-labelledby="titulo-google-ads">
      <header className={styles.cabecalho}>
        <p className={styles.caminho}>{t("Análise")} <span aria-hidden="true">/</span> {t("Mídia paga")}</p>
        <h1 id="titulo-google-ads">Google Ads</h1>
        <nav className={styles.nav} aria-label={t("Visão do Google Ads")}>
          <button type="button" aria-pressed={visao === "crm"} onClick={() => setVisao("crm")}>
            {t("Resultados no CRM")}
          </button>
          <button type="button" aria-pressed={visao === "midia"} onClick={() => { setMidiaVisitada(true); setVisao("midia"); }}>
            {t("Desempenho no Google")}
          </button>
        </nav>
      </header>
      <div hidden={visao !== "crm"}>{crm}</div>
      <div hidden={visao !== "midia"}>{midiaVisitada && midia}</div>
    </section>
  );
}
