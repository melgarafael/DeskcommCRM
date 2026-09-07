"use client";

import { useLocaleDeData } from "@/hooks/i18n/useLocaleDeData";
import { useState } from "react";
import Link from "next/link";
import { formatDistanceToNowStrict } from "date-fns";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useAgentInbox, useUpdateInboxItem, type AgentInboxItem } from "@/hooks/ai/useAgentInbox";
import { kindLabel, SEVERITY_LABEL, type AgentInboxSeverity } from "@/lib/ai/agent-inbox-copy";
import { Bell, Check } from "@/lib/ui/icons";
import { useT } from "@/hooks/i18n/useT";
import { ApiError } from "@/lib/api/types";

const SEVERITY_VARIANT: Record<AgentInboxSeverity, "info" | "warning" | "error"> = {
  info: "info",
  warn: "warning",
  critical: "error",
};

export function AgentInboxList({ canResolve }: { canResolve: boolean }) {
  const t = useT();
  const [tab, setTab] = useState<"open" | "resolved">("open");
  const { data: cachedData, error, isLoading, isError, refetch, isFetching } = useAgentInbox(tab);
  const acessoNegado = error instanceof ApiError && (error.status === 401 || error.status === 403);
  const data = acessoNegado ? undefined : cachedData;
  const update = useUpdateInboxItem();

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4">
      <Tabs value={tab} onValueChange={(v) => setTab(v as "open" | "resolved")}>
        <TabsList>
          <TabsTrigger value="open">
            {t("Abertos")}{data ? ` (${data.open_count})` : ""}
          </TabsTrigger>
          <TabsTrigger value="resolved">{t("Resolvidos")}</TabsTrigger>
        </TabsList>
      </Tabs>

      {isError ? (
        <div role="alert" className="flex flex-wrap items-center gap-3 rounded-lg border border-border p-4 text-sm">
          <p className="min-w-0 flex-1">{t(acessoNegado ? "Seu acesso aos avisos não está disponível. Confira sua sessão e tente novamente." : data ? "Não foi possível atualizar os avisos. A lista abaixo pode estar desatualizada." : "Não foi possível carregar os avisos. Tente novamente.")}</p>
          <Button variant="outline" size="sm" disabled={isFetching} onClick={() => void refetch()}>{t("Tentar novamente")}</Button>
        </div>
      ) : null}
      {update.isError ? <p role="alert" className="text-sm text-destructive">{t("Não foi possível atualizar este aviso. Tente novamente.")}</p> : null}

      {isLoading ? (
        <div className="space-y-2">
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-16 w-full" />
        </div>
      ) : isError && !data ? null : !data || data.items.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 py-16 text-center">
          <Bell size={28} className="text-muted-foreground" aria-hidden />
          <p className="text-sm font-medium">
            {tab === "open" ? t("Nenhum aviso em aberto") : t("Nenhum aviso resolvido")}
          </p>
          <p className="text-xs text-muted-foreground">
            {tab === "open"
              ? t("Quando o assistente precisar de você, o aviso aparece aqui.")
              : t("Avisos que você marcar como resolvidos ficam aqui.")}
          </p>
        </div>
      ) : (
        <ul className="divide-y divide-border rounded-lg border border-border">
          {data.items.map((item) => (
            <InboxRow
              key={item.id}
              item={item}
              canResolve={canResolve}
              pending={update.isPending}
              onToggle={(status) => update.mutate({ id: item.id, status })}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

function InboxRow({
  item,
  canResolve,
  pending,
  onToggle,
}: {
  item: AgentInboxItem;
  canResolve: boolean;
  pending: boolean;
  onToggle: (status: "open" | "resolved") => void;
}) {
  const localeDaData = useLocaleDeData();
  const t = useT();
  const when = formatDistanceToNowStrict(new Date(item.created_at), {
    addSuffix: true,
    locale: localeDaData,
  });
  return (
    <li className="flex flex-wrap items-start gap-3 px-4 py-3" data-testid="inbox-item">
      <Badge variant={SEVERITY_VARIANT[item.severity]} className="mt-0.5 shrink-0">
        {t(SEVERITY_LABEL[item.severity])}
      </Badge>
      <div className="min-w-0 flex-1 basis-48 break-words">
        <p className="text-sm font-medium">{t(item.title)}</p>
        <p className="text-xs text-muted-foreground">
          {kindLabel(item.kind, t)} · {when}
        </p>
        {item.body ? <p className="mt-1 text-xs text-muted-foreground">{t(item.body)}</p> : null}
        {item.destination.orientacao ? <p className="mt-2 text-xs text-muted-foreground">{t(item.destination.orientacao)}</p> : null}
        {item.destination.estado === "disponivel" ? (
          <Button asChild size="sm" variant="link" className="mt-1 h-auto whitespace-normal px-0 text-left">
            <Link href={item.destination.href}>{t(item.destination.rotulo)}</Link>
          </Button>
        ) : null}
      </div>
      {canResolve ? (
        item.status === "resolved" ? (
          <Button size="sm" variant="ghost" disabled={pending} onClick={() => onToggle("open")}>
            {t("Reabrir")}
          </Button>
        ) : (
          <Button size="sm" variant="outline" disabled={pending} onClick={() => onToggle("resolved")}>
            <Check size={14} aria-hidden />
            {t("Marcar resolvido")}
          </Button>
        )
      ) : null}
    </li>
  );
}
