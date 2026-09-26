import { readFileSync } from "node:fs";

import { describe, expect, it, vi } from "vitest";

import { sendInBubbles } from "@/lib/agent-engine/agent/split-message";

describe("sendInBubbles", () => {
  it("split off → 1 envio com o corpo inteiro", async () => {
    const send = vi.fn(async () => ({ kind: "sent", messageId: "m" }));
    const sleep = vi.fn(async () => undefined);
    const out = await sendInBubbles("um texto qualquer", { enabled: false, maxChars: 600, send, sleep, jitter: () => 0 });
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith("um texto qualquer");
    expect(out.kind).toBe("sent");
  });

  it("split on + texto longo → N envios com jitter entre eles", async () => {
    const send = vi.fn(async () => ({ kind: "sent", messageId: "m" }));
    const sleep = vi.fn(async () => undefined);
    const text = "Primeira ideia aqui.\n\nSegunda ideia aqui.\n\nTerceira ideia aqui.";
    const out = await sendInBubbles(text, { enabled: true, maxChars: 25, send, sleep, jitter: () => 900 });
    expect(send.mock.calls.length).toBeGreaterThanOrEqual(3);
    expect(sleep).toHaveBeenCalledWith(900); // jitter entre bolhas
    expect(out.kind).toBe("sent");
  });

  it("chama `antesDaPrimeira` UMA vez, antes do 1º envio, com a 1ª bolha", async () => {
    // O atraso humano é do TURNO, não de cada bolha: entre bolhas já existe o
    // jitter anti-ban. Chamá-lo por bolha somaria duas esperas na mesma pausa.
    const ordem: string[] = [];
    const send = vi.fn(async (b: string) => {
      ordem.push(`send:${b}`);
      return { kind: "sent", messageId: "m" };
    });
    const antesDaPrimeira = vi.fn(async (b: string) => {
      ordem.push(`antes:${b}`);
    });
    const text = "Bolha um aqui.\n\nBolha dois aqui.\n\nBolha três aqui.";

    await sendInBubbles(text, {
      enabled: true,
      maxChars: 20,
      send,
      sleep: async () => undefined,
      jitter: () => 0,
      antesDaPrimeira,
    });

    expect(antesDaPrimeira).toHaveBeenCalledTimes(1);
    expect(ordem[0]).toBe("antes:Bolha um aqui.");
    expect(ordem[1]).toBe("send:Bolha um aqui.");
  });

  it("sem `antesDaPrimeira` o comportamento é o de sempre", async () => {
    const send = vi.fn(async () => ({ kind: "sent", messageId: "m" }));
    const out = await sendInBubbles("texto", {
      enabled: false,
      maxChars: 600,
      send,
      sleep: async () => undefined,
      jitter: () => 0,
    });
    expect(send).toHaveBeenCalledTimes(1);
    expect(out.kind).toBe("sent");
  });

  it("para no primeiro envio não-sent (veto/falha) e devolve esse outcome", async () => {
    const send = vi
      .fn()
      .mockResolvedValueOnce({ kind: "sent", messageId: "m1" })
      .mockResolvedValueOnce({ kind: "blocked" });
    const sleep = vi.fn(async () => undefined);
    const text = "Bolha um aqui.\n\nBolha dois aqui.\n\nBolha três aqui.";
    const out = await sendInBubbles(text, { enabled: true, maxChars: 20, send, sleep, jitter: () => 0 });
    expect(out.kind).toBe("blocked");
    expect(send).toHaveBeenCalledTimes(2); // parou na 2ª
  });

  // Um parágrafo = uma bolha (#1724). Sem teto, um único send_message de 7 parágrafos
  // sairia em 7 mensagens físicas no mesmo turno — o que MAX_SENDS_PER_TURN (padrão 3,
  // "bolhas incluídas") existe para barrar. O que passa do teto vai junto na última.
  const seteParagrafos = ["Opções:", "1. Azul", "2. Verde", "3. Preto", "4. Branco", "5. Rosa", "Qual prefere?"];

  it("com maxBubbles 3, 7 parágrafos saem em 3 envios, o excedente junto na última, na ordem", async () => {
    const send = vi.fn(async (_b: string) => ({ kind: "sent", messageId: "m" }));
    await sendInBubbles(seteParagrafos.join("\n\n"), {
      enabled: true,
      maxChars: 600,
      maxBubbles: 3,
      send,
      sleep: async () => undefined,
      jitter: () => 0,
    });
    expect(send.mock.calls.map((c) => c[0])).toEqual([
      "Opções:",
      "1. Azul",
      seteParagrafos.slice(2).join("\n\n"),
    ]);
  });

  it("com maxBubbles 1, sai uma bolha só com o texto inteiro", async () => {
    const send = vi.fn(async (_b: string) => ({ kind: "sent", messageId: "m" }));
    await sendInBubbles(seteParagrafos.join("\n\n"), {
      enabled: true,
      maxChars: 600,
      maxBubbles: 1,
      send,
      sleep: async () => undefined,
      jitter: () => 0,
    });
    expect(send.mock.calls.map((c) => c[0])).toEqual([seteParagrafos.join("\n\n")]);
  });

  it("o turno passa o que resta do teto nos DOIS pontos: a pausa humana e o envio", () => {
    // A pausa é medida pela 1ª bolha do MESMO fatiamento que vai ao canal; com
    // maxBubbles 1 a 1ª bolha é o texto inteiro, então os dois têm de receber o teto.
    const turno = readFileSync("lib/agent-engine/agent/inbound-turn.ts", "utf8");
    expect(turno.match(/Math\.max\(1, maxSendsPerTurn - seq\)/g)?.length).toBe(2);
    expect(turno).toMatch(/maxBubbles: Math\.max\(1, maxSendsPerTurn - seq\)/);
  });
});
