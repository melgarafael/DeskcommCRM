"use client";

/**
 * Quadro "POR CANAL" (issue #2390) — linha = canal/conexão, colunas = volume de
 * conversas, 1ª resposta (média) e vazamento ("Sem resposta").
 *
 * É o corte que faltava em `/app/metrics`: as telas existentes cortam por
 * atendente e por atividade, e a operação se organiza por NÚMERO (rodízio
 * #1330, paixa por conexão #2318). A conta mora na RPC `fn_channel_metrics`
 * (migration 0590) com a régua da irmã; esta tela só apresenta — somar de novo
 * aqui faria a tela e o teste dizerem coisas diferentes.
 *
 * Mesma forma da tabela "Performance por atendente" ao lado: mesmo `Card`,
 * mesma `Table`, o mesmo filtro de atendente da página e a mesma frase de
 * período vazio. Canal arquivado APARECE, marcado — a conversa existiu.
 */
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useT } from "@/hooks/i18n/useT";
import { useChannelMetrics } from "@/hooks/metrics/useChannelMetrics";
import { formatarDuracao, rotuloCanal, totalDeConversas } from "@/lib/metrics/canais";

interface Props {
  /** O filtro de atendente da página (`null` = todos); a RLS escopa quem olha. */
  owner: string | null;
}

export function CanaisPanel({ owner }: Props) {
  const t = useT();
  const { data, isLoading, isError } = useChannelMetrics(owner);

  if (isLoading) {
    return (
      <div className="flex flex-col gap-2" aria-busy="true" aria-label={t("Por canal")}>
        <Skeleton className="h-5 w-40" />
        <Skeleton className="h-32 w-full" />
      </div>
    );
  }

  if (isError || !data) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t("Por canal")}</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-destructive">{t("Erro ao carregar os canais.")}</p>
        </CardContent>
      </Card>
    );
  }

  const canais = data.data.channels;
  const total = totalDeConversas(canais);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">
          {t("Por canal")} · {total} {total === 1 ? t("conversa") : t("conversas")}
          {owner ? ` ${t("do atendente")}` : ""}
        </CardTitle>
      </CardHeader>
      <CardContent>
        {canais.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("Sem atividade no período.")}</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("Canal")}</TableHead>
                <TableHead className="text-right">{t("Conversas")}</TableHead>
                <TableHead className="text-right">{t("1ª resposta (média)")}</TableHead>
                <TableHead className="text-right">{t("Sem resposta")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {canais.map((c) => (
                <TableRow key={c.channel_session_id}>
                  <TableCell className="font-medium">
                    {rotuloCanal(c, t)}
                    {c.is_archived ? (
                      <span className="text-muted-foreground"> ({t("arquivado")})</span>
                    ) : null}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {c.conversations_handled}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatarDuracao(c.avg_first_response_seconds)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{c.sem_resposta}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}
