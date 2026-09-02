"use client";
import { useState } from "react";
import { formatDistanceToNowStrict } from "date-fns";
import { pt as ptBR } from "date-fns/locale";

import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useCases, type CaseListItem } from "@/hooks/ai/useCases";
import { STATUS_BADGE_VARIANT, STATUS_LABEL } from "@/lib/ai/case-copy";
import { Robot } from "@/lib/ui/icons";
import { cn } from "@/lib/utils";
import { CaseDetail } from "./CaseDetail";

export function CaseList() {
  const [tab, setTab] = useState<"open" | "resolved">("open");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const { data, isLoading } = useCases(tab);

  return (
    <div className="flex min-h-0 flex-1 gap-6">
      <div className="flex w-full max-w-xs shrink-0 flex-col gap-4">
        <Tabs value={tab} onValueChange={(v) => setTab(v as "open" | "resolved")}>
          <TabsList>
            <TabsTrigger value="open">Abertos{data ? ` (${data.open_count})` : ""}</TabsTrigger>
            <TabsTrigger value="resolved">Concluídos</TabsTrigger>
          </TabsList>
        </Tabs>

        {isLoading ? (
          <div className="space-y-2">
            <Skeleton className="h-16 w-full" />
            <Skeleton className="h-16 w-full" />
          </div>
        ) : !data || data.cases.length === 0 ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-2 py-16 text-center">
            <Robot size={28} className="text-muted-foreground/60" aria-hidden />
            <p className="text-sm font-medium">
              {tab === "open" ? "Nenhum caso aberto" : "Nenhum caso concluído"}
            </p>
            <p className="text-xs text-muted-foreground">
              {tab === "open"
                ? "Quando a IA precisar de você, aparece aqui."
                : "Casos concluídos, cancelados ou repassados ficam aqui."}
            </p>
          </div>
        ) : (
          <ul className="divide-y divide-border rounded-lg border border-border">
            {data.cases.map((c) => (
              <CaseRow
                key={c.id}
                item={c}
                selected={c.id === selectedId}
                onSelect={() => setSelectedId(c.id)}
              />
            ))}
          </ul>
        )}
      </div>

      <div className="min-w-0 flex-1">
        <CaseDetail caseId={selectedId} />
      </div>
    </div>
  );
}

function CaseRow({
  item,
  selected,
  onSelect,
}: {
  item: CaseListItem;
  selected: boolean;
  onSelect: () => void;
}) {
  const when = formatDistanceToNowStrict(new Date(item.opened_at), { addSuffix: true, locale: ptBR });
  return (
    <li>
      <button
        type="button"
        onClick={onSelect}
        aria-current={selected ? "true" : undefined}
        data-testid="case-item"
        className={cn(
          "flex w-full flex-col items-start gap-1 px-4 py-3 text-left transition-colors hover:bg-accent-soft",
          selected && "bg-accent-soft",
        )}
      >
        <div className="flex w-full items-center justify-between gap-2">
          <p className="truncate text-sm font-medium">{item.title}</p>
          <Badge variant={STATUS_BADGE_VARIANT[item.status]} className="shrink-0">
            {STATUS_LABEL[item.status]}
          </Badge>
        </div>
        <p className="text-xs text-muted-foreground">
          {item.contact_name ?? "Contato sem nome"} · {when}
        </p>
      </button>
    </li>
  );
}
