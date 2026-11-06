"use client";

import { useT } from "@/hooks/i18n/useT";
import { usePrevisaoFunil } from "@/hooks/metrics/usePrevisaoFunil";
import { formatValorDoNegocio } from "@/lib/money";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

/**
 * Painel "Previsão" de `/app/metrics` (issue #1535) — mês × moeda.
 *
 * Três regras de honestidade que a apresentação não pode quebrar:
 *
 * 1. **Moeda diferente não soma.** Cada moeda tem a sua coluna de saldo; não
 *    existe total único na tela, porque não existe na regra
 *    (`lib/leads/previsao.ts`).
 * 2. **"Sem data" e "sem probabilidade" aparecem.** São o que falta calibrar,
 *    não zero: somá-los em silêncio faria a promessa sumir com o valor que não
 *    foi contado.
 * 3. **Único e recorrência nova ficam LADO A LADO (fatia 2 da #3602).** O
 *    setup (`value_cents`) e a mensalidade (`recurring_value_cents`) são duas
 *    parcelas com colunas próprias; a tela nunca mostra 3.000 + 500 como 3.500,
 *    porque quem lê precisa saber o que entra uma vez e o que entra todo mês.
 */
export function PrevisaoPanel() {
  const t = useT();
  const { data, isLoading, isError } = usePrevisaoFunil();

  if (isLoading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-sm font-semibold">{t("Previsão")}</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">{t("Carregando…")}</p>
        </CardContent>
      </Card>
    );
  }

  if (isError || !data) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-sm font-semibold">{t("Previsão")}</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-destructive">{t("Erro ao carregar a previsão.")}</p>
        </CardContent>
      </Card>
    );
  }

  const vazia =
    data.meses.length === 0 &&
    data.sem_data.length === 0 &&
    data.sem_probabilidade.length === 0;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm font-semibold">{t("Previsão")}</CardTitle>
        <p className="text-xs text-muted-foreground">
          {data.fonte === "ia_quando_houver"
            ? t("Chance vinda da inteligência artificial quando existe, e da etapa quando não.")
            : t("Chance de fechamento definida em cada etapa do funil.")}
        </p>
        <p className="text-xs text-muted-foreground">
          {t("Valor único e recorrência nova por mês ficam lado a lado — nunca somados.")}
        </p>
      </CardHeader>
      <CardContent className="space-y-4">
        {vazia ? (
          <p className="text-sm text-muted-foreground">
            {t("Nenhum negócio aberto com valor neste funil.")}
          </p>
        ) : null}

        {/* A caixa que rola é a da tabela, não a tela: as colunas de valor em
            reais não quebram linha e passam dos 390px do celular. */}
        {data.meses.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left text-xs text-muted-foreground">
                  <th className="py-1 font-medium">{t("Mês")}</th>
                  <th className="py-1 font-medium">{t("Moeda")}</th>
                  <th className="py-1 text-right font-medium">
                    {t("Único")}
                    <span className="block font-normal">
                      {t("ponderado")} · {t("bruto")}
                    </span>
                  </th>
                  <th className="py-1 text-right font-medium">
                    {t("Recorrência/mês")}
                    <span className="block font-normal">
                      {t("ponderado")} · {t("bruto")}
                    </span>
                  </th>
                  <th className="py-1 text-right font-medium">{t("Negócios")}</th>
                </tr>
              </thead>
              <tbody>
                {data.meses.map((faixa) => (
                  <tr key={`${faixa.moeda}-${faixa.mes}`} className="border-b border-border/50">
                    <td className="py-1 tabular-nums">{faixa.mes}</td>
                    <td className="py-1">{faixa.moeda}</td>
                    {/* As duas parcelas em colunas SEPARADAS — a soma delas não
                        existe em célula nenhuma. */}
                    <td className="py-1 text-right tabular-nums">
                      <span className="block">
                        {formatValorDoNegocio(faixa.unico.ponderado_cents, faixa.moeda)}
                      </span>{" "}
                      <span className="block text-xs text-muted-foreground">
                        {formatValorDoNegocio(faixa.unico.bruto_cents, faixa.moeda)}
                      </span>
                    </td>
                    <td className="py-1 text-right tabular-nums">
                      <span className="block">
                        {formatValorDoNegocio(faixa.recorrente_mensal.ponderado_cents, faixa.moeda)}
                      </span>{" "}
                      <span className="block text-xs text-muted-foreground">
                        {formatValorDoNegocio(faixa.recorrente_mensal.bruto_cents, faixa.moeda)}
                      </span>
                    </td>
                    <td className="py-1 text-right tabular-nums">{faixa.n}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {data.sem_data.length > 0 && (
          <div className="text-sm">
            <p className="text-xs font-medium text-muted-foreground">
              {t("Sem data prevista — entram, mas sem mês no cronograma")}
            </p>
            {data.sem_data.map((balde) => (
              <div key={`sem-data-${balde.moeda}`} className="tabular-nums">
                <p>
                  {balde.moeda} · {balde.n} {t("negócios")}
                </p>
                <p className="text-xs text-muted-foreground">
                  {t("Único")}: {formatValorDoNegocio(balde.unico.ponderado_cents, balde.moeda)}{" "}
                  ({t("bruto")} {formatValorDoNegocio(balde.unico.bruto_cents, balde.moeda)}) ·{" "}
                  {t("Recorrência/mês")}:{" "}
                  {formatValorDoNegocio(balde.recorrente_mensal.ponderado_cents, balde.moeda)} (
                  {t("bruto")}{" "}
                  {formatValorDoNegocio(balde.recorrente_mensal.bruto_cents, balde.moeda)})
                </p>
              </div>
            ))}
          </div>
        )}

        {data.sem_probabilidade.length > 0 && (
          <div className="text-sm">
            <p className="text-xs font-medium text-muted-foreground">
              {t("Sem chance definida na etapa — falta calibrar")}
            </p>
            {data.sem_probabilidade.map((balde) => (
              <div key={`sem-prob-${balde.moeda}`} className="tabular-nums">
                <p>
                  {balde.moeda} · {balde.n} {t("negócios")}
                </p>
                <p className="text-xs text-muted-foreground">
                  {t("Único")}: {formatValorDoNegocio(balde.unico.bruto_cents, balde.moeda)} ·{" "}
                  {t("Recorrência/mês")}:{" "}
                  {formatValorDoNegocio(balde.recorrente_mensal.bruto_cents, balde.moeda)}
                </p>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
