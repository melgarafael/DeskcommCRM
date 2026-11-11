/**
 * O LEITOR DO MODO "IA COM O DONO" (#3967).
 *
 * `conversations.metadata` é jsonb livre, escrito por vários módulos. Tudo aqui é
 * defensivo pela mesma régua do resto do repositório: lixo é AUSÊNCIA.
 *
 * A assimetria dos erros é o que dita o sentido da defensividade:
 *   - errar para "não havia modo" = a conversa fica calada, recuperável num clique;
 *   - errar para "havia" = a IA fala por cima de uma pessoa sem ninguém ter pedido.
 */
import { describe, expect, it } from "vitest";

import {
  CHAVE_DA_IA_COM_DONO,
  donoHumanoVetaIA,
  lerModoIaComDono,
  metadataComModoIaComDono,
  modoProtegeODono,
} from "./ia-com-dono";

describe("lerModoIaComDono", () => {
  it("só o booleano `true` liga", () => {
    expect(lerModoIaComDono({ [CHAVE_DA_IA_COM_DONO]: true })).toBe(true);
  });

  it.each([
    ["false", { [CHAVE_DA_IA_COM_DONO]: false }],
    ["string 'true'", { [CHAVE_DA_IA_COM_DONO]: "true" }],
    ["número 1", { [CHAVE_DA_IA_COM_DONO]: 1 }],
    ["objeto", { [CHAVE_DA_IA_COM_DONO]: { ligado: true } }],
    ["chave ausente", { handoff_tecnico: {} }],
    ["null", null],
    ["undefined", undefined],
    ["array", [true]],
    ["string solta", "ai_com_dono"],
    ["número solto", 1],
  ])("%s não liga", (_nome, metadata) => {
    expect(lerModoIaComDono(metadata)).toBe(false);
  });
});

describe("metadataComModoIaComDono", () => {
  it("ligar preserva o resto do jsonb", () => {
    expect(metadataComModoIaComDono({ handoff_tecnico: { chamado: "T-1" } }, true)).toEqual({
      handoff_tecnico: { chamado: "T-1" },
      ai_com_dono: true,
    });
  });

  it("desligar REMOVE a chave (não grava `false`)", () => {
    const depois = metadataComModoIaComDono({ ai_com_dono: true, outra: 1 }, false);
    expect(depois).toEqual({ outra: 1 });
    expect(CHAVE_DA_IA_COM_DONO in depois).toBe(false);
  });

  it("desligar sobre lixo devolve objeto vazio, sem lançar", () => {
    expect(metadataComModoIaComDono(null, false)).toEqual({});
    expect(metadataComModoIaComDono("lixo", false)).toEqual({});
    expect(metadataComModoIaComDono([1, 2], false)).toEqual({});
  });

  it("não MUTA o objeto de entrada", () => {
    const antes = { ai_com_dono: true, outra: 1 };
    const copia = { ...antes };
    metadataComModoIaComDono(antes, false);
    expect(antes).toEqual(copia);
  });
});

describe("donoHumanoVetaIA", () => {
  it("dono humano sem modo: veta (o de hoje)", () => {
    expect(donoHumanoVetaIA({ assigneeKind: "user", iaComDono: false })).toBe(true);
  });

  it("dono humano COM modo: não veta", () => {
    expect(donoHumanoVetaIA({ assigneeKind: "user", iaComDono: true })).toBe(false);
  });

  it("outros assignee_kind seguem intocados pelo modo", () => {
    expect(donoHumanoVetaIA({ assigneeKind: "ai", iaComDono: false })).toBe(false);
    expect(donoHumanoVetaIA({ assigneeKind: null, iaComDono: false })).toBe(false);
    expect(donoHumanoVetaIA({ assigneeKind: "ai", iaComDono: true })).toBe(false);
  });
});

describe("modoProtegeODono", () => {
  it("exige modo ligado E dono", () => {
    expect(modoProtegeODono({ metadata: { ai_com_dono: true }, assignedToUserId: "u1" })).toBe(true);
    expect(modoProtegeODono({ metadata: { ai_com_dono: true }, assignedToUserId: null })).toBe(false);
    expect(modoProtegeODono({ metadata: {}, assignedToUserId: "u1" })).toBe(false);
    expect(modoProtegeODono({ metadata: null, assignedToUserId: "u1" })).toBe(false);
  });
});
