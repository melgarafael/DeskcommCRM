"use client";

/**
 * Relatório "PERDAS" (issue #1537) — por motivo, por categoria e pela etapa de
 * onde o negócio saiu, em quantidade e em valor POR MOEDA.
 *
 * As tabelas são as chaves de `agruparPerdas`, na ordem que ela devolve (maior
 * primeiro): a conta mora em `lib/metrics/perdas.ts`, testada, e esta tela só
 * apresenta — reimplementar a soma aqui faria a tela e o teste dizerem coisas
 * diferentes.
 *
 * Só manager+ (a rota é manager+): é o funil inteiro, não o pedaço de quem
 * olha.
 */
import { useT } from "@/hooks/i18n/useT";
import { rotuloDoMotivoDePerda } from "@/lib/schemas/leads";
import { SEM_CATEGORIA, SEM_ETAPA, SEM_MOEDA, SEM_MOTIVO } from "@/lib/metrics/perdas";
import { usePerdasMetrics } from "@/hooks/metrics/usePerdasMetrics";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

function formataMoeda(moeda: string, cents: number): string {
  if (!/^[A-Z]{3}$/.test(moeda)) return "—";
  try {
    return new Intl.NumberFormat("pt-BR", { style: "currency", currency: moeda }).format(
      cents / 100,
    );
  } catch {
    return `${(cents / 100).toFixed(2)} ${moeda}`;
  }
}

/** Os rótulos que o SERVIDOR põe no lugar da ausência: texto do produto, traduzível. */
const SENTINELAS = new Set<string>([SEM_MOTIVO, SEM_CATEGORIA, SEM_ETAPA, SEM_MOEDA]);

function Bloco({
  titulo,
  linhas,
  coluna,
  rotulo = (chave) => chave,
}: {
  titulo: string;
  linhas: Array<{ chave: string; quantidade: number }>;
  coluna: string;
  /** O que exibir no lugar da chave; nome de etapa e motivo próprio são dado. */
  rotulo?: (chave: string) => string;
}) {
  const t = useT();
  return (
    <div className="space-y-2">
      <h3 className="text-sm font-semibold">{t(titulo)}</h3>
      {linhas.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t("Nenhuma perda na janela.")}</p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t(coluna)}</TableHead>
              <TableHead className="text-right">{t("Negócios")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {linhas.map((linha) => (
              <TableRow key={linha.chave}>
                <TableCell className="truncate">
                  {SENTINELAS.has(linha.chave) ? t(linha.chave) : rotulo(linha.chave)}
                </TableCell>
                <TableCell className="text-right tabular-nums">{linha.quantidade}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </div>
  );
}

export function PerdasPanel() {
  const t = useT();
  const { data, isLoading, isError } = usePerdasMetrics();
  if (isLoading) return <p className="text-sm text-muted-foreground">{t("Carregando…")}</p>;
  if (isError || !data)
    return <p className="text-sm text-destructive">{t("Erro ao carregar o relatório de perdas.")}</p>;

  const relatorio = data.data;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{t("Perdas")}</CardTitle>
        <p className="text-xs text-muted-foreground">
          {t("Por motivo, categoria e etapa de saída — quantidade e valor por moeda.")}
          {relatorio.truncado ? ` ${t("Cortado no limite de leitura.")}` : ""}
        </p>
      </CardHeader>
      <CardContent className="grid gap-6 md:grid-cols-3">
        <Bloco
          titulo="Por motivo"
          linhas={relatorio.porMotivo}
          coluna="Motivo"
          rotulo={(motivo) => {
            const canonico = rotuloDoMotivoDePerda(motivo);
            return canonico === motivo ? motivo : t(canonico);
          }}
        />
        <Bloco titulo="Por categoria" linhas={relatorio.porCategoria} coluna="Categoria" />
        <Bloco titulo="Por etapa de saída" linhas={relatorio.porEtapa} coluna="Etapa" />

        <div className="space-y-2 md:col-span-3">
          <h3 className="text-sm font-semibold">{t("Valor por moeda")}</h3>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("Moeda")}</TableHead>
                <TableHead className="text-right">{t("Negócios")}</TableHead>
                <TableHead className="text-right">{t("Valor")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {relatorio.porMoeda.map((m) => (
                <TableRow key={m.moeda}>
                  <TableCell>{m.moeda === SEM_MOEDA ? t(SEM_MOEDA) : m.moeda}</TableCell>
                  <TableCell className="text-right tabular-nums">{m.quantidade}</TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formataMoeda(m.moeda, m.valor_cents)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          <p className="text-xs text-muted-foreground">
            {t("Moedas nunca são somadas entre si: cada balde é o total da própria moeda.")}
          </p>
        </div>
      </CardContent>
    </Card>
  );
}
