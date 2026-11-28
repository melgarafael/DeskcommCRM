import { describe, expect, it } from "vitest";

import { getAdapter } from "@/lib/channels";
import {
  capabilitiesOf,
  modoDeCampanhaDoCanal,
  PROVIDERS_DE_MENSAGEM,
  PROVIDERS_DE_TELEFONE,
  transportaMensagem,
} from "@/lib/channels/capabilities";
import { ehCanalDeConversa } from "@/lib/channels/canais-de-conversa";
import { CHANNEL_SESSION_REF_COLUMNS, resolveSessionRef } from "@/lib/channels/session-ref";
import { origemDoNegocioPeloCanal } from "@/lib/channels/origem-do-negocio";
import { REDES_COM_TESTADOR_SOCIAL } from "@/lib/ai/elegibilidade/pre-go-live";

/**
 * O CHAT NO SITE NO SEAM DE CANAIS (Spec 36, F1, Task 2).
 *
 * O canal é de MENSAGEM sem telefone: manda texto livre a qualquer hora, não
 * tem campanha, não tem agenda, não tem template. Cada assertiva abaixo fecha
 * uma decisão por lugar; quem esquecer uma delas não sai do teste verde.
 */

describe("capability do chat no site", () => {
  it("a matriz conhece o provider com o perfil medido", () => {
    expect(capabilitiesOf("webchat")).toEqual({
      freeformOutsideWindow: true,
      requiresTemplates: false,
      canManageTemplates: false,
      banRisk: false,
      minIntervalMs: 0,
      voiceNote: "none",
      groups: "none",
      costPerMessage: false,
      alteraMensagemEnviada: false,
      podeReagir: false,
      transmissao: false,
      phonebook: false,
      statusUpdates: false,
      reportaConversao: false,
      marcaLidasPorMensagem: false,
    });
  });

  it("é canal de mensagem, mas não de telefone", () => {
    expect(PROVIDERS_DE_MENSAGEM).toContain("webchat");
    expect(transportaMensagem("webchat")).toBe(true);
    expect(PROVIDERS_DE_TELEFONE).not.toContain("webchat");
  });

  it("não faz campanha: texto livre na conversa, nunca disparo em massa", () => {
    // `freeformOutsideWindow: true` faria a campanha responder "text". Quem decide
    // que o chat fica de fora é `PROVIDERS_SEM_CAMPANHA`, e é isso que o teste mede.
    expect(modoDeCampanhaDoCanal("webchat")).toBeNull();
  });
});

describe("lista de canais, origem e testador", () => {
  it("o chat é canal de conversa", () => {
    expect(ehCanalDeConversa("webchat")).toBe(true);
  });

  it("a origem do negócio nasce com o rótulo e a fonte do chat", () => {
    const origem = origemDoNegocioPeloCanal("webchat");
    expect(origem.source).toBe("webchat");
    expect(origem.rotulo).toBe("Chat no site");
  });

  it("o chat não entra como rede de testador de IA", () => {
    expect(REDES_COM_TESTADOR_SOCIAL).not.toContain("webchat");
  });
});

describe("referência da sessão", () => {
  it("a sessão do chat é endereçada pela chave pública", () => {
    expect(resolveSessionRef({ provider: "webchat", webchat_public_key: "wck_chave" })).toBe("wck_chave");
  });

  it("a leitura da sessão traz a coluna da chave", () => {
    expect(CHANNEL_SESSION_REF_COLUMNS).toContain("webchat_public_key");
  });
});

describe("adapter registrado", () => {
  it("o seam devolve o adapter do chat", () => {
    expect(getAdapter("webchat").provider).toBe("webchat");
  });
});
