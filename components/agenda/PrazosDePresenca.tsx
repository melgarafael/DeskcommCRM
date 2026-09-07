"use client";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { apiClient } from "@/lib/api/client";
import { Button } from "@/components/ui/button";
import { useT } from "@/hooks/i18n/useT";
import { showApiError } from "@/components/feedback/ApiErrorToast";
type Config = { confirmation_delay_minutes: number; unknown_protection_minutes: number };
export function PrazosDePresenca({ podeEditar }: { podeEditar: boolean }) {
  const t = useT();
  const qc = useQueryClient();
  const [draft, setDraft] = useState<Config | null>(null);
  const query = useQuery({
    queryKey: ["agenda", "configuracao"],
    queryFn: async () =>
      (await apiClient.get<{ data: Config }>("/api/v1/agenda/configuracao")).data,
  });
  const mutation = useMutation({
    mutationFn: (value: Config) => apiClient.patch("/api/v1/agenda/configuracao", value),
    onSuccess: () => {
      setDraft(null);
      void qc.invalidateQueries({ queryKey: ["agenda", "configuracao"] });
    },
    onError: showApiError,
  });
  const value = draft ?? query.data;
  return (
    <section className="space-y-3 rounded-xl border p-4">
      <h2 className="font-semibold">{t("Confirmação de presença")}</h2>
      <p className="text-sm text-text-muted">
        {t(
          "Depois do compromisso, peça confirmação à equipe. Sem confirmação, o sistema mantém a presença desconhecida e nunca presume falta.",
        )}
      </p>
      {query.isError ? (
        <Button variant="outline" onClick={() => void query.refetch()}>
          {t("Tentar novamente")}
        </Button>
      ) : value ? (
        <>
          <label className="block">
            {t("Pedir confirmação após o fim (minutos)")}
            <input
              aria-label={t("Pedir confirmação após o fim (minutos)")}
              className="ml-2 w-24 rounded-md border p-2"
              type="number"
              min={1}
              max={10080}
              disabled={!podeEditar}
              value={value.confirmation_delay_minutes}
              onChange={(e) =>
                setDraft({ ...value, confirmation_delay_minutes: Number(e.target.value) })
              }
            />
          </label>
          <label className="block">
            {t("Proteger de cobranças por silêncio após o fim (minutos)")}
            <input
              aria-label={t("Proteger de cobranças por silêncio após o fim (minutos)")}
              className="ml-2 w-24 rounded-md border p-2"
              type="number"
              min={1}
              max={10080}
              disabled={!podeEditar}
              value={value.unknown_protection_minutes}
              onChange={(e) =>
                setDraft({ ...value, unknown_protection_minutes: Number(e.target.value) })
              }
            />
          </label>
          <p className="text-sm">
            {t(
              "Quando esse prazo acabar, a pendência continua visível. Outro compromisso vivo ainda protege o contato.",
            )}
          </p>
          {podeEditar ? (
            <Button disabled={!draft || mutation.isPending} onClick={() => mutation.mutate(value)}>
              {t("Salvar prazos")}
            </Button>
          ) : null}
          {mutation.isSuccess && !draft ? <p role="status">{t("Prazos salvos.")}</p> : null}
        </>
      ) : (
        <p>{t("Carregando…")}</p>
      )}
    </section>
  );
}
