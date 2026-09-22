"use client";
import { useMemo, useState } from "react";
import Link from "next/link";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Plus } from "@/lib/ui/icons";
import Image from "next/image";
import { useT } from "@/hooks/i18n/useT";
import { useAgentsList } from "@/hooks/ai/useAgents";
import type { AgentRow } from "@/hooks/ai/useAgent";
import { AgentCard } from "./AgentCard";
import { AgentsListFilters, type StatusFilter } from "./AgentsListFilters";
import { deriveAgentStatus } from "./AgentStatusBadge";
import { EmployeeRoleCatalog } from "./EmployeeRoleCatalog";

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

  const agents = useMemo(() => data ?? [], [data]);

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
      <Card className="flex flex-col items-center gap-4 border-0 bg-transparent px-6 py-10 text-center shadow-none">
        <Image
          src="/brand/conversation-art.png"
          alt=""
          width={1536}
          height={1024}
          className="artisan-illustration w-60 rounded-3xl"
        />
        <h2 className="font-serif text-3xl">
          {t("Seu jeito de atender começa aqui. Escreve aí.")}
        </h2>
        <p className="max-w-sm text-sm text-muted-foreground">
          {t("Conte o que precisa. A gente organiza com você.")}
        </p>
        {canWrite && (
          <Link href="/app/ai/agents/new">
            <Button className="mt-1">
              <Plus size={14} aria-hidden className="mr-2" /> {t("Novo agente")}
            </Button>
          </Link>
        )}
      </Card>
    );
  }

  return (
    <div className="flex flex-col gap-10">
      <EmployeeRoleCatalog agents={agents} canWrite={canWrite} />

      <section aria-labelledby="equipe-atual" className="space-y-4">
        <div>
          <h2 id="equipe-atual" className="text-xl font-semibold tracking-tight">
            {t("Equipe atual")}
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            {t("Acompanhe quem está em rascunho, publicado, pausado ou arquivado.")}
          </p>
        </div>
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
            <Button variant="outline" className="rounded-full">
              <Plus size={14} aria-hidden className="mr-2" /> {t("Função personalizada")}
            </Button>
          </Link>
        )}
      </div>

      {filtered.length === 0 ? (
        <Card className="p-8 text-center text-sm text-muted-foreground">
          {t("Nenhum funcionário corresponde aos filtros atuais.")}
        </Card>
      ) : (
        <ul className="agent-directory divide-y">
          {filtered.map((agent) => (
            <li key={agent.id}>
              <AgentCard agent={agent} canWrite={canWrite} />
            </li>
          ))}
        </ul>
      )}
      </section>
    </div>
  );
}
