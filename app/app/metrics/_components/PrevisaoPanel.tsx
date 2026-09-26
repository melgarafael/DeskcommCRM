"use client";

import { useT } from "@/hooks/i18n/useT";
import { usePrevisaoFunil } from "@/hooks/metrics/usePrevisaoFunil";
import { formatCents } from "@/lib/money";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

/**
 * Painel "Previsão" de `/app/metrics` (issue #1535) — mês × moeda.
 *
 * Duas regras de honestidade que a apresentação não pode quebrar:
 *
 * 1. **Moeda diferente não soma.** Cada moeda tem a sua coluna de saldo; não
 *    existe total único na tela, porque não existe na regra
 *    (`lib/leads/previsao.ts`).
 * 2. **"Sem data" e "sem probabilidade" aparecem.** São o que falta calibrar,
 *    não zero: somá-los em silêncio faria a promessa sumir com o valor que não
 *    foi contado.
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
      </CardHeader>
      <CardContent className="space-y-4">
        {vazia ? (
          <p className="text-sm text-muted-foreground">
            {t("Nenhum negócio aberto com valor neste funil.")}
          </p>
        ) : null}

        {data.meses.length > 0 && (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-left text-xs text-muted-foreground">
                <th className="py-1 font-medium">{t("Mês")}</th>
                <th className="py-1 font-medium">{t("Moeda")}</th>
                <th className="py-1 text-right font-medium">{t("Ponderado")}</th>
                <th className="py-1 text-right font-medium">{t("Bruto")}</th>
                <th className="py-1 text-right font-medium">{t("Negócios")}</th>
              </tr>
            </thead>
            <tbody>
              {data.meses.map((faixa) => (
                <tr key={`${faixa.moeda}-${faixa.mes}`} className="border-b border-border/50">
                  <td className="py-1 tabular-nums">{faixa.mes}</td>
                  <td className="py-1">{faixa.moeda}</td>
                  <td className="py-1 text-right tabular-nums">
                    {formatCents(faixa.ponderado_cents, faixa.moeda)}
                  </td>
                  <td className="py-1 text-right tabular-nums text-muted-foreground">
                    {formatCents(faixa.bruto_cents, faixa.moeda)}
                  </td>
                  <td className="py-1 text-right tabular-nums">{faixa.n}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        {data.sem_data.length > 0 && (
          <div className="text-sm">
            <p className="text-xs font-medium text-muted-foreground">
              {t("Sem data prevista — entram, mas sem mês no cronograma")}
            </p>
            {data.sem_data.map((balde) => (
              <p key={`sem-data-${balde.moeda}`} className="tabular-nums">
                {balde.moeda}: {formatCents(balde.ponderado_cents, balde.moeda)} ·{" "}
                {t("bruto")} {formatCents(balde.bruto_cents, balde.moeda)} · {balde.n}{" "}
                {t("negócios")}
              </p>
            ))}
          </div>
        )}

        {data.sem_probabilidade.length > 0 && (
          <div className="text-sm">
            <p className="text-xs font-medium text-muted-foreground">
              {t("Sem chance definida na etapa — falta calibrar")}
            </p>
            {data.sem_probabilidade.map((balde) => (
              <p key={`sem-prob-${balde.moeda}`} className="tabular-nums">
                {balde.moeda}: {formatCents(balde.bruto_cents, balde.moeda)} · {balde.n}{" "}
                {t("negócios")}
              </p>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
