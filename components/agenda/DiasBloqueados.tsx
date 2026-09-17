"use client";
/**
 * A tela de fechar um dia.
 *
 * Existe porque `calendar_availability_exceptions` era respeitada pelo motor de
 * horários livres desde a migration 0177 e **não tinha como receber uma linha**:
 * nem rota, nem tela, nem action. Quem precisasse fechar a agenda num feriado
 * marcava um compromisso falso de dia inteiro — que polui a agenda, conta como
 * atendimento e aparece na timeline do lead.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { showApiError } from "@/components/feedback/ApiErrorToast";
import { Button } from "@/components/ui/button";
import { useT } from "@/hooks/i18n/useT";
import { apiClient } from "@/lib/api/client";

type Excecao = {
  id: string;
  exception_date: string;
  is_unavailable: boolean;
  start_minute: number;
  end_minute: number;
  reason: string | null;
};

const DIA_INTEIRO = { start_minute: 0, end_minute: 1440 };

/** "0..1440" vira "o dia todo"; o resto vira "09:00–12:00". */
function faixa(e: Excecao, t: (s: string) => string): string {
  if (e.start_minute === 0 && e.end_minute === 1440) return t("o dia todo");
  const hhmm = (m: number) =>
    `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
  return `${hhmm(e.start_minute)}–${hhmm(e.end_minute)}`;
}

export function DiasBloqueados({ podeEditar }: { podeEditar: boolean }) {
  const t = useT();
  const qc = useQueryClient();
  const [data, setData] = useState("");
  const [motivo, setMotivo] = useState("");

  const query = useQuery({
    queryKey: ["agenda", "excecoes"],
    queryFn: async () =>
      (await apiClient.get<{ data: Excecao[] }>("/api/v1/agenda/excecoes")).data,
  });

  const invalidar = () => {
    // A agenda também muda: um dia fechado tira horários da consulta.
    void qc.invalidateQueries({ queryKey: ["agenda"] });
  };

  const criar = useMutation({
    mutationFn: () =>
      apiClient.post("/api/v1/agenda/excecoes", {
        exception_date: data,
        is_unavailable: true,
        ...DIA_INTEIRO,
        ...(motivo.trim() ? { reason: motivo.trim() } : {}),
      }),
    onSuccess: () => {
      setData("");
      setMotivo("");
      invalidar();
    },
    onError: showApiError,
  });

  const remover = useMutation({
    mutationFn: (id: string) => apiClient.delete("/api/v1/agenda/excecoes", { id }),
    onSuccess: invalidar,
    onError: showApiError,
  });

  const lista = query.data ?? [];

  return (
    <section className="space-y-3 rounded-xl border p-4" data-testid="dias-bloqueados">
      <h2 className="font-semibold">{t("Dias sem atendimento")}</h2>
      <p className="text-sm text-text-muted">
        {t(
          "Feriado, férias, viagem. Nesses dias o sistema deixa de oferecer horários — e o que já estava marcado continua marcado, para você decidir o que fazer com cada um.",
        )}
      </p>

      {podeEditar ? (
        <div className="flex flex-wrap items-end gap-2">
          <label className="block">
            <span className="block text-sm">{t("Dia")}</span>
            <input
              aria-label={t("Dia")}
              className="mt-1 rounded-md border p-2"
              type="date"
              value={data}
              onChange={(e) => setData(e.target.value)}
            />
          </label>
          <label className="block flex-1">
            <span className="block text-sm">{t("Motivo (opcional)")}</span>
            <input
              aria-label={t("Motivo (opcional)")}
              className="mt-1 w-full rounded-md border p-2"
              maxLength={200}
              placeholder={t("Ex.: feriado")}
              value={motivo}
              onChange={(e) => setMotivo(e.target.value)}
            />
          </label>
          <Button
            // Alvo de toque generoso: esta tela também é usada no celular.
            className="min-h-11"
            disabled={!data || criar.isPending}
            onClick={() => criar.mutate()}
          >
            {t("Fechar este dia")}
          </Button>
        </div>
      ) : null}

      {query.isError ? (
        <Button variant="outline" onClick={() => void query.refetch()}>
          {t("Tentar novamente")}
        </Button>
      ) : query.isLoading ? (
        <p>{t("Carregando…")}</p>
      ) : lista.length === 0 ? (
        <p className="text-sm text-text-muted">{t("Nenhum dia fechado daqui para a frente.")}</p>
      ) : (
        <ul className="space-y-1">
          {lista.map((e) => (
            <li key={e.id} className="flex items-center justify-between gap-2 text-sm">
              <span>
                {new Date(`${e.exception_date}T12:00:00`).toLocaleDateString()} · {faixa(e, t)}
                {e.is_unavailable ? "" : ` · ${t("aberto excepcionalmente")}`}
                {e.reason ? ` · ${e.reason}` : ""}
              </span>
              {podeEditar ? (
                <Button
                  variant="ghost"
                  className="min-h-11"
                  disabled={remover.isPending}
                  onClick={() => remover.mutate(e.id)}
                >
                  {t("Reabrir")}
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
