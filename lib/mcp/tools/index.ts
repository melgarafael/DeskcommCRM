/**
 * Catalogo agregado de tools MCP. Wave 3: 5 read tools.
 * Wave 4 (S-13.04) adiciona write tools + handoff. Adicione exports aqui.
 */
import type { McpToolDefinition } from "../types";
import { crmSearchContacts, crmGetContact } from "./contacts";
import {
  crmListConversations,
  crmGetConversation,
  crmGetConversationHistory,
} from "./conversations";

// Cast via `unknown` porque McpToolDefinition<TInput> nao e covariante
// em TInput (handler usa TInput em posicao contravariante). Coletar
// definicoes heterogeneas em array unico exige apagar o input shape no
// nivel do array — o server core ja recebe args como `Record<string,
// unknown>` e cada handler valida no Zod do registerTool.
export const allTools: ReadonlyArray<McpToolDefinition> = [
  crmSearchContacts,
  crmGetContact,
  crmListConversations,
  crmGetConversation,
  crmGetConversationHistory,
] as unknown as ReadonlyArray<McpToolDefinition>;

export const VALID_TOOL_IDS: ReadonlyArray<string> = allTools.map((t) => t.name);

export function getToolByName(name: string): McpToolDefinition | undefined {
  return allTools.find((t) => t.name === name);
}
