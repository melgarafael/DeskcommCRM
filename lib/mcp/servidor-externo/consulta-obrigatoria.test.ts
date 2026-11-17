import { beforeEach, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type * as Chamada from "./chamada";
const m = vi.hoisted(() => ({ carregar: vi.fn(), chamar: vi.fn(), audit: vi.fn() }));
vi.mock("./carregar", () => ({ carregarServidorMcpExternoDoTurno: m.carregar }));
vi.mock("./chamada", async (importOriginal) => ({
  ...(await importOriginal<typeof Chamada>()),
  chamarFerramentaRemota: m.chamar,
}));
vi.mock("@/lib/audit", () => ({ audit: m.audit }));
import { CABECALHOS_DO_CONTATO } from "./chamada";
import {
  consultarFonteObrigatoria,
  textoAutorizadoPelaFonte,
  RESPOSTA_SEM_DADOS,
} from "./consulta-obrigatoria";
const agente = {
  agentId: "agente",
  toolIds: ["mcp_externo:leitura:consultar_dados_cliente"],
  consultaObrigatoriaTool: "consultar_dados_cliente",
  mcpExternoNoAtendimento: true,
};
const ids = {
  organizationId: "org-do-turno",
  contactId: "contato-do-turno",
  conversationId: "conversa-do-turno",
};
const db = {} as SupabaseClient;
beforeEach(() => {
  vi.resetAllMocks();
  m.carregar.mockResolvedValue({
    servidor: {},
    ferramentas: [{ name: "consultar_dados_cliente", somenteLeitura: true }],
    cabecalhos: { [CABECALHOS_DO_CONTATO.id]: ids.contactId },
  });
});
it("usa identidade do executor e consulta fresca; recusa links e valores inventados", async () => {
  const fonte = {
    consultado_em: new Date().toISOString(),
    respostas_permitidas: ["VALOR: R$ 900,00."],
  };
  m.chamar.mockResolvedValue({ dados: fonte });
  const atual = await consultarFonteObrigatoria(db, ids, agente);
  expect(atual).toEqual(fonte);
  expect(m.audit).toHaveBeenCalledWith(
    expect.objectContaining({
      organizationId: ids.organizationId,
      resourceType: "mcp_tool",
      resourceId: null,
      metadata: expect.objectContaining({
        tool_name: agente.consultaObrigatoriaTool,
        success: true,
      }),
    }),
  );
  expect(m.carregar).toHaveBeenCalledWith(
    db,
    ids.organizationId,
    agente.toolIds,
    expect.objectContaining({ contatoDoTurno: ids.contactId }),
  );
  expect(m.chamar).toHaveBeenCalledWith(
    expect.anything(),
    "consultar_dados_cliente",
    {},
    expect.anything(),
  );
  expect(textoAutorizadoPelaFonte("VALOR: R$ 900,00.", atual)).toBe(true);
  expect(textoAutorizadoPelaFonte("VALOR: R$ 90,00.", atual)).toBe(false);
  expect(textoAutorizadoPelaFonte("Seu portal: https://outro.example/projeto/123", atual)).toBe(
    false,
  );
});
it.each(["indisponivel", "desatualizado", "escrita", "sem_identidade"])(
  "falha fechada: %s",
  async (caso) => {
    if (caso === "indisponivel") m.carregar.mockResolvedValue(null);
    if (caso === "desatualizado")
      m.chamar.mockResolvedValue({
        dados: { consultado_em: "2020-01-01T00:00:00Z", respostas_permitidas: ["inventado"] },
      });
    if (caso === "escrita")
      m.carregar.mockResolvedValue({
        ferramentas: [{ name: "consultar_dados_cliente", somenteLeitura: false }],
      });
    const fonte = await consultarFonteObrigatoria(
      db,
      caso === "sem_identidade" ? { ...ids, contactId: null } : ids,
      agente,
    );
    expect(fonte).toBeNull();
    expect(textoAutorizadoPelaFonte("R$ 100,00", fonte)).toBe(false);
    expect(textoAutorizadoPelaFonte(RESPOSTA_SEM_DADOS, fonte)).toBe(true);
  },
);
it("relê a fonte a cada chamada; não reaproveita o link de uma consulta anterior", async () => {
  m.chamar
    .mockResolvedValueOnce({
      dados: { consultado_em: new Date().toISOString(), respostas_permitidas: ["link antigo"] },
    })
    .mockRejectedValueOnce(new Error("timeout"));
  expect(await consultarFonteObrigatoria(db, ids, agente)).not.toBeNull();
  expect(await consultarFonteObrigatoria(db, ids, agente)).toBeNull();
  expect(m.chamar).toHaveBeenCalledTimes(2);
});
