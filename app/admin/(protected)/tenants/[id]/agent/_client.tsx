"use client";

import { useTagDeIdioma } from "@/hooks/i18n/useLocaleDeData";

import { Skeleton } from "@/components/ui/skeleton";
import { useTenantAgent } from "@/hooks/useTenantAgent";
import { ArrowsClockwise } from "@/lib/ui/icons";
import { useT } from "@/hooks/i18n/useT";

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface TenantAgentClientProps {
  id: string;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function TenantAgentClient({ id }: TenantAgentClientProps) {
  const tagDoIdioma = useTagDeIdioma();
  const t = useT();
  const { data, isLoading, isError, isFetching, dataUpdatedAt } = useTenantAgent(id);

  if (isLoading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-28 rounded-xl" />
        <Skeleton className="h-28 rounded-xl" />
      </div>
    );
  }

  if (isError || !data?.data) {
    return (
      <div className="rounded-lg border border-destructive/30 bg-destructive/5 px-6 py-10 text-center text-sm text-destructive">
        {t("Não foi possível carregar o agente do tenant. Tente recarregar a página.")}
      </div>
    );
  }

  const agentes = data.data.agents;
  const atualizadoEm = dataUpdatedAt
    ? new Intl.DateTimeFormat(tagDoIdioma, {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      }).format(new Date(dataUpdatedAt))
    : null;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold tracking-wider text-muted-foreground uppercase">
          {t("Agente")}
        </h2>
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          {isFetching && <ArrowsClockwise size={13} className="animate-spin" aria-hidden />}
          {atualizadoEm && (
            <span>
              {t("Atualizado às")} {atualizadoEm}
            </span>
          )}
        </div>
      </div>

      {agentes.length === 0 ? (
        <div className="rounded-lg border px-6 py-10 text-center text-sm text-muted-foreground">
          {t("Nenhum agente publicado")}
        </div>
      ) : (
        <ul className="space-y-3">
          {agentes.map((agente) => (
            <li key={agente.id} className="rounded-xl border px-5 py-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-sm font-medium">{agente.name}</span>
                <span className="text-xs text-muted-foreground">
                  {agente.is_active ? t("Ativo") : t("Inativo")}
                </span>
              </div>

              <dl className="mt-3 grid grid-cols-1 gap-3 text-xs sm:grid-cols-3">
                <div>
                  <dt className="tracking-wider text-muted-foreground uppercase">{t("Tipo")}</dt>
                  <dd className="mt-1">{agente.kind}</dd>
                </div>
                <div>
                  <dt className="tracking-wider text-muted-foreground uppercase">
                    {t("Versão publicada")}
                  </dt>
                  <dd className="mt-1">
                    {agente.published_version
                      ? `v${agente.published_version.version_number} · ${agente.published_version.provider} · ${agente.published_version.model}`
                      : t("Nenhum agente publicado")}
                  </dd>
                </div>
                <div>
                  <dt className="tracking-wider text-muted-foreground uppercase">
                    {t("Publicado em")}
                  </dt>
                  <dd className="mt-1">
                    {agente.published_version?.published_at
                      ? new Intl.DateTimeFormat(tagDoIdioma, {
                          dateStyle: "short",
                          timeStyle: "short",
                        }).format(new Date(agente.published_version.published_at))
                      : "—"}
                  </dd>
                </div>
              </dl>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
