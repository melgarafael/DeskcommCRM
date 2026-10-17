"use client";

import { format } from "date-fns";

import { AnuncioCard, type AnuncioParaMostrar } from "@/components/inbox/AnuncioCard";
import { useHierarquiaDoAnuncio } from "@/hooks/contacts/useHierarquiaDoAnuncio";
import { useLocaleDeData } from "@/hooks/i18n/useLocaleDeData";
import { useT } from "@/hooks/i18n/useT";

export type AnuncioDeOrigem = AnuncioParaMostrar & { ad_id: string | null; capturado_em: string | null };
export type AnuncioMaisRecente = AnuncioParaMostrar & { ad_id: string | null; recebido_em: string };

/**
 * De qual anúncio a pessoa veio — no painel, sem abrir a ficha do contato.
 *
 * Os dados vêm do `crm-summary` (a mesma leitura do resto do painel). O nome da
 * campanha, do conjunto e do anúncio é pedido à parte, como na ficha
 * (`useHierarquiaDoAnuncio`): só existe quando a organização conectou a conta
 * de anúncios, e sem ela o cartão segue com título, texto, imagem e link.
 */
export function AnuncioDoContato({
  contactId,
  origem,
  recente,
}: {
  contactId: string;
  origem: AnuncioDeOrigem | null;
  recente: AnuncioMaisRecente | null;
}) {
  const t = useT();
  const localeDaData = useLocaleDeData();
  const hierarquia = useHierarquiaDoAnuncio(contactId, Boolean(origem?.ad_id));
  if (!origem && !recente) return null;

  const quando = (iso: string | null) => {
    if (!iso) return null;
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? null : format(d, "dd/MM/yyyy HH:mm", { locale: localeDaData });
  };
  const nomes = [
    [t("Campanha"), hierarquia.data?.campaign_name],
    [t("Conjunto"), hierarquia.data?.adset_name],
    [t("Anúncio"), hierarquia.data?.ad_name],
  ].filter((par): par is [string, string] => typeof par[1] === "string" && par[1].trim() !== "");

  return (
    <section data-testid="inbox-anuncio">
      <h3 className="text-xs font-semibold text-text">
        {origem ? t("Anúncio de origem") : t("Anúncio")}
      </h3>
      {origem && (
        <div className="mt-2 space-y-1.5">
          <AnuncioCard anuncio={origem} />
          {nomes.length > 0 && (
            <dl className="space-y-0.5 text-[11px]">
              {nomes.map(([rotulo, valor]) => (
                <div key={rotulo} className="flex gap-1">
                  <dt className="shrink-0 text-muted-foreground">{rotulo}:</dt>
                  <dd className="min-w-0 truncate">{valor}</dd>
                </div>
              ))}
            </dl>
          )}
          {quando(origem.capturado_em) && (
            <p className="text-[11px] text-muted-foreground">
              {t("Clicou em {data}").replace("{data}", quando(origem.capturado_em)!)}
            </p>
          )}
        </div>
      )}
      {recente && (
        <div className="mt-3 space-y-1.5">
          {origem && (
            <div className="text-[11px] font-medium text-muted-foreground">{t("Voltou por outro anúncio")}</div>
          )}
          <AnuncioCard anuncio={recente} />
          {quando(recente.recebido_em) && (
            <p className="text-[11px] text-muted-foreground">
              {t("Clicou em {data}").replace("{data}", quando(recente.recebido_em)!)}
            </p>
          )}
        </div>
      )}
    </section>
  );
}
