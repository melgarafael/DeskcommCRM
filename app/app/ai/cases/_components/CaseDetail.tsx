"use client";
import { formatDistanceToNowStrict } from "date-fns";
import { pt as ptBR } from "date-fns/locale";

import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { useCase } from "@/hooks/ai/useCases";
import { STATUS_BADGE_VARIANT, STATUS_LABEL, caseEventLabel } from "@/lib/ai/case-copy";
import { CaseReplyPanel } from "./CaseReplyPanel";

export function CaseDetail({ caseId }: { caseId: string | null }) {
  const { data, isLoading } = useCase(caseId);

  if (caseId === null) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-1 py-16 text-center">
        <p className="text-sm font-medium">Selecione um caso à esquerda</p>
        <p className="text-xs text-muted-foreground">Os detalhes e a resposta aparecem aqui.</p>
      </div>
    );
  }

  if (isLoading || !data) {
    return (
      <div className="space-y-3">
        <Skeleton className="h-8 w-2/3" />
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-24 w-full" />
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto">
      <header className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-base font-semibold">{data.contact_name ?? "Contato sem nome"}</h2>
          <p className="text-xs text-muted-foreground">{data.contact_phone ?? "Sem telefone"}</p>
        </div>
        <div className="flex items-center gap-2">
          {data.source === "guardrail_autofallback" ? (
            <Badge
              variant="neutral"
              title="Aberto automaticamente pelo sistema — a IA prometeu passar pra humano mas não abriu o caso, então o sistema abriu por ela."
            >
              Aberto automaticamente
            </Badge>
          ) : null}
          <Badge variant={STATUS_BADGE_VARIANT[data.status]}>{STATUS_LABEL[data.status]}</Badge>
        </div>
      </header>

      <div className="grid gap-3 sm:grid-cols-2">
        <div className="rounded-lg border border-border p-3">
          <p className="text-xs font-medium text-muted-foreground">O que o cliente precisa</p>
          <p className="mt-1 text-sm">{data.summary}</p>
        </div>
        <div className="rounded-lg border border-border p-3">
          <p className="text-xs font-medium text-muted-foreground">Por que a IA travou</p>
          <p className="mt-1 text-sm">{data.blocker}</p>
        </div>
      </div>

      <CaseReplyPanel caseId={data.id} status={data.status} />

      <div>
        <h3 className="mb-2 text-sm font-semibold">Linha do tempo</h3>
        <ul className="space-y-2">
          {data.events.map((ev) => (
            <li key={ev.id} className="text-xs text-muted-foreground">
              <span className="text-text">{caseEventLabel(ev)}</span>
              {ev.body ? <>: {ev.body}</> : null}
              {" · "}
              {formatDistanceToNowStrict(new Date(ev.created_at), { addSuffix: true, locale: ptBR })}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
