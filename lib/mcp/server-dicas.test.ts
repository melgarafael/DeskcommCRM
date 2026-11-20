/**
 * As dicas de risco do protocolo MCP saem do MESMO risco que a tela mostra: só
 * consulta → `readOnlyHint`; `critico` → `destructiveHint`, e é por ele que um
 * cliente como o ChatGPT pede confirmação antes de publicar um assistente.
 */
import { describe, expect, it } from "vitest";

import { dicasDaFerramenta } from "./server";

describe("dicasDaFerramenta", () => {
  it("consulta é só leitura e nunca destrutiva", () => {
    expect(dicasDaFerramenta("crm_list_ai_agents", "read")).toEqual({
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: false,
    });
  });

  it("publicar e reverter um assistente são destrutivos (o cliente confirma antes)", () => {
    expect(dicasDaFerramenta("crm_publish_ai_agent_version", "write").destructiveHint).toBe(true);
    expect(dicasDaFerramenta("crm_rollback_ai_agent", "write").destructiveHint).toBe(true);
  });

  it("salvar rascunho escreve, mas não é destrutivo", () => {
    expect(dicasDaFerramenta("crm_save_ai_agent_draft", "write")).toEqual({
      readOnlyHint: false,
      destructiveHint: false,
      openWorldHint: false,
    });
  });
});
