import { describe, expect, it } from "vitest";

import { extensionFailure } from "./http";
import { configureRequestSchema } from "./requests";

const configuracao = {
  expected_revision: 1,
  enabled: true,
  configuration: { density: "comfortable", show_description: true },
};

describe("aceite explícito no corpo da configuração", () => {
  it("aceita envio, passagem e leitura opcional juntos após o segundo ato de aceite", () => {
    // É a união que a UI envia quando a organização, que já aceitou os dois
    // efeitos, usa o botão próprio de contexto. O DTO antigo devolvia 422.
    const permissoes = ["turn.send", "turn.handoff", "turn.context"];
    const resultado = configureRequestSchema.safeParse({ ...configuracao, accept_permissions: permissoes });
    const diagnostico = resultado.success ? "" : `borda recusaria com HTTP ${extensionFailure(resultado.error).status}`;
    expect(resultado.success, diagnostico).toBe(true);
    if (resultado.success) expect(resultado.data.accept_permissions).toEqual(permissoes);
  });

  it("não concede contexto quando o ato aceita só os efeitos, nem concede ao omitir aceite", () => {
    expect(configureRequestSchema.parse({ ...configuracao, accept_permissions: ["turn.send", "turn.handoff"] }).accept_permissions)
      .toEqual(["turn.send", "turn.handoff"]);
    expect(configureRequestSchema.parse(configuracao)).not.toHaveProperty("accept_permissions");
  });

  it.each([
    ["quatro valores", ["turn.send", "turn.handoff", "turn.context", "turn.send"]],
    ["permissão fora do turno", ["navigation.inbox"]],
  ])("recusa %s com 422", (_caso, accept_permissions) => {
    const resultado = configureRequestSchema.safeParse({ ...configuracao, accept_permissions });
    expect(resultado.success).toBe(false);
    if (!resultado.success) expect(extensionFailure(resultado.error).status).toBe(422);
  });
});
