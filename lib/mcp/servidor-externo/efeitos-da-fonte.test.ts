import { expect, it, vi } from "vitest";
import { z } from "zod";
import { tool } from "@/lib/agent-engine/edge/llm/run-model-call";
import { marcarLeituraRemota } from "./leitura-remota";
import { limitarFerramentasDaFonte } from "./efeitos-da-fonte";
const def = (execute: () => Promise<unknown>) => tool({ inputSchema: z.object({}), execute });
it.each([
  "crm_send_whatsapp_message",
  "send_template",
  "present_catalog_items",
  "crm_search_contacts",
  "outra_remota",
])("barra desvio da fonte por %s sem executar", async (name) => {
  const execute = vi.fn(async () => ({ ok: true }));
  const tools = limitarFerramentasDaFonte({ [name]: def(execute) }, "consultar");
  expect(tools[name]).toBeUndefined();
  expect(execute).not.toHaveBeenCalled();
});
it("preserva somente a fonte com leitura comprovada e as nativas de resposta/caso", () => {
  const d = def(vi.fn());
  const read = marcarLeituraRemota(def(vi.fn()));
  const tools = limitarFerramentasDaFonte(
    { consultar: read, send_message: d, open_human_case: d, provide_case_update: d },
    "consultar",
  );
  expect(tools.consultar).toBe(read);
  expect(tools.send_message).toBe(d);
  expect(tools.open_human_case).toBe(d);
  expect(tools.provide_case_update).toBe(d);
  const forged = limitarFerramentasDaFonte({ consultar: { ...read } }, "consultar");
  expect(forged.consultar).toBeUndefined();
});
