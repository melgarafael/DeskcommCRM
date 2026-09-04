"use client";
import { useMemo } from "react";
import { format, isToday, isYesterday } from "date-fns";
import { pt as ptBR } from "date-fns/locale";
import { ChatCircle, Users, Robot, Gear } from "@/lib/ui/icons";
import type { Icon as PhosphorIcon } from "@phosphor-icons/react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { useTimeline } from "@/hooks/contacts/useTimeline";
import type { TimelineItemView as TimelineItem } from "@/lib/types/contacts";
import { activityLabel, actorName, actorShape } from "@/lib/leads/activity-vocabulary";

interface Props {
  contactId: string;
  types?: string[];
}

const ICON_MAP: Record<string, PhosphorIcon> = {
  whatsapp: ChatCircle,
  crm: Users,
  ai: Robot,
  system: Gear,
};

function dayHeader(d: Date): string {
  if (isToday(d)) return "Hoje";
  if (isYesterday(d)) return "Ontem";
  return format(d, "dd/MM/yyyy", { locale: ptBR });
}

/**
 * Fallback de corpo quando a linha não tem `reason` (histórico anterior ao
 * barramento). Só devolve texto que uma PESSOA escreveu ou leria — nunca
 * `JSON.stringify` do payload: era isso que colocava três uuids na tela onde
 * devia estar "Movido de Avaliação para Proposta enviada". Sem texto legível,
 * a linha fica só com o rótulo.
 */
function summarizePayload(p: Record<string, unknown>): string {
  if (!p) return "";
  for (const campo of ["body", "text", "summary", "reason", "note"]) {
    const v = p[campo];
    if (typeof v === "string" && v.trim() !== "") return v.slice(0, 200);
  }
  return "";
}

export function TimelineView({ contactId, types }: Props) {
  const q = useTimeline(contactId, types);

  const grouped = useMemo(() => {
    const items: TimelineItem[] = q.data?.pages.flatMap((p) => p.data) ?? [];
    const map = new Map<string, TimelineItem[]>();
    for (const it of items) {
      const d = new Date(it.performed_at);
      const key = format(d, "yyyy-MM-dd");
      const arr = map.get(key) ?? [];
      arr.push(it);
      map.set(key, arr);
    }
    return Array.from(map.entries());
  }, [q.data]);

  if (q.isLoading) {
    return (
      <div className="space-y-3">
        {[1, 2, 3].map((i) => (
          <Skeleton key={i} className="h-16 w-full" />
        ))}
      </div>
    );
  }

  if (q.isError) {
    return (
      <Card className="p-4">
        <p className="text-sm text-error-fg">Erro ao carregar timeline.</p>
        <Button size="sm" variant="outline" className="mt-2" onClick={() => q.refetch()}>
          Tentar novamente
        </Button>
      </Card>
    );
  }

  if (grouped.length === 0) {
    return (
      <Card className="p-6 text-center text-sm text-muted-foreground">
        Nenhuma atividade registrada ainda.
      </Card>
    );
  }

  return (
    <div className="space-y-6">
      {grouped.map(([key, items]) => {
        const date = new Date(key);
        return (
          <section key={key} className="space-y-2">
            <h3 className="sticky top-0 z-10 bg-background py-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              {dayHeader(date)}
            </h3>
            <ul className="space-y-2">
              {items.map((it) => {
                const Icon = ICON_MAP[it.source_module] ?? Gear;
                const label = activityLabel(it.type);
                const corpo = (it.reason ?? "").trim() || summarizePayload(it.payload);
                const forma = actorShape(it.actor_kind ?? null);
                const quem = actorName(it.actor_kind ?? null, {
                  agente: it.actor_agent_name,
                  usuario: it.actor_user_name,
                });
                const time = format(new Date(it.performed_at), "HH:mm", { locale: ptBR });
                return (
                  <li
                    key={it.id}
                    className="flex items-start gap-3 rounded-md border border-border bg-card p-3"
                  >
                    {/* Marcador por ator (BRIEFING §5): preenchido = humano,
                        anel = agente, quadrado = sistema. Mesma geometria do
                        OwnerBadge no card — forma, nunca cor. */}
                    <div
                      className={cn(
                        "mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center text-accent",
                        forma === "filled" && "rounded-full bg-accent-soft",
                        forma === "ring" && "rounded-full border border-accent bg-surface ring-1 ring-inset ring-accent/40",
                        // Sistema, automação ou autor não registrado: o mesmo
                        // tracejado do "Sem responsável" no card. Três formas nas
                        // duas telas — quem distingue "automação" de "não sei
                        // quem" é o texto ao lado, não um quarto desenho.
                        forma === "dashed" && "rounded-full border border-dashed border-border-strong",
                      )}
                      aria-hidden
                    >
                      <Icon size={16} weight="duotone" aria-hidden />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-sm font-medium">
                          {label}
                          {quem && (
                            <span className="ml-1.5 text-xs font-normal text-muted-foreground">
                              · {quem}
                            </span>
                          )}
                        </span>
                        <span className="text-xs text-muted-foreground">{time}</span>
                      </div>
                      {corpo && (
                        <p className="mt-1 truncate text-sm text-muted-foreground">{corpo}</p>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          </section>
        );
      })}
      {q.hasNextPage && (
        <div className="flex justify-center">
          <Button
            variant="outline"
            size="sm"
            onClick={() => q.fetchNextPage()}
            disabled={q.isFetchingNextPage}
          >
            {q.isFetchingNextPage ? "Carregando…" : "Carregar mais"}
          </Button>
        </div>
      )}
    </div>
  );
}
