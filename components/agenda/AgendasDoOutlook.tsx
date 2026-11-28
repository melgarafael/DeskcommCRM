"use client";

import { useQuery } from "@tanstack/react-query";
import { useState } from "react";

import { showApiError } from "@/components/feedback/ApiErrorToast";
import { Button } from "@/components/ui/button";
import { useT } from "@/hooks/i18n/useT";
import { apiClient } from "@/lib/api/client";

interface CatalogoDoOutlook {
  connections: Array<{ id: string; account_email: string; status: string; last_sync_error: string | null }>;
  calendars: Array<{
    id: string;
    connection_id: string;
    name: string;
    counts_for_conflicts: boolean;
    last_sync_at: string | null;
    sync_error: string | null;
  }>;
}

/** Quais agendas do Outlook de quem está logado bloqueiam horário. */
export function AgendasDoOutlook({ configurado }: { configurado: boolean }) {
  const t = useT();
  const query = useQuery({
    queryKey: ["agenda", "outlook"],
    queryFn: async () =>
      (await apiClient.get<{ data: CatalogoDoOutlook }>("/api/v1/agenda/microsoft/calendarios")).data,
  });
  const [salvando, setSalvando] = useState<string | null>(null);

  if (query.isPending) return <p className="text-sm text-muted-foreground">{t("Carregando…")}</p>;
  if (query.isError)
    return (
      <p role="alert" className="text-sm text-warning">
        {t("Não foi possível carregar suas agendas.")}
      </p>
    );
  const { connections, calendars } = query.data;

  return (
    <section className="space-y-3" aria-label={t("Suas agendas do Outlook")}>
      <p className="text-sm text-muted-foreground">
        {t("Marque as agendas cujo horário ocupado deve ser descontado. A leitura é atualizada a cada poucos minutos, e o conteúdo dos eventos não é guardado.")}
      </p>
      {connections.map((conexao) => (
        <fieldset key={conexao.id} className="space-y-2 rounded-md border p-3">
          <legend className="px-1 text-sm font-medium">{conexao.account_email}</legend>
          {conexao.last_sync_error && (
            <p role="status" className="text-xs text-warning">{t(conexao.last_sync_error)}</p>
          )}
          {calendars
            .filter((c) => c.connection_id === conexao.id)
            .map((agenda) => (
              <label key={agenda.id} className="flex items-start gap-2 text-sm">
                <input
                  type="checkbox"
                  className="mt-1"
                  checked={agenda.counts_for_conflicts}
                  disabled={salvando !== null}
                  onChange={(e) => {
                    setSalvando(agenda.id);
                    void apiClient
                      .patch("/api/v1/agenda/microsoft/calendarios", {
                        calendar_id: agenda.id,
                        counts_for_conflicts: e.target.checked,
                      })
                      .then(() => query.refetch())
                      .catch(showApiError)
                      .finally(() => setSalvando(null));
                  }}
                />
                <span>
                  {agenda.name}
                  {agenda.sync_error && (
                    <span className="block text-xs text-warning">{t(agenda.sync_error)}</span>
                  )}
                </span>
              </label>
            ))}
        </fieldset>
      ))}
      {configurado && (
        <Button variant="outline" size="sm" asChild>
          <a href="/api/v1/agenda/microsoft/connect">
            {connections.length ? t("Conectar outra conta do Outlook") : t("Conectar Outlook")}
          </a>
        </Button>
      )}
    </section>
  );
}
