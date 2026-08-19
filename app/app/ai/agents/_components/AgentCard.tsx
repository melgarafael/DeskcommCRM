"use client";
import Link from "next/link";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import type { AgentRow } from "@/hooks/ai/useAgent";
import { modeloExibido } from "@/lib/ai/agents/modelo-exibido";
import { AgentStatusBadge, deriveAgentStatus } from "./AgentStatusBadge";
import { AgentRowMenu } from "./AgentRowMenu";

interface Props {
  agent: AgentRow;
  canWrite: boolean;
}

export function AgentCard({ agent, canWrite }: Props) {
  const status = deriveAgentStatus(agent);
  // A versão PUBLICADA vence a coluna legada do agente — é ela que o motor lê.
  const { provider, model, origem } = modeloExibido(agent);

  return (
    <Card className="flex h-full flex-col gap-3 p-4">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <h3 className="truncate font-medium" title={agent.name}>
            {agent.name}
          </h3>
          <p
            className="truncate text-xs text-muted-foreground"
            title={
              origem === "versao"
                ? "Modelo da versão publicada — é o que atende o cliente."
                : "Modelo do rascunho; nenhuma versão publicada ainda."
            }
          >
            {provider} · {model}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {agent.is_default && (
            <Badge variant="secondary" className="text-xs">
              default
            </Badge>
          )}
          <AgentStatusBadge status={status} />
          {canWrite && <AgentRowMenu agent={agent} />}
        </div>
      </div>
      {agent.description && (
        <p className="line-clamp-2 text-xs text-muted-foreground">{agent.description}</p>
      )}
      <dl className="grid grid-cols-2 gap-2 pt-1 text-xs">
        <div>
          <dt className="text-muted-foreground">Tipo</dt>
          <dd className="font-mono">{agent.kind ?? "rag_bot"}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Prioridade</dt>
          <dd className="font-mono">{agent.priority ?? "—"}</dd>
        </div>
      </dl>
      <div className="mt-auto pt-2">
        <Link href={`/app/ai/agents/${agent.id}`}>
          <Button variant="outline" size="sm" className="w-full">
            {canWrite ? "Editar" : "Visualizar"}
          </Button>
        </Link>
      </div>
    </Card>
  );
}
