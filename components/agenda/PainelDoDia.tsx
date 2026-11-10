"use client";

import * as React from "react";
import { useQuery } from "@tanstack/react-query";

import { Button } from "@/components/ui/button";
import { useTagDeIdioma } from "@/hooks/i18n/useLocaleDeData";
import { useT } from "@/hooks/i18n/useT";
import { apiClient } from "@/lib/api/client";
import type { PainelDoDia as Painel } from "@/lib/agenda/painel-do-dia";

/**
 * O PAINEL DO DIA — leitura, e só leitura (issue #4029, saída 3).
 *
 * Numa visão de dia, a pergunta da recepção é "quantas reservas, quantas pessoas
 * e quantas já confirmaram?" — hoje ela é respondida abrindo turma por turma.
 * Este painel responde as três de uma vez, por turma, e não oferece NENHUM botão
 * que mude dado: confirmar, remarcar e cancelar continuam no card da reserva
 * (`ReservasColetivas`), com o `revision` que a tela já carrega. Um painel que
 * também escrevesse obrigaria quem só quer olhar o dia a ter permissão de
 * escrita.
 *
 * O dia vem do pai (`diaLocalISO(ancora, fusoDaAgenda)`) e a rota o recorta no
 * fuso da ORGANIZAÇÃO — a mesma régua da grade. `percentual === null` significa
 * "não há reserva para dividir" e é mostrado como "—"; zero por cento é outra
 * coisa (há reservas, nenhuma confirmada) e aparece como 0%.
 */
export function PainelDoDia({ dia, fuso }: { dia: string; fuso: string }) {
  const t = useT();
  const locale = useTagDeIdioma();

  const consulta = useQuery({
    queryKey: ["agenda", "painel-do-dia", dia, fuso],
    queryFn: async () => {
      const resposta = await apiClient.get<{ data: Painel }>(
        `/api/v1/agenda/painel-do-dia?dia=${encodeURIComponent(dia)}`,
      );
      return resposta.data;
    },
  });

  const painel = consulta.data;
  const hora = (instante: string) =>
    new Date(instante).toLocaleTimeString(locale, { timeZone: fuso, hour: "2-digit", minute: "2-digit" });

  return (
    <section
      aria-labelledby="painel-do-dia-titulo"
      className="shrink-0 rounded-lg border border-border bg-surface p-4"
      data-testid="painel-do-dia"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="painel-do-dia-titulo" className="font-medium">
          {t("Painel do dia")}
        </h2>
        <p className="text-xs text-text-muted">
          {t("Reservas por turma neste dia, no fuso da organização.")}
        </p>
      </div>

      {consulta.isError ? (
        <div role="alert" className="space-y-2 pt-3">
          <p>{t("Não foi possível ler o painel do dia.")}</p>
          <Button variant="outline" size="sm" onClick={() => void consulta.refetch()}>
            {t("Tentar novamente")}
          </Button>
        </div>
      ) : null}

      {consulta.isLoading ? <p className="pt-3 text-sm">{t("Carregando…")}</p> : null}

      {painel?.vazio ? (
        <p className="pt-3 text-sm text-text-muted">{t("Nenhuma reserva de turma neste dia.")}</p>
      ) : null}

      {painel && !painel.vazio ? (
        <div className="space-y-2 pt-3">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-text-muted">
                  <th scope="col" className="py-1 pr-3 font-medium">
                    {t("Turma")}
                  </th>
                  <th scope="col" className="py-1 pr-3 font-medium">
                    {t("Reservas")}
                  </th>
                  <th scope="col" className="py-1 pr-3 font-medium">
                    {t("Pessoas esperadas")}
                  </th>
                  <th scope="col" className="py-1 pr-3 font-medium">
                    {t("Confirmadas")}
                  </th>
                  <th scope="col" className="py-1 font-medium">
                    {t("Confirmadas (%)")}
                  </th>
                </tr>
              </thead>
              <tbody>
                {painel.linhas.map((linha) => (
                  <tr key={linha.turmaId} className="border-t border-border">
                    <td className="py-1 pr-3">
                      <span className="font-medium">{linha.turma ?? t("Turma")}</span>{" "}
                      <span className="text-text-muted">
                        {hora(linha.inicio)}–{hora(linha.fim)}
                      </span>
                      {linha.capacidade != null ? (
                        <span className="text-text-muted">
                          {" "}
                          · {t("Capacidade")} {linha.capacidade}
                        </span>
                      ) : null}
                    </td>
                    <td className="py-1 pr-3">{linha.reservas}</td>
                    <td className="py-1 pr-3">{linha.pessoasEsperadas}</td>
                    <td className="py-1 pr-3">{linha.confirmadas}</td>
                    <td className="py-1">{linha.percentual == null ? "—" : `${linha.percentual}%`}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="border-t border-border font-medium">
                  <td className="py-1 pr-3">{t("Total do dia")}</td>
                  <td className="py-1 pr-3">{painel.totais.reservas}</td>
                  <td className="py-1 pr-3">{painel.totais.pessoasEsperadas}</td>
                  <td className="py-1 pr-3">{painel.totais.confirmadas}</td>
                  <td className="py-1">{painel.totais.percentual == null ? "—" : `${painel.totais.percentual}%`}</td>
                </tr>
              </tfoot>
            </table>
          </div>
          <p className="text-xs text-text-muted">
            {t("Pessoas esperadas soma as pessoas das reservas pendentes e confirmadas; canceladas e faltas ficam fora. Só leitura.")}
          </p>
          {painel.truncado ? (
            <p role="status" className="text-xs">
              {t("O dia passou do teto de 500 reservas: os totais cobrem só esta leitura.")}
            </p>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
