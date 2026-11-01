import { describe, expect, it } from "vitest";

import { corDoParticipante, PALETA_DE_PARTICIPANTES } from "@/lib/messaging/cor-do-participante";

describe("cor do participante no grupo", () => {
  it("a mesma pessoa tem sempre a mesma cor", () => {
    const a = { lid: "123456789", phone: "+5511999990000", name: "Ana" };
    expect(corDoParticipante(a)).toBe(corDoParticipante({ ...a, name: "Ana Paula" }));
    expect(PALETA_DE_PARTICIPANTES).toContain(corDoParticipante(a));
  });

  it("a identidade é o lid; sem ele, o telefone; sem ele, o nome", () => {
    expect(corDoParticipante({ lid: null, phone: "+5511988887777", name: "X" })).toBe(
      corDoParticipante({ lid: null, phone: "+5511988887777", name: "Y" }),
    );
    expect(corDoParticipante({ lid: null, phone: null, name: null })).toBeNull();
  });

  it("pessoas diferentes se espalham pela paleta", () => {
    const cores = new Set(
      Array.from({ length: 40 }, (_, i) =>
        corDoParticipante({ lid: String(100000 + i * 7919), phone: null, name: null }),
      ),
    );
    expect(cores.size).toBeGreaterThanOrEqual(8);
  });
});
