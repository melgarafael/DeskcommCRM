"use client";

import Link from "next/link";

import { FaixaDoTesteGratis } from "@/components/cobranca/FaixaDoTesteGratis";
import { useT } from "@/hooks/i18n/useT";
import type { FaixaDaCobranca as Faixa } from "@/lib/cobranca/faixa";
import { formatadorDeData } from "@/lib/cobranca/fuso";
import { linkDePagamentoSeguro } from "@/lib/cobranca/link";
import { useIdioma } from "@/lib/i18n/IdiomaProvider";

const PAINEL = "/app/settings/billing";

/**
 * A faixa da cobrança em `/app` (spec §9). É porta, não trava: leva a pagar em
 * um clique (o link da fatura) ou ao painel do plano. Só o admin a vê.
 */
export function FaixaDaCobranca({ faixa, fuso = null }: { faixa: Exclude<Faixa, null>; fuso?: string | null }) {
  const t = useT();
  const idioma = useIdioma();
  const dia = (v: string | null) => (v ? formatadorDeData(idioma, fuso, { day: "2-digit", month: "2-digit" }).format(new Date(v)) : "");
  if (faixa.tipo === "teste") return <FaixaDoTesteGratis dias={faixa.dias} />;

  const urgente = faixa.tipo === "atraso" || faixa.tipo === "teste_acabou" || faixa.tipo === "avise_o_admin";
  const estilo = urgente || faixa.tipo === "cancelada" ? "border-error-fg/30 bg-error-bg text-error-fg" : "border-info-fg/30 bg-info-bg text-info-fg";
  const texto =
    faixa.tipo === "atraso"
      ? faixa.desde
        ? t("Não identificamos o pagamento de {data}.").replace("{data}", dia(faixa.desde))
        : t("Há um pagamento em aberto.")
      : faixa.tipo === "teste_acabou"
        ? t("Seu teste grátis acabou em {data}. Assine para continuar usando.").replace("{data}", dia(faixa.desde))
        : faixa.tipo === "avise_o_admin"
          ? t("Há um pagamento pendente desta empresa. Avise quem administra para evitar a suspensão.")
          : faixa.tipo === "cancelamento"
            ? t("Sua assinatura termina em {data}.").replace("{data}", dia(faixa.ate))
            : t("Sua assinatura foi cancelada.");
  const linkSeguro = faixa.tipo === "atraso" ? linkDePagamentoSeguro(faixa.link) : null;
  const acao =
    faixa.tipo === "avise_o_admin" ? null : linkSeguro ? (
      <a href={linkSeguro} target="_blank" rel="noopener noreferrer" className="font-semibold underline">
        {t("Pagar agora")}
      </a>
    ) : (
      <Link href={PAINEL} className="font-semibold underline">
        {t(faixa.tipo === "atraso" ? "Pagar agora" : faixa.tipo === "teste_acabou" ? "Assinar" : "Assinar de novo")}
      </Link>
    );

  return (
    <div role={urgente ? "alert" : "status"} className={`flex flex-wrap items-center justify-center gap-3 border-b px-4 py-2 text-sm ${estilo}`}>
      <span>{texto}</span>
      {acao}
    </div>
  );
}
