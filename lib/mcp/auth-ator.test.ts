/**
 * Quem um token de servidor É, para o resto do sistema.
 *
 * Esta função decide duas coisas que não se parecem uma com a outra:
 *
 *   - o que vai para colunas `…_by_user_id`, que têm FK para `auth.users`;
 *   - se o gate `pre_go_live` do canal se aplica (ele é pulado para pessoas,
 *     porque envio humano não responde pelo modo de teste da IA).
 *
 * Enquanto o token comum era `type: "user"`, as duas saíam erradas ao mesmo
 * tempo: todo INSERT por token morria na FK (medido: 500 em
 * `POST /api/v1/messages`) e uma integração atravessava o modo de teste do
 * canal. Nenhuma das duas aparece como erro de tipo.
 */
import { describe, expect, it } from "vitest";

import { deriveActor } from "./auth";

const TOKEN_ID = "aaaaaaaa-1111-4111-8111-111111111111";
const RUN_ID = "bbbbbbbb-2222-4222-8222-222222222222";

describe("deriveActor", () => {
  it("token comum é `api_token`, NUNCA `user`", () => {
    const ator = deriveActor(["mcp:write"], TOKEN_ID);
    expect(ator.type).toBe("api_token");
    // O `=== "user"` dos handlers é o que decide gravar `actor.id` numa coluna
    // com FK. Se este dia voltar a ser "user", o INSERT volta a morrer.
    expect(ator.type).not.toBe("user");
  });

  it("o id continua sendo o do token — ele é para correlação, não para FK", () => {
    expect(deriveActor(["mcp:read"], TOKEN_ID).id).toBe(TOKEN_ID);
  });

  it("token de AGENTE continua sendo `ai_agent`, com o run no id", () => {
    const ator = deriveActor(["mcp:write", "actor:ai_agent", `agent_run:${RUN_ID}`], TOKEN_ID);
    expect(ator.type).toBe("ai_agent");
    expect(ator.id).toBe(RUN_ID);
    expect(ator.type === "ai_agent" && ator.api_token_id).toBe(TOKEN_ID);
  });

  it("agente sem escopo de run cai no id do token, e segue `ai_agent`", () => {
    const ator = deriveActor(["mcp:write", "actor:ai_agent"], TOKEN_ID);
    expect(ator.type).toBe("ai_agent");
    expect(ator.id).toBe(TOKEN_ID);
  });
});

describe("o que os handlers fazem com este ator", () => {
  // Reproduz o predicado literal que aparece em nove lugares do repo
  // (agenda, contatos, leads, conversas, mensagens).
  const comoOsHandlersDecidem = (ator: ReturnType<typeof deriveActor>) =>
    ator.type === "user" ? ator.id : null;

  it("token não vira `…_by_user_id` — é isso que impede a violação de FK", () => {
    expect(comoOsHandlersDecidem(deriveActor(["mcp:write"], TOKEN_ID))).toBeNull();
  });

  it("e o gate de canal passa a valer para ele", () => {
    // `messages/_handler.ts`: `actor.type === "user" ? null : decidirPreGoLive(...)`.
    // Pular o gate é privilégio de gente, não de integração.
    const pulaOGate = (ator: ReturnType<typeof deriveActor>) => ator.type === "user";
    expect(pulaOGate(deriveActor(["mcp:write"], TOKEN_ID))).toBe(false);
  });
});
