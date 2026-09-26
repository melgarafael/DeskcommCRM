"use client";

import { useT } from "@/hooks/i18n/useT";
import { useState } from "react";

import { useAttendantMetrics, type AttendantMetric } from "@/hooks/metrics/useAttendantMetrics";
import { AtritoPanel } from "./AtritoPanel";
import { PerdasPanel } from "./PerdasPanel";
import { PrevisaoPanel } from "./PrevisaoPanel";
import { useTeamMembers } from "@/hooks/team/useTeamMembers";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

const ALL = "__all__";

function formatDuration(seconds: number | null): string {
  if (seconds == null) return "—";
  const s = Math.round(seconds);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rest = s % 60;
  return rest === 0 ? `${m}min` : `${m}min ${rest}s`;
}

function attendantLabel(a: AttendantMetric, t: (texto: string) => string): string {
  return a.name ?? a.email ?? `${t("Atendente")} ${a.user_id.slice(0, 8)}`;
}

interface Props {
  canCompare: boolean;
  currentUserId: string;
}

export function MetricsClient({ canCompare, currentUserId }: Props) {
  const t = useT();
  const [owner, setOwner] = useState<string>(ALL);
  const selectedOwner = owner === ALL ? null : owner;
  const { data, isLoading, isError } = useAttendantMetrics(selectedOwner);
  // Opções do filtro: só manager+ (a rota /team é manager+). Agent nem vê o filtro.
  const team = useTeamMembers({ enabled: canCompare });

  if (isLoading) return <p className="text-sm text-muted-foreground">{t("Carregando…")}</p>;
  if (isError || !data)
    return <p className="text-sm text-destructive">{t("Erro ao carregar métricas.")}</p>;

  const metrics = data.data;
  const funnelTotal = metrics.funnel.reduce((acc, s) => acc + s.count, 0);
  const maxCount = Math.max(1, ...metrics.funnel.map((s) => s.count));

  return (
    <div className="flex flex-col gap-6">
      {canCompare ? (
        <div className="flex items-center gap-3">
          <span className="text-sm text-muted-foreground">{t("Atendente")}</span>
          <Select value={owner} onValueChange={setOwner}>
            <SelectTrigger className="w-64">
              <SelectValue placeholder={t("Todos os atendentes")} />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>{t("Todos os atendentes")}</SelectItem>
              {(team.data?.data ?? [])
                .filter((m) => m.role !== "viewer")
                .map((m) => (
                  <SelectItem key={m.user_id} value={m.user_id}>
                    {m.full_name ?? m.email ?? m.user_id.slice(0, 8)}
                    {m.user_id === currentUserId ? ` ${t("(você)")}` : ""}
                  </SelectItem>
                ))}
            </SelectContent>
          </Select>
        </div>
      ) : null}

      {/* Acima do funil e da performance de propósito: é o número do sistema
          inteiro, ao qual as métricas de área se subordinam (doutrina §3.6).
          Não filtra por atendente — atrito é propriedade do sistema, e quebrá-lo
          por pessoa convida a otimização local que degrada o todo. */}
      <AtritoPanel podeEditarRegua={canCompare} />

      {/* Relatório "Perdas" (#1537): manager+, porque é o funil inteiro — o
          mesmo critério do /metrics para quem compara. */}
      {canCompare ? <PerdasPanel /> : null}

      {/* Previsão ponderada do funil (issue #1535): por mês × moeda, com os
          baldes "sem data" e "sem probabilidade" à parte. Depois do atrito de
          propósito — é o número da EQUIPE comercial, que se subordina ao do
          sistema inteiro acima. */}
      <PrevisaoPanel />

      <Card>
        <CardHeader>
          <CardTitle className="text-base">
            {t("Funil")} {selectedOwner ? t("do atendente") : ""} · {funnelTotal}{" "}
            {funnelTotal === 1 ? t("aberto") : t("abertos")}
          </CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {metrics.funnel.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t("Nenhuma etapa configurada.")}</p>
          ) : (
            metrics.funnel.map((s) => (
              <div key={s.stage_id} className="flex items-center gap-3">
                <span className="w-40 shrink-0 truncate text-sm">{s.stage_name}</span>
                <div className="h-2 flex-1 overflow-hidden rounded-full bg-muted">
                  <div
                    className="h-full rounded-full bg-primary transition-[width]"
                    style={{ width: `${(s.count / maxCount) * 100}%` }}
                  />
                </div>
                <span className="w-8 shrink-0 text-right text-sm tabular-nums">{s.count}</span>
              </div>
            ))
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">
            {canCompare ? t("Performance por atendente") : t("Sua performance")}
          </CardTitle>
        </CardHeader>
        <CardContent>
          {metrics.attendants.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              {t("Sem atividade no período (ganhos/perdidos, conversas ou respostas).")}
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("Atendente")}</TableHead>
                  <TableHead className="text-right">{t("Ganhos")}</TableHead>
                  <TableHead className="text-right">{t("Perdidos")}</TableHead>
                  <TableHead className="text-right">{t("Conversas")}</TableHead>
                  <TableHead className="text-right">{t("1ª resposta (média)")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {metrics.attendants.map((a) => (
                  <TableRow key={a.user_id}>
                    <TableCell className="font-medium">
                      {attendantLabel(a, t)}
                      {a.user_id === currentUserId ? (
                        <span className="text-muted-foreground"> {t("(você)")}</span>
                      ) : null}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{a.won}</TableCell>
                    <TableCell className="text-right tabular-nums">{a.lost}</TableCell>
                    <TableCell className="text-right tabular-nums">
                      {a.conversations_handled}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {formatDuration(a.avg_first_response_seconds)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
