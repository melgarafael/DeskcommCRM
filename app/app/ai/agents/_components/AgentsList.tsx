"use client";
import { useMemo, useState } from "react";
import Link from "next/link";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Robot, Plus } from "@/lib/ui/icons";
import { useT } from "@/hooks/i18n/useT";
import { useAgentsList } from "@/hooks/ai/useAgents";
import type { AgentRow } from "@/hooks/ai/useAgent";
import { AgentCard } from "./AgentCard";
import { AgentsListFilters, type StatusFilter } from "./AgentsListFilters";
import { deriveAgentStatus } from "./AgentStatusBadge";

interface Props {
  initialData: AgentRow[];
  canWrite: boolean;
}

export function AgentsList({ initialData, canWrite }: Props) {
  const t = useT();
  const { data, isLoading } = useAgentsList({ initialData });
  const [status, setStatus] = useState<StatusFilter>("all");
  const [query, setQuery] = useState("");
  const [showArchived, setShowArchived] = useState(false);

  const agents = data ?? [];

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return agents.filter((a) => {
      const s = deriveAgentStatus(a);
      if (!showArchived && s === "archived") return false;
      if (status !== "all" && s !== status) return false;
      if (q && !a.name.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [agents, status, query, showArchived]);

  if (!isLoading && agents.length === 0) {
    return (
      <Card className="flex flex-col items-center gap-3 p-10 text-center">
        <Robot size={36} aria-hidden className="text-muted-foreground" />
        <h2 className="font-medium">{t("Nenhum agente configurado")}</h2>
        <p className="max-w-sm text-sm text-muted-foreground">
          {t(
            "Crie um agente para responder a conversas no WhatsApp com IA. Você configura prompt, tools, gatilhos e janela de contexto.",
          )}
        </p>
        {canWrite && (
          <Link href="/app/ai/agents/new">
            <Button className="mt-1">
              <Plus size={14} aria-hidden className="mr-2" /> {t("Criar novo")}
            </Button>
          </Link>
        )}
      </Card>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <AgentsListFilters
          status={status}
          onStatusChange={setStatus}
          query={query}
          onQueryChange={setQuery}
          showArchived={showArchived}
          onShowArchivedChange={setShowArchived}
        />
        {canWrite && (
          <Link href="/app/ai/agents/new">
            <Button>
              <Plus size={14} aria-hidden className="mr-2" /> {t("Criar novo")}
            </Button>
          </Link>
        )}
      </div>

      {filtered.length === 0 ? (
        <Card className="p-8 text-center text-sm text-muted-foreground">
          {t("Nenhum agente corresponde aos filtros atuais.")}
        </Card>
      ) : (
        <ul className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
          {filtered.map((agent) => (
            <li key={agent.id}>
              <AgentCard agent={agent} canWrite={canWrite} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
