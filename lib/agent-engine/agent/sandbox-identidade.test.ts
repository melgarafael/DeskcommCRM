import { beforeEach, expect, it, vi } from "vitest";
import type pg from "pg";
const m = vi.hoisted(() => ({ load: vi.fn(), preview: vi.fn() }));
vi.mock("./agent-config", () => ({ loadAgentVersionConfig: m.load }));
vi.mock("./inbound-turn", () => ({ runAgentPreview: m.preview }));
import { testAgentVersion } from "./sandbox";
import type { InboundTurnDeps } from "./inbound-turn";
const source = "consultar_dados_cliente";
const config = () => ({
  toolIds: [`mcp_externo:leitura:${source}`],
  historyMessageWindow: 20,
  historyTokenWindow: 8000,
  mcpExternoNoAtendimento: false,
});
const input = {
  organizationId: "org",
  agentId: "agente",
  versionId: "versao",
  runId: "run",
  sampleMessage: "Qual o prazo?",
  channelId: null,
};
const pool = {} as pg.Pool;
const deps = {} as InboundTurnDeps;
beforeEach(() => {
  vi.resetAllMocks();
  m.load.mockResolvedValue(config());
});
it("telefone de amostra não cria identidade de contato", async () => {
  await testAgentVersion(pool, deps, { ...input, sampleContact: { phone: "+5511999990000" } });
  expect(m.preview).toHaveBeenCalledWith(deps, pool, expect.objectContaining({ contactId: null }));
});
it("contato resolvido pelo servidor prevalece e a simulação não muda a configuração publicada", async () => {
  const original = config();
  m.load.mockResolvedValue(original);
  await testAgentVersion(pool, deps, {
    ...input,
    authorizedContact: { id: "contato-real", name: "Teste", phone_number: "+5511999990000" },
    requiredSourceTool: source,
    sampleContact: { phone: "outro" },
  });
  const p = m.preview.mock.calls[0]![2];
  expect(p.contactId).toBe("contato-real");
  expect(p.context.context.contact.phone).toBe("+5511999990000");
  expect(p.agent).toMatchObject({ consultaObrigatoriaTool: source, mcpExternoNoAtendimento: true });
  expect(original.mcpExternoNoAtendimento).toBe(false);
});
it.each(["sem_contato", "nao_selecionada", "escrita"])(
  "não chama o modelo com fonte não autorizada: %s",
  async (caso) => {
    if (caso === "nao_selecionada") m.load.mockResolvedValue({ ...config(), toolIds: [] });
    if (caso === "escrita")
      m.load.mockResolvedValue({ ...config(), toolIds: [`mcp_externo:escrita:${source}`] });
    await expect(
      testAgentVersion(pool, deps, {
        ...input,
        requiredSourceTool: source,
        ...(caso === "sem_contato"
          ? {}
          : { authorizedContact: { id: "contato", name: "Teste", phone_number: "5511999990000" } }),
      }),
    ).rejects.toThrow("preview_source_not_selected");
    expect(m.preview).not.toHaveBeenCalled();
  },
);
