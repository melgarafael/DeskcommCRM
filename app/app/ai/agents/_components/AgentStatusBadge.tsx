"use client";
import { Badge } from "@/components/ui/badge";
import { estadoDoAgente } from "@/lib/ai/agents/no-ar";
import type { AgentRow } from "@/hooks/ai/useAgent";
import { useT } from "@/hooks/i18n/useT";

export type AgentStatus = "published" | "draft" | "paused" | "archived" | "invalid";

/**
 * "Publicado" tem que significar "está no ar", e quem decide isso é o runtime.
 *
 * A régua mora em `lib/ai/agents/no-ar.ts` e é a MESMA que os workers e as
 * rotas de picker importam. Ela morava aqui, e enquanto morou aqui foi copiada
 * errado três vezes — a cópia do `ai-response-worker` (`.eq("is_active", true)`
 * e nada mais) chegou a responder ao cliente por um agente que esta função
 * rotulava "Rascunho".
 *
 * Duas coisas que este badge já afirmou e que foram MEDIDAS como falsas:
 *
 *   1. "o agente ativo sem versão é invisível para os dois runtimes" — ele é
 *      visível para um terceiro, `workers/ai-response-worker.ts`, que responde
 *      ao cliente por ele. Um `rag_bot` legado ativo e sem versão está NO AR, e
 *      chamá-lo de "Rascunho" era a tela escondendo quem atende. O caso que
 *      motivou aquele texto — o agente do onboarding — não regride: hoje
 *      `createDefaultAgent.ts` grava `kind: "mcp_agent"`, e `mcp_agent` sem
 *      ponteiro continua "Rascunho", porque a config dele vive na versão.
 *   2. "com versão publicada e inativo é Pausado" — nem o agent-engine
 *      (`loadPublishedAgentConfig`) nem o dispatcher leem `is_active`. Com
 *      versão publicada o agente responde, e o rótulo honesto é "Publicado".
 *
 * `paused` continua no vocabulário do componente porque `AgentRowMenu` e os
 * filtros da lista o consomem; ele deixou de ter emissor aqui.
 */
export function deriveAgentStatus(agent: AgentRow): AgentStatus {
  switch (estadoDoAgente(agent)) {
    case "arquivado":
      return "archived";
    case "no_ar":
    case "no_ar_legado":
      return "published";
    case "parado":
      return "draft";
  }
}

const LABEL: Record<AgentStatus, string> = {
  published: "Publicado",
  draft: "Rascunho",
  paused: "Pausado",
  archived: "Arquivado",
  invalid: "Inválido",
};

const VARIANT: Record<AgentStatus, "default" | "secondary" | "outline" | "destructive"> = {
  published: "default",
  draft: "secondary",
  paused: "outline",
  archived: "outline",
  invalid: "destructive",
};

export function AgentStatusBadge({ status }: { status: AgentStatus }) {
  const t = useT();
  return (
    <Badge variant={VARIANT[status]} aria-label={`status: ${t(LABEL[status])}`}>
      {t(LABEL[status])}
    </Badge>
  );
}
