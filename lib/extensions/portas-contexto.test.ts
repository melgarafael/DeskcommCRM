import { describe, expect, it } from "vitest";
import { portasLegiveis } from "./portas-legiveis";

describe("a leitura opcional aparece com seu próprio efeito", () => {
  it("não descreve leitura como passagem para humano", () => {
    const frase = portasLegiveis(["turn.context"]);
    expect(frase).toContain("contexto já selecionado desta conversa");
    expect(frase).not.toContain("Passa a conversa");
  });
  it("porta de tela junto de contexto não promete que nenhum dado será lido", () => {
    const frase = portasLegiveis(["navigation.inbox", "turn.context"]);
    expect(frase).toContain("Conversas");
    expect(frase).toContain("contexto já selecionado desta conversa");
    expect(frase).not.toContain("não lê seus dados");
  });
});
