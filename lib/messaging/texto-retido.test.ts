import { describe, expect, it } from "vitest";

import {
  CHAVE_DO_TEXTO_RETIDO,
  PERFIS_AUTORIZAVEIS,
  blocoDoTextoRetido,
  mascararTextoRetido,
  perfisDoTextoRetido,
  podeVerTextoRetido,
} from "./texto-retido";

/**
 * A régua do texto retido (#4500), medida sem banco e sem HTTP.
 *
 * O que este arquivo prova, e é o que o desenho de segurança da issue manda:
 * a lista COMEÇA VAZIA, é por organização, e papel desconhecido não ganha
 * acesso. A máscara do payload também é provada aqui, porque ela é o que
 * impede o corpo de viajar na leitura normal da conversa.
 */

const comPerfis = (perfis: unknown) => ({ [CHAVE_DO_TEXTO_RETIDO]: { perfis } });

describe("perfis autorizados — começa vazio", () => {
  it("sem bloco em settings, ninguém vê — nem admin", () => {
    expect(perfisDoTextoRetido({})).toEqual([]);
    expect(perfisDoTextoRetido(null)).toEqual([]);
    expect(perfisDoTextoRetido(undefined)).toEqual([]);
    expect(podeVerTextoRetido({}, "admin")).toBe(false);
  });

  it("bloco vazio e formatos errados negam, em vez de estourar", () => {
    expect(perfisDoTextoRetido({ [CHAVE_DO_TEXTO_RETIDO]: {} })).toEqual([]);
    expect(perfisDoTextoRetido({ [CHAVE_DO_TEXTO_RETIDO]: "admin" })).toEqual([]);
    expect(perfisDoTextoRetido(comPerfis("admin"))).toEqual([]);
    expect(perfisDoTextoRetido(comPerfis([null, 7, {}]))).toEqual([]);
    expect(perfisDoTextoRetido("texto")).toEqual([]);
  });

  it("papel desconhecido e `ai_operator` são descartados na leitura", () => {
    expect(perfisDoTextoRetido(comPerfis(["admin", "super_admin", "ai_operator"]))).toEqual([
      "admin",
    ]);
  });
});

describe("perfis autorizados — por organização", () => {
  it("a lista de uma organização não vale para a outra", () => {
    const orgA = comPerfis(["manager"]);
    const orgB = comPerfis([]);

    expect(podeVerTextoRetido(orgA, "manager")).toBe(true);
    expect(podeVerTextoRetido(orgB, "manager")).toBe(false);
  });

  it("lê só os perfis marcados, na ordem em que foram gravados", () => {
    expect(perfisDoTextoRetido(comPerfis(["admin", "manager"]))).toEqual(["admin", "manager"]);
    expect(blocoDoTextoRetido(["manager"])).toEqual({ perfis: ["manager"] });
  });

  it("os perfis oferecidos ao administrador são os papéis humanos", () => {
    expect([...PERFIS_AUTORIZAVEIS]).toEqual(["viewer", "agent", "manager", "admin"]);
  });

  it("papel nulo nunca vê", () => {
    expect(podeVerTextoRetido(comPerfis(["viewer"]), null)).toBe(false);
    expect(podeVerTextoRetido(comPerfis(["viewer"]), undefined)).toBe(false);
  });
});

describe("máscara do payload da conversa", () => {
  const apagadaPeloContato = {
    direction: "inbound",
    revoked_at: "2026-11-10T12:00:00.000Z",
    body: "texto fictício que o contato apagou",
    media_derived_text: null as string | null,
  };

  it("apagada pelo contato: o corpo não sai e o sinal de texto retido fica", () => {
    const mascarada = mascararTextoRetido(apagadaPeloContato);
    expect(mascarada.body).toBeNull();
    expect(mascarada.texto_retido).toBe(true);
    expect(JSON.stringify(mascarada)).not.toContain("texto fictício");
  });

  it("transcrição de mídia da apagada também não sai", () => {
    const mascarada = mascararTextoRetido({
      ...apagadaPeloContato,
      body: null,
      media_derived_text: "áudio transcrito fictício",
    });
    expect(mascarada.media_derived_text).toBeNull();
    expect(mascarada.texto_retido).toBe(true);
  });

  it("sem corpo restante: mascara e NÃO promete botão", () => {
    const mascarada = mascararTextoRetido({ ...apagadaPeloContato, body: "   " });
    expect(mascarada.body).toBeNull();
    expect(mascarada.texto_retido).toBeUndefined();
  });

  it("apagada pelo ATENDENTE mantém o corpo (a régua do balão não muda)", () => {
    const mascarada = mascararTextoRetido({ ...apagadaPeloContato, direction: "outbound" });
    expect(mascarada.body).toBe("texto fictício que o contato apagou");
    expect(mascarada.texto_retido).toBeUndefined();
  });

  it("mensagem viva passa intacta", () => {
    const viva = { direction: "inbound", revoked_at: null, body: "oi" };
    expect(mascararTextoRetido(viva)).toEqual(viva);
  });
});
