"use client";

import { useT } from "@/hooks/i18n/useT";
import { useLocaleDeData } from "@/hooks/i18n/useLocaleDeData";
import { format } from "date-fns";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { safePublicLink, type ProspectEnrichment } from "@/lib/prospecting/schema";

function BusinessLink({ value, label }: { value: string | null; label?: string }) {
  const href = safePublicLink(value);
  if (!href) return null;
  const host = new URL(href).hostname.replace(/^www\./, "");
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="block break-all underline underline-offset-2"
    >
      {label ?? host}
    </a>
  );
}

export function LeadEnrichment({
  data,
  loading,
  error,
  onRetry,
}: {
  data: (ProspectEnrichment & { collected_at: string }) | null;
  loading: boolean;
  error: boolean;
  onRetry: () => void;
}) {
  const t = useT();
  const locale = useLocaleDeData();
  const collected = data ? new Date(data.collected_at) : null;
  return (
    <section data-testid="inbox-enrichment" className="min-w-0 rounded-lg border p-3 text-xs">
      <h3 className="font-semibold">{t("Sobre a empresa")}</h3>
      {error ? (
        <div className="mt-2 space-y-2">
          <p className="text-muted-foreground">
            {t("Não foi possível carregar o enriquecimento.")}
          </p>
          <Button size="sm" variant="outline" onClick={onRetry}>
            {t("Tentar novamente")}
          </Button>
        </div>
      ) : loading ? (
        <Skeleton className="mt-2 h-20 w-full" />
      ) : !data ? (
        <p className="mt-2 text-muted-foreground">
          {t("Sem dados de enriquecimento para este contato.")}
        </p>
      ) : (
        <div className="mt-3 space-y-3">
          <div>
            <p className="font-medium break-words">{data.name}</p>
            {data.category && <p className="mt-1 text-muted-foreground">{data.category}</p>}
          </div>
          {data.address && (
            <div>
              <h4 className="text-muted-foreground">{t("Endereço")}</h4>
              <p className="mt-1 break-words">{data.address}</p>
            </div>
          )}
          {(data.rating !== null || data.reviews !== null) && (
            <div>
              <h4 className="text-muted-foreground">{t("Avaliações no Google")}</h4>
              <p className="mt-1">
                {data.rating !== null && <span>{data.rating} / 5</span>}
                {data.rating !== null && data.reviews !== null && " · "}
                {data.reviews !== null && (
                  <span>
                    {data.reviews} {t("avaliações")}
                  </span>
                )}
              </p>
            </div>
          )}
          {safePublicLink(data.website) && (
            <div>
              <h4 className="mb-1 text-muted-foreground">{t("Site")}</h4>
              <BusinessLink value={data.website} />
            </div>
          )}
          {data.emails.length > 0 && (
            <div>
              <h4 className="mb-1 text-muted-foreground">{t("E-mails comerciais")}</h4>
              {Array.from(new Set(data.emails)).map((email) => (
                <p className="break-all" key={email}>
                  {email}
                </p>
              ))}
            </div>
          )}
          {data.socials.some((url) => safePublicLink(url)) && (
            <div>
              <h4 className="mb-1 text-muted-foreground">{t("Redes sociais")}</h4>
              {Array.from(new Set(data.socials)).map((url) => (
                <BusinessLink
                  key={url}
                  value={url}
                  label={
                    safePublicLink(url)
                      ? new URL(url).hostname.replace(/^www\./, "") +
                        new URL(url).pathname.replace(/\/$/, "")
                      : undefined
                  }
                />
              ))}
            </div>
          )}
          <div className="space-y-1 border-t pt-2 text-muted-foreground">
            <p>
              {t("Fonte: pesquisa de empresas")}
              {collected &&
                !Number.isNaN(collected.getTime()) &&
                ` · ${format(collected, "P", { locale })}`}
            </p>
            <BusinessLink value={data.maps_url} label={t("Ver no Google Maps")} />
            <p>{t("Dados públicos coletados na busca; podem ter mudado.")}</p>
          </div>
        </div>
      )}
    </section>
  );
}
