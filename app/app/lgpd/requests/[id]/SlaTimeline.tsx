"use client";

import { differenceInDays, format, isBefore } from "date-fns";
import { ptBR } from "date-fns/locale";

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
  if (requestType === "customer_data_request") {
    return [
      { label: "Recebido", day: 0 },
      { label: "Revisão intermediária", day: 5 },
      { label: "Entrega ao titular", day: 7 },
    ];
  }
  // customer_redact / store_redact
  return [
    { label: "Recebido", day: 0 },
    { label: "Processamento", day: 10 },
    { label: "Anonimização concluída", day: 15 },
  ];
}

function milestoneStatus(
  milestoneDate: Date,
  now: Date,
  dueDate: Date,
  isLast: boolean,
): "completed" | "current" | "future" {
  if (isBefore(milestoneDate, now)) return "completed";
  if (isLast && isBefore(dueDate, now)) return "current";
  // Is it the "next" milestone?
  return "future";
}

export function SlaTimeline({ received_at, due_at, request_type }: SlaTimelineProps) {
  const receivedAt = new Date(received_at);
  const dueAt = new Date(due_at);
  const now = new Date();

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
        status: milestoneStatus(date, now, dueAt, isLast),
      };
    });

  // Linear progress 0..1
  const elapsed = now.getTime() - receivedAt.getTime();
  const total = dueAt.getTime() - receivedAt.getTime();
  const progress = Math.min(1, Math.max(0, total > 0 ? elapsed / total : 0));
  const progressPct = Math.round(progress * 100);

  const daysElapsed = differenceInDays(now, receivedAt);
  const daysRemaining = differenceInDays(dueAt, now);

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
          <span>D+{daysElapsed} (hoje)</span>
          <span>
            {daysRemaining > 0
              ? `${daysRemaining}d restantes`
              : daysRemaining === 0
                ? "vence hoje"
                : `${Math.abs(daysRemaining)}d em atraso`}
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
                  D+{m.targetDay} — {m.label}
                </p>
                <p className="text-xs text-muted-foreground">
                  {format(m.date, "dd 'de' MMM yyyy", { locale: ptBR })}
                </p>
              </div>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
