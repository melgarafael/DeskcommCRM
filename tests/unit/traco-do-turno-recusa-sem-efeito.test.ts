import { describe, expect, it } from "vitest";

/**
 * O TRAÇO DO TURNO MARCA RECUSA COMO RECUSA (#4342).
 *
 * Medido na prova do #3328: `crm_create_lead` recusou com `{ erro, mensagem }`
 * (`sem_destino`), o negócio não nasceu, e o traço do turno gravou a chamada
 * como `ok`. Quem lê o traço depois vê sucesso numa chamada sem efeito.
 *
 * A régua do traço era `{ ok: false }` — a convenção de uma família de tools,
 * não a das ferramentas do catálogo MCP, que recusam em `{ erro, mensagem }`,
 * `{ permitido: false, motivo }` e `{ error }`. O conserto usa a MESMA régua do
 * gate `registro_sem_efeito` (`lib/ai/runtime/desfecho-da-chamada.ts`), para o
 * traço e o audit não discordarem sobre a mesma chamada.
 */
import {
  criarColetorDeFerramentas,
  envolverFerramentasComTraco,
} from "../../lib/agent-engine/agent/traco-do-turno";
import type { ToolSet } from "../../lib/agent-engine/edge/llm/run-model-call";

function ferramenta(execute: (input: unknown, options: unknown) => unknown) {
  return { description: "teste", parameters: {}, execute };
}

function relogioDeMentira(): () => number {
  let t = 0;
  return () => {
    t += 5;
    return t;
  };
}

async function executar(resultado: unknown) {
  const tools = { crm_create_lead: ferramenta(() => resultado) } as unknown as ToolSet;
  const coletor = criarColetorDeFerramentas();
  const envolvidas = envolverFerramentasComTraco(tools, coletor, relogioDeMentira());
  const devolvido = await (
    envolvidas.crm_create_lead as { execute: (i: unknown, o: unknown) => unknown }
  ).execute({}, {});
  return { chamada: coletor.listar()[0], devolvido };
}

describe("traço do turno — recusa da ferramenta não é ok (#4342)", () => {
  it("`{ erro: 'sem_destino', mensagem }` vira falhou, com o CÓDIGO no traço", async () => {
    const { chamada, devolvido } = await executar({
      erro: "sem_destino",
      mensagem: "esta receita não aponta para nenhum funil — escolha o funil antes de criar o negócio.",
    });

    expect(chamada).toMatchObject({
      nome: "crm_create_lead",
      estado: "falhou",
      codigo: "sem_destino",
    });
    expect(chamada?.erro).toContain("não aponta para nenhum funil");
    // O envoltório OBSERVA: devolve o mesmo objeto que a ferramenta devolveu.
    expect(devolvido).toMatchObject({ erro: "sem_destino" });
  });

  it("`{ permitido: false, motivo }` (recusa do handler) também é falhou, com o motivo", async () => {
    const { chamada } = await executar({
      permitido: false,
      motivo: "fora_da_conversa",
      mensagem: "esta conversa é com outra pessoa.",
    });

    expect(chamada).toMatchObject({
      estado: "falhou",
      codigo: "fora_da_conversa",
    });
  });

  it("`{ error }` (recusa que a ponte devolve ao modelo) também é falhou", async () => {
    const { chamada } = await executar({ error: "Role 'agent' insufficient (required: 'manager')" });

    expect(chamada).toMatchObject({ estado: "falhou" });
    expect(chamada?.erro).toContain("insufficient");
  });

  it("CONTROLE POSITIVO: negócio criado continua ok, sem código de recusa", async () => {
    const { chamada } = await executar({ lead: { id: "11111111-1111-4111-8111-111111111111" } });

    expect(chamada).toMatchObject({ nome: "crm_create_lead", estado: "ok", erro: null });
    expect(chamada).not.toHaveProperty("codigo");
  });
});
