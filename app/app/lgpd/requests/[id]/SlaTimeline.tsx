"use client";

import { useLocaleDeData } from "@/hooks/i18n/useLocaleDeData";

import { differenceInDays, format, isBefore } from "date-fns";
import { useT } from "@/hooks/i18n/useT";
import { diasAtePrazo, diasDeAtraso, progressoDoPrazo } from "@/lib/lgpd/sla";

interface SlaTimelineProps {
  received_at: string;
  due_at: string;
  request_type: string;
}

interface Milestone {
  label: string;
  targetDay: number;
  date: Date;
}

function getMilestones(
  receivedAt: Date,
  requestType: string,
): { label: string; day: number }[] {
  if (requestType === "data_request") {
    return [
      { label: "Recebido", day: 0 },
      { label: "Revisão intermediária", day: 5 },
      { label: "Entrega ao titular", day: 7 },
    ];
  }
  // redact / store_redact
  return [
    { label: "Recebido", day: 0 },
    { label: "Processamento", day: 10 },
    { label: "Anonimização concluída", day: 15 },
  ];
}

/**
 * O estado do último marco. `prazoPassou` chega calculado de `diasDeAtraso` —
 * ver `SlaTimeline`, abaixo —, e não de `isBefore(dueDate, now)`: `due_at` é o
 * INÍCIO do dia guardado, então o predicado antigo já dava o prazo por passado
 * às 21h da VÉSPERA (São Paulo), enquanto o resto da tela dizia "vence hoje".
 * Agora ele vira no mesmo instante que o selo `expired`.
 *
 * Na prática o ramo `isLast && prazoPassou` não é alcançado hoje: o último marco
 * (D+7 ou D+15 corridos) cai antes do prazo (7 ou 15 dias ÚTEIS), e o marco já
 * está "completed" quando o prazo passa — medido em 4.380 recebimentos de 2026
 * e 2027, zero alcançam o ramo, com o predicado antigo ou com este.
 */
function milestoneStatus(
  milestoneDate: Date,
  now: Date,
  prazoPassou: boolean,
  isLast: boolean,
): "completed" | "current" | "future" {
  if (isBefore(milestoneDate, now)) return "completed";
  if (isLast && prazoPassou) return "current";
  // Is it the "next" milestone?
  return "future";
}

export function SlaTimeline({ received_at, due_at, request_type }: SlaTimelineProps) {
  const localeDaData = useLocaleDeData();
  const t = useT();
  const receivedAt = new Date(received_at);
  const now = new Date();

  const diasRestantes = diasAtePrazo(due_at, now);
  const prazoPassou = diasDeAtraso(due_at, now) > 0;

  const milestoneConfigs = getMilestones(receivedAt, request_type);
  const milestones: (Milestone & { status: "completed" | "current" | "future" })[] =
    milestoneConfigs.map((m, idx) => {
      const date = new Date(
        receivedAt.getTime() + m.day * 24 * 60 * 60 * 1000,
      );
      const isLast = idx === milestoneConfigs.length - 1;
      return {
        label: m.label,
        targetDay: m.day,
        date,
        status: milestoneStatus(date, now, prazoPassou, isLast),
      };
    });

  // Medida até o FIM do dia guardado. Antes, até a meia-noite UTC do dia do
  // prazo: a barra chegava a 100% às 21h da VÉSPERA (São Paulo).
  const progress = progressoDoPrazo(received_at, due_at, now);
  const progressPct = Math.round(progress * 100);

  const daysElapsed = differenceInDays(now, receivedAt);

  const progressColor =
    progress >= 1
      ? "bg-red-500"
      : progress >= 0.75
        ? "bg-yellow-500"
        : "bg-emerald-500";

  return (
    <div className="space-y-4">
      {/* Progress bar */}
      <div className="space-y-1">
        <div className="flex justify-between text-xs text-muted-foreground">
          <span>D+{daysElapsed} ({t("hoje")})</span>
          <span>
            {diasRestantes > 0
              ? `${diasRestantes}${t("d restantes")}`
              : diasRestantes === 0
                ? t("vence hoje")
                : `${Math.abs(diasRestantes)}${t("d em atraso")}`}
          </span>
        </div>
        <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
          <div
            className={`h-full rounded-full transition-all ${progressColor}`}
            style={{ width: `${progressPct}%` }}
            role="progressbar"
            aria-valuenow={progressPct}
            aria-valuemin={0}
            aria-valuemax={100}
          />
        </div>
      </div>

      {/* Milestones */}
      <ol className="relative space-y-0">
        {milestones.map((m, idx) => {
          const dotColor =
            m.status === "completed"
              ? "bg-emerald-500 border-emerald-500"
              : m.status === "current"
                ? "bg-yellow-500 border-yellow-500 ring-2 ring-yellow-200 dark:ring-yellow-900"
                : "bg-muted border-border";

          const labelColor =
            m.status === "completed"
              ? "text-emerald-700 dark:text-emerald-400"
              : m.status === "current"
                ? "text-yellow-700 dark:text-yellow-400 font-medium"
                : "text-muted-foreground";

          const isLast = idx === milestones.length - 1;

          return (
            <li key={m.targetDay} className="flex gap-3">
              <div className="flex flex-col items-center">
                <div
                  className={`mt-0.5 h-3 w-3 rounded-full border-2 ${dotColor}`}
                  aria-hidden
                />
                {!isLast && (
                  <div className="mt-1 h-8 w-px bg-border" aria-hidden />
                )}
              </div>
              <div className={`pb-1 text-sm ${isLast ? "" : "pb-3"}`}>
                <p className={`leading-tight ${labelColor}`}>
                  D+{m.targetDay} — {t(m.label)}
                </p>
                <p className="text-xs text-muted-foreground">
                  {format(m.date, "dd 'de' MMM yyyy", { locale: localeDaData })}
                </p>
              </div>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
