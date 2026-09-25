import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Com o canal oficial e um parceiro (Datafy, Zernio) espelhando o mesmo
// nome+idioma, `meta_templates` tem duas linhas; a busca de
// `sendTemplateForSession` usa `.maybeSingle()` e só escolhe uma quando recebe
// `channelSessionId`. Achado da revisão adversarial do #1492.
const FONTE = readFileSync(join(process.cwd(), "app/api/v1/messages/_handler.ts"), "utf8");

describe("envio de modelo pelo handler de mensagens", () => {
  it("toda chamada de sendTemplateForSession passa a conexão da conversa", () => {
    const chamadas = FONTE.split("sendTemplateForSession(").slice(1).map((trecho) => trecho.split("});")[0]);
    expect(chamadas.length).toBeGreaterThan(0);
    for (const corpo of chamadas) expect(corpo).toMatch(/channelSessionId:/);
  });
});
