"use client";

/**
 * A EVOLUÇÃO DOS GANHOS no Desempenho (issue #3024, fatia 1).
 *
 * A tela mostrava só número e tabela — dava para saber QUANTO, não PARA ONDE
 * ESTÁ INDO. Este painel entrega a TENDÊNCIA: um gráfico de linha com a
 * quantidade de ganhos por balde de tempo (dia, semana ou mês) e, logo abaixo,
 * no MESMO `Card`, a tabela desses mesmos baldes. Nenhum número que já estava
 * na tela é tocado: a série é um recorte novo, não uma segunda versão do que
 * os outros painéis dizem.
 *
 * O balde sem ganho APARECE com zero — a conta (`lib/metrics/serie-temporal`)
 * nasce dos baldes da janela, não dos dias com ganho, justamente para o vale
 * não sumir do gráfico. Aqui só se apresenta.
 */
import { useState } from "react";
import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useTagDeIdioma } from "@/hooks/i18n/useLocaleDeData";
import { useT } from "@/hooks/i18n/useT";
import { useSerieTemporal } from "@/hooks/metrics/useSerieTemporal";
import { granularidadeValida, type Granularidade } from "@/lib/metrics/serie-temporal";

/**
 * O rótulo do balde na data: `AAAA-MM` vira mês/ano, `AAAA-MM-DD` vira dia/mês.
 * O idioma é o da sessão — o `Intl` do browser segue o `tagDeIdioma` do produto,
 * nunca um "pt-BR" escrito à mão.
 */
function rotuloDoBalde(balde: string, tagDoIdioma: string): string {
  const dia = balde.length === 7 ? `${balde}-01` : balde;
  const d = new Date(`${dia}T00:00:00`);
  if (Number.isNaN(d.getTime())) return balde;
  return balde.length === 7
    ? d.toLocaleDateString(tagDoIdioma, { month: "2-digit", year: "numeric" })
    : d.toLocaleDateString(tagDoIdioma, { day: "2-digit", month: "2-digit" });
}

export function SeriePanel() {
  const t = useT();
  const tagDoIdioma = useTagDeIdioma();
  const [granularidade, setGranularidade] = useState<Granularidade>("dia");
  const { data, isLoading, isError } = useSerieTemporal(granularidade);

  if (isLoading) {
    return (
      <div className="flex flex-col gap-2" aria-busy="true" aria-label={t("Ganhos por período")}>
        <Skeleton className="h-5 w-40" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  if (isError || !data) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t("Ganhos por período")}</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-destructive">
            {t("Erro ao carregar a evolução dos ganhos.")}
          </p>
        </CardContent>
      </Card>
    );
  }

  const serie = data.data;
  const baldes = serie.baldes;
  const formatar = (n: number) => n.toLocaleString(tagDoIdioma);

  return (
    <Card>
      <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2 space-y-0">
        <CardTitle className="text-base">
          {t("Ganhos por período")} · {serie.total}
        </CardTitle>
        <Select
          value={granularidade}
          onValueChange={(v) => {
            if (granularidadeValida(v)) setGranularidade(v);
          }}
        >
          <SelectTrigger className="w-32 md:w-40" aria-label={t("Granularidade")}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="dia">{t("Dia")}</SelectItem>
            <SelectItem value="semana">{t("Semana")}</SelectItem>
            <SelectItem value="mes">{t("Mês")}</SelectItem>
          </SelectContent>
        </Select>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {baldes.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("Sem ganhos no período.")}</p>
        ) : (
          <>
            <div data-testid="ganhos-no-tempo" className="h-64 w-full">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart
                  data={baldes}
                  margin={{ top: 4, right: 8, bottom: 0, left: 0 }}
                >
                  <CartesianGrid strokeDasharray="3 3" className="stroke-border/50" />
                  <XAxis
                    dataKey="balde"
                    tickFormatter={(v: string) => rotuloDoBalde(v, tagDoIdioma)}
                    tick={{ fontSize: 11 }}
                    tickLine={false}
                    axisLine={false}
                    interval="preserveStartEnd"
                  />
                  <YAxis
                    tick={{ fontSize: 11 }}
                    tickLine={false}
                    axisLine={false}
                    allowDecimals={false}
                    tickFormatter={formatar}
                    width={45}
                  />
                  <Tooltip
                    formatter={(value) => [formatar(Number(value)), t("Ganhos")]}
                    labelFormatter={(label) => rotuloDoBalde(String(label), tagDoIdioma)}
                    contentStyle={{
                      borderRadius: "8px",
                      fontSize: "12px",
                      // Tokens de verdade do globals.css: `--border` resolve
                      // para hex e `hsl()` não aceita hex — a borda sumia.
                      border: "1px solid var(--color-border)",
                      background: "var(--color-surface)",
                    }}
                  />
                  <Line
                    type="monotone"
                    dataKey="ganhos"
                    // `--accent` não existe no globals.css: o `hsl()` em volta dele
                    // computava `none` e a linha não aparecia. `--color-accent`
                    // segue a marca do revendedor.
                    stroke="var(--color-accent)"
                    strokeWidth={2}
                    dot={false}
                  />
                </LineChart>
              </ResponsiveContainer>
            </div>

            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("Período")}</TableHead>
                  <TableHead className="text-right">{t("Ganhos")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {baldes.map((b) => (
                  <TableRow key={b.balde}>
                    <TableCell className="font-medium tabular-nums">
                      {rotuloDoBalde(b.balde, tagDoIdioma)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{formatar(b.ganhos)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            {serie.truncado && (
              <p className="text-xs text-muted-foreground">
                {t("Série cortada no teto de leitura.")}
              </p>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
