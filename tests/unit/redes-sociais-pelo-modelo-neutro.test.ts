import { describe, expect, it, vi } from "vitest";

import { capabilitiesOf, PROVIDERS_DE_MENSAGEM } from "@/lib/channels/capabilities";
import { CANAIS_DE_CONVERSA } from "@/lib/channels/canais-de-conversa";
import type { ChannelAdapter, OutboundEnvelope } from "@/lib/channels/types";
import {
  adaptadorDaPorta,
  PortaSemCredencialError,
  PortaSemTransporteError,
} from "@/lib/channels/social/adaptador-da-porta";
import { inboxSupported, SOCIAL_NETWORKS, SOCIAL_PROVIDER } from "@/lib/channels/social/catalog";
import {
  exigenciasEmFalta,
  PORTAS_SOCIAIS,
  portaDaRede,
  portaDisponivel,
  portasDaRede,
} from "@/lib/channels/social/porta";

import { nomeiaProvider } from "../../scripts/lint-channels.pattern";

/**
 * O MODELO NEUTRO DE FORNECEDOR PARA REDES SOCIAIS (issue #1320).
 *
 * O que este arquivo prova, e por que cada parte existe:
 *
 *   1. **O Instagram é declarado PELO MODELO** — não por uma constante de
 *      fornecedor. É a condição de o #965 voltar.
 *   2. **A conexão direta não existe, e o modelo DIZ isso** — a lacuna vira
 *      expressão (`portaDisponivel`), não comentário.
 *   3. **Uma conexão sem credencial falha dizendo o que falta** — e nunca finge
 *      sucesso, nem antes (`isConfigured`) nem depois (`send`).
 *   4. **CONTROLE: os canais que já existiam continuam declarados e verdes** —
 *      o modelo entra sem tirar nada do ar.
 *
 * O que ele NÃO prova: que a conexão direta com o Instagram funcione. Ela não
 * existe — é o recorte declarado do PR, e a prova de que não existe está em (2).
 */

/**
 * O erro que o envio lançou — e, se ele NÃO lançou, um erro que reprova o teste.
 *
 * Existe porque "não lançou" é justamente o defeito que se procura: um helper
 * que devolvesse `undefined` no caminho feliz esconderia a asserção seguinte
 * (`erro.message`) e o teste passaria a medir nada.
 */
async function recusaDe(promessa: Promise<unknown>): Promise<Error> {
  try {
    await promessa;
  } catch (erro) {
    return erro as Error;
  }
  throw new Error("o envio foi aceito sem credencial — devia ter recusado");
}

const ENVELOPE: OutboundEnvelope = {
  organizationId: "org-teste",
  sessionRef: "conta-1",
  to: "provider-thread",
  kind: "text",
  body: "olá",
};

describe("o catálogo declara o Instagram pelo modelo neutro", () => {
  it("o Instagram tem as duas portas, e a direta é a preferida", () => {
    const portas = portasDaRede("instagram");
    expect(portas.map((p) => p.id)).toEqual(["direta", "intermediada"]);
    // Preferida = a primeira declarada: a decisão do dono é que o parceiro seja
    // porta OPCIONAL, então a direta vem na frente.
    expect(portaDaRede("instagram").id).toBe("direta");
  });

  it("a porta direta é declarada SEM transporte — é o que trava o #965", () => {
    const direta = PORTAS_SOCIAIS.direta;
    expect(direta.implementada).toBe(false);
    // `null` porque o CHECK de `channel_sessions.provider` não tem valor para
    // ela, e `ChannelAdapter.provider` é obrigatório: não há adapter a montar.
    expect(direta.providerNoBanco).toBeNull();
    // A resposta útil é `null`, e não uma exceção: quem pergunta "dá para montar
    // a direta hoje?" recebe "não" sem ter que tratar erro.
    expect(portaDisponivel("instagram")?.id).toBe("intermediada");
  });

  it("a porta intermediada é a que já existe, e é a que grava a coluna", () => {
    expect(PORTAS_SOCIAIS.intermediada.implementada).toBe(true);
    expect(PORTAS_SOCIAIS.intermediada.providerNoBanco).toBe(SOCIAL_PROVIDER);
  });

  it("rede desconhecida falha alto em vez de devolver lista vazia", () => {
    expect(() => portasDaRede("orkut")).toThrow(/rede_social_desconhecida: orkut/);
    expect(() => portaDaRede("instagram", "satelite" as never)).toThrow(
      /porta_nao_declarada: instagram\/satelite/,
    );
  });

  it("toda rede do catálogo declara ao menos uma porta", () => {
    for (const rede of SOCIAL_NETWORKS) {
      expect(rede.portas.length, `${rede.id} não declarou porta`).toBeGreaterThan(0);
    }
  });
});

describe("CONTROLE: os canais que já existiam continuam declarados", () => {
  it("as quinze redes do catálogo continuam lá, com o mesmo atendimento", () => {
    // A lista é escrita à mão de propósito: é a fotografia do que existia antes
    // do modelo, e é ela que denuncia uma rede que some numa refatoração.
    expect(SOCIAL_NETWORKS.map((r) => r.id)).toEqual([
      "instagram",
      "facebook",
      "linkedin",
      "twitter",
      "tiktok",
      "youtube",
      "threads",
      "reddit",
      "pinterest",
      "bluesky",
      "googlebusiness",
      "telegram",
      "snapchat",
      "discord",
      "slack",
    ]);
    expect(SOCIAL_NETWORKS.filter((r) => r.inbox).map((r) => r.id)).toEqual([
      "instagram",
      "facebook",
    ]);
    // `googlebusiness` e `telegram` entram aqui de propósito: são as duas redes
    // que o produto nomeia sem ter transporte próprio, e o modelo não as toca.
    expect(inboxSupported("googlebusiness")).toBe(false);
    expect(inboxSupported("telegram")).toBe(false);
  });

  it("o vocabulário de canal da conversa não mudou", () => {
    expect([...CANAIS_DE_CONVERSA]).toEqual(["whatsapp", "instagram", "facebook"]);
  });

  it("a matriz de capabilities segue respondendo por todos os canais de mensagem", () => {
    expect([...PROVIDERS_DE_MENSAGEM]).toEqual([
      "waha",
      "meta_cloud",
      "zernio",
      "zernio_social",
      "datafy",
    ]);
    for (const provider of PROVIDERS_DE_MENSAGEM) {
      const caps = capabilitiesOf(provider);
      expect(caps, `${provider} sem capabilities`).toBeTruthy();
    }
    // O canal social continua com o perfil que estava medido — o modelo não
    // reescreve física de plataforma nenhuma.
    expect(capabilitiesOf("zernio_social")).toMatchObject({
      freeformOutsideWindow: false,
      requiresTemplates: false,
      groups: "none",
    });
  });
});

describe("o adapter de uma porta sem credencial falha dizendo o que falta", () => {
  it("sem token, recusa com a REDE e a exigência nomeadas — e não toca a rede", async () => {
    const enviados: OutboundEnvelope[] = [];
    const transporte: ChannelAdapter = {
      provider: SOCIAL_PROVIDER,
      resolveRecipient: () => "provider-thread",
      isConfigured: () => true,
      codes: { notConfigured: "x", sendFailed: "y", unknownError: "z" },
      async send(envelope) {
        enviados.push(envelope);
        return { externalId: "nunca-devia-chegar-aqui" };
      },
    };

    const adapter = adaptadorDaPorta({
      plataforma: "instagram",
      porta: "intermediada",
      credencial: { conta: "conta-1", token: null },
      transporte,
    });

    await expect(adapter.send(ENVELOPE)).rejects.toThrow(PortaSemCredencialError);
    await expect(adapter.send(ENVELOPE)).rejects.toThrow(
      "Instagram: falta a credencial da conta (token de acesso) para enviar pela conexão por parceiro. Reconecte a conta em Redes sociais.",
    );
    // A prova de que não finge sucesso: o transporte não foi chamado uma vez
    // sequer. `{externalId: null}` seria o outro jeito de mentir — "não tentei"
    // gravado igual a "tentei e não voltou id".
    expect(enviados).toHaveLength(0);
  });

  it("sem conta e sem token, diz as DUAS coisas que faltam, na ordem da porta", async () => {
    const adapter = adaptadorDaPorta({
      plataforma: "instagram",
      porta: "intermediada",
      credencial: null,
    });
    const erro = await recusaDe(adapter.send(ENVELOPE));
    expect(erro).toBeInstanceOf(PortaSemCredencialError);
    expect((erro as PortaSemCredencialError).falta).toEqual(["credencial_da_conta"]);
    expect(erro.message).toContain("Instagram");
    expect(erro.message).toContain("credencial da conta (token de acesso)");
  });

  it("a recusa não nomeia fornecedor — medido pela própria cerca do invariante 1", async () => {
    const adapter = adaptadorDaPorta({
      plataforma: "instagram",
      porta: "intermediada",
      credencial: { conta: null, token: null },
    });
    const erro = await recusaDe(adapter.send(ENVELOPE));
    expect(nomeiaProvider(erro.message)).toBe(false);
    expect(erro.message).not.toMatch(/zernio|waha|meta_cloud/i);
  });

  it("os códigos também são neutros: `codes` não pode nomear quem opera a porta", () => {
    const adapter = adaptadorDaPorta({
      plataforma: "instagram",
      porta: "intermediada",
      credencial: { conta: "conta-1", token: "tok" },
    });
    for (const codigo of Object.values(adapter.codes)) {
      expect(nomeiaProvider(codigo), `${codigo} nomeia fornecedor`).toBe(false);
    }
    expect(adapter.codes.notConfigured).toBe("porta_sem_credencial");
  });

  /**
   * `isConfigured() === false` faz `app/api/v1/messages/_handler.ts` deixar a
   * mensagem em `queued` e NUNCA chamar `send` — o defeito que `adapters/zernio.ts`
   * documenta. Este teste existe para que ninguém "conserte" a honestidade do
   * adapter reintroduzindo a fila eterna.
   */
  it("`isConfigured` responde `true` mesmo sem credencial: quem desiste é o send", async () => {
    const adapter = adaptadorDaPorta({
      plataforma: "instagram",
      porta: "intermediada",
      credencial: { conta: "conta-1", token: null },
    });
    expect(adapter.isConfigured()).toBe(true);
    await expect(adapter.send(ENVELOPE)).rejects.toThrow(PortaSemCredencialError);
  });

  it("com credencial e transporte, delega — e devolve o id do transporte", async () => {
    const enviar = vi.fn(async () => ({ externalId: "id-do-transporte" }));
    const adapter = adaptadorDaPorta({
      plataforma: "instagram",
      porta: "intermediada",
      credencial: { conta: "conta-1", token: "tok" },
      transporte: {
        provider: SOCIAL_PROVIDER,
        resolveRecipient: () => "provider-thread",
        isConfigured: () => true,
        codes: { notConfigured: "x", sendFailed: "y", unknownError: "z" },
        send: enviar,
      },
    });
    await expect(adapter.send(ENVELOPE)).resolves.toEqual({ externalId: "id-do-transporte" });
    expect(enviar).toHaveBeenCalledOnce();
  });

  it("com credencial e SEM transporte, recusa dizendo que o transporte falta", async () => {
    const adapter = adaptadorDaPorta({
      plataforma: "instagram",
      porta: "intermediada",
      credencial: { conta: "conta-1", token: "tok" },
    });
    await expect(adapter.send(ENVELOPE)).rejects.toThrow(PortaSemTransporteError);
  });

  it("a porta direta não vira adapter: falta valor no CHECK de `channel_sessions.provider`", () => {
    expect(() =>
      adaptadorDaPorta({
        plataforma: "instagram",
        porta: "direta",
        credencial: { conta: "conta-1", token: "tok" },
      }),
    ).toThrow(PortaSemTransporteError);
    expect(() =>
      adaptadorDaPorta({ plataforma: "instagram", porta: "direta", credencial: null }),
    ).toThrow(/conexão direta ainda não tem valor em channel_sessions\.provider/);
  });

  it("rede sem token nenhum: `exigenciasEmFalta` devolve TUDO o que a porta exige", () => {
    expect(exigenciasEmFalta(PORTAS_SOCIAIS.direta, null)).toEqual([
      "conta_autorizada",
      "credencial_da_conta",
    ]);
    expect(exigenciasEmFalta(PORTAS_SOCIAIS.intermediada, { conta: "c", token: "t" })).toEqual([]);
    // Espaço em branco não é credencial: a coluna às vezes volta com `" "` de um
    // formulário, e tratar isso como "tem" mandaria a recusa para o transporte.
    expect(exigenciasEmFalta(PORTAS_SOCIAIS.intermediada, { conta: "c", token: "   " })).toEqual([
      "credencial_da_conta",
    ]);
  });
});
