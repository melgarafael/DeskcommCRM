import type { ToolSet } from "@/lib/agent-engine/edge/llm/run-model-call";
import { ehLeituraRemota } from "./leitura-remota";

/** No modo de fonte obrigatória, nenhum outro canal de escrita pode contornar a resposta validada. */
export function limitarFerramentasDaFonte(tools: ToolSet, fonte: string): ToolSet {
  return Object.fromEntries(
    Object.entries(tools).filter(([name, definition]) => {
      // Nativas montadas antes das remotas; o montador não permite colisões.
      return (
        ["send_message", "open_human_case", "provide_case_update"].includes(name) ||
        (name === fonte && ehLeituraRemota(definition))
      );
    }),
  ) as ToolSet;
}
