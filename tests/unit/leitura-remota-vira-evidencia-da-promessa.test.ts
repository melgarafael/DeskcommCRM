/**
 * #2147 — quais ferramentas do servidor MCP externo a montagem do turno entrega
 * como LEITURA para a revisão de promessa.
 *
 * O defeito medido numa instalação em 27/10/2026: o agente consultou a agenda
 * do cliente, recebeu "exame em 30/11/2026 às 17:50" e a revisão de promessa
 * vetou a resposta quatro vezes, porque a data não vinha de nenhuma evidência
 * que ela conhecesse. A regra de quem vira evidência é a MESMA de quem é
 * leitura (`ehLeituraRemota`): as duas metades, marca do admin e
 * `readOnlyHint` do servidor. Este arquivo fixa as bordas.
 */
import { describe, expect, it } from "vitest";
import type { Tool } from "ai";

import { leiturasRemotasMontadas } from "@/lib/agent-engine/edge/crm/mcp-tools";

const montada = {} as Tool;

describe("leiturasRemotasMontadas", () => {
  it("leitura marcada pelo admin e declarada pelo servidor entra", () => {
    const nomes = leiturasRemotasMontadas(
      ["crm_get_contact", "mcp_externo:leitura:consultar_agendamentos"],
      { ferramentas: [{ name: "consultar_agendamentos", somenteLeitura: true }] },
      { crm_get_contact: montada, consultar_agendamentos: montada },
    );
    expect([...nomes]).toEqual(["consultar_agendamentos"]);
  });

  it("uma metade só não basta: sem readOnlyHint, ou marcada como escrita, fica de fora", () => {
    const nomes = leiturasRemotasMontadas(
      ["mcp_externo:leitura:sem_hint", "mcp_externo:escrita:com_hint"],
      {
        ferramentas: [
          { name: "sem_hint" },
          { name: "com_hint", somenteLeitura: true },
        ],
      },
      { sem_hint: montada, com_hint: montada },
    );
    expect([...nomes]).toEqual([]);
  });

  it("nome do catálogo compilado nunca é tratado como remota", () => {
    const nomes = leiturasRemotasMontadas(
      ["mcp_externo:leitura:crm_get_contact"],
      { ferramentas: [{ name: "crm_get_contact", somenteLeitura: true }] },
      { crm_get_contact: montada },
    );
    expect([...nomes]).toEqual([]);
  });

  it("remota que não foi montada no turno (ex.: sem a identidade do contato) fica de fora", () => {
    const nomes = leiturasRemotasMontadas(
      ["mcp_externo:leitura:consultar_agendamentos"],
      { ferramentas: [{ name: "consultar_agendamentos", somenteLeitura: true }] },
      {},
    );
    expect([...nomes]).toEqual([]);
  });

  it("sem servidor carregado, nenhuma", () => {
    expect(
      [...leiturasRemotasMontadas(["mcp_externo:leitura:x"], null, { x: montada })],
    ).toEqual([]);
  });
});
