"use client";
import Link from "next/link";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { useT } from "@/hooks/i18n/useT";
import type { AgentRow } from "@/hooks/ai/useAgent";
import { AgentStatusBadge, deriveAgentStatus } from "./AgentStatusBadge";
import { AgentRowMenu } from "./AgentRowMenu";
import { ArtisanIcon } from "@/components/brand/ArtisanIcon";

interface Props {
  agent: AgentRow;
  canWrite: boolean;
}

/**
 * A linha do modelo, dizendo o que está EM VIGOR.
 *
 * Três casos, e cada um existe por um motivo medido:
 *
 *  1. versão publicada → é ela que o runtime lê (`agent-config.ts`), então é ela
 *     que a lista mostra. `ai_agents.model` não é sincronizado ao publicar.
 *  2. `provedor/modelo` → o formato do `rag_bot` legado, onde a coluna É a fonte.
 *  3. id nu → como todo `mcp_agent` nasce (`createMcpAgentAction` grava o id do
 *     catálogo). Antes, o `split("/")[0]` devolvia o próprio modelo e a lista
 *     renderizava "claude-sonnet-4-6 · claude-sonnet-4-6".
 */
/**
 * De ONDE saiu a linha acima — para a tela poder dizer isso a quem olha.
 *
 * Enxertado do PR #267 (@Lucas-BritoDev), que trazia a mesma informação num
 * módulo próprio. A regra ficou a desta função (é a que está em vigor e trata o
 * id nu do `mcp_agent` recém-criado); o que veio de lá é a EXPLICAÇÃO, que aqui
 * não existia: "anthropic · claude-sonnet-5" sozinho não diz se é o que atende
 * o cliente ou o que ficou no rascunho — e essa é exatamente a confusão que
 * custou uma depuração no modelo errado.
 */
export function origemDoModelo(agent: AgentRow): "versao_publicada" | "cadastro" {
  return agent.versao_publicada?.model ? "versao_publicada" : "cadastro";
}

export function modeloEmVigor(agent: AgentRow): string {
  const publicada = agent.versao_publicada;
  if (publicada?.model) {
    return publicada.provider ? `${publicada.provider} · ${publicada.model}` : publicada.model;
  }
  const cadastro = agent.model?.trim() ?? "";
  if (cadastro === "") return "—";
  if (!cadastro.includes("/")) return cadastro;
  const [provedor, ...resto] = cadastro.split("/");
  return `${provedor} · ${resto.join("/")}`;
}

export function AgentCard({ agent, canWrite }: Props) {
  const t = useT();
  const status = deriveAgentStatus(agent);

  return (
    <Card className="agent-directory-item relative flex h-full flex-col gap-3 rounded-none border-0 bg-transparent px-2 py-6 shadow-none sm:pl-20">
      <span className="absolute top-6 left-2 hidden h-12 w-12 items-center justify-center rounded-2xl bg-surface-elevated sm:flex">
        <ArtisanIcon symbol="agent" />
      </span>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <h3 className="text-lg font-medium break-words" title={agent.name}>
            <Link href={`/app/ai/agents/${agent.id}`} className="hover:underline">
              {agent.name}
            </Link>
          </h3>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {agent.is_default && (
            <Badge variant="secondary" className="text-xs">
              {t("default")}
            </Badge>
          )}
          <AgentStatusBadge status={status} />
          {canWrite && <AgentRowMenu agent={agent} />}
        </div>
      </div>
      {agent.description && (
        <p className="text-sm break-words text-muted-foreground">{agent.description}</p>
      )}
      <details className="rounded-md pt-1">
        <summary className="cursor-pointer text-sm text-muted-foreground focus-visible:outline-2 focus-visible:outline-ring">
          {t("Detalhes técnicos")}
        </summary>
        <p
          className="truncate text-xs text-muted-foreground"
          title={
            origemDoModelo(agent) === "versao_publicada"
              ? t("Modelo da versão publicada — é o que atende o cliente.")
              : t("Modelo do cadastro; nenhuma versão publicada ainda.")
          }
        >
          {modeloEmVigor(agent)}
        </p>
        <dl className="grid grid-cols-2 gap-2 pt-1 text-xs">
          <div>
            <dt className="text-muted-foreground">{t("Tipo")}</dt>
            <dd className="font-mono">{agent.kind ?? "rag_bot"}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">{t("Prioridade")}</dt>
            <dd className="font-mono">{agent.priority ?? "—"}</dd>
          </div>
        </dl>
      </details>
      <div className="mt-auto pt-2">
        <Button asChild variant="ghost" size="sm" className="px-0">
          <Link href={`/app/ai/agents/${agent.id}`}>
            {canWrite ? t("Editar") : t("Visualizar")}
          </Link>
        </Button>
      </div>
    </Card>
  );
}
