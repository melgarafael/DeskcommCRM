import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Adapter do canal intermediado — o transporte.
 *
 * O contrato aqui não foi lido da doc: foi MEDIDO contra a API real antes de o
 * adapter existir. As formas abaixo são as respostas que ela devolveu:
 *
 *   POST /v1/inbox/conversations              → 201 { success, data:{ messageId, conversationId } }
 *   POST /v1/inbox/conversations/{id}/messages → 200 { success, data:{ messageId, conversationId } }
 *
 * O `messageId` é um **wamid da Meta**, não um id do intermediário — mesmo
 * espaço de identificador do canal oficial, então o eco do webhook casa direto.
 *
 * O que se prova: que o adapter endereça pela THREAD e não pelo telefone (a
 * diferença que morde quem copia o adapter do canal oficial), que falha alto
 * quando não há thread, e que continua sendo só um tradutor de formato.
 */

const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({}) }));

const credsRef: { current: unknown } = { current: null };
vi.mock("@/lib/channels/zernio/credentials", () => ({
  resolveZernioCreds: async () => credsRef.current,
  zernioCredsFromEnv: () => credsRef.current,
}));

import { zernioAdapter } from "@/lib/channels/adapters/zernio";
import { deriveTemplateContract } from "@/lib/channels/meta/template-contract";

const CREDS = {
  accountId: "6a3572a15f7d1751ab117832",
  apiKey: "sk_test",
  baseUrl: "https://zernio.com/api",
  source: "session" as const,
};
const WAMID = "wamid.HBgMNTk1OTkxNzMzNjg1FQIAERgSNDBFOTkzMUMxMEY4RjVERDZFAA==";
const THREAD = "6a3580f68fcd5b3a5b946bf8";

/**
 * A organização atravessa o seam de canal desde a issue #236: `sessionRef` é
 * identificador do PROVIDER e não identifica linha sozinho.
 */
const ORG = "00000000-0000-4000-8000-000000000236";

function respondeOk(status = 200) {
  fetchMock.mockResolvedValueOnce({
    ok: true,
    status,
    json: async () => ({ success: true, data: { messageId: WAMID, conversationId: THREAD } }),
  });
}

const ultimaChamada = () => ({
  url: String(fetchMock.mock.calls.at(-1)?.[0] ?? ""),
  init: (fetchMock.mock.calls.at(-1)?.[1] ?? {}) as { headers?: Record<string, string>; body?: string },
});
const corpo = () => JSON.parse(ultimaChamada().init.body ?? "{}") as Record<string, unknown>;

beforeEach(() => {
  fetchMock.mockReset();
  credsRef.current = CREDS;
});

describe("resolveRecipient", () => {
  it("devolve o telefone em dígitos — é o participantId da API", () => {
    expect(
      zernioAdapter.resolveRecipient({
        isGroup: false,
        groupChatId: null,
        phoneNumber: "+595 (99) 173-3685",
        waIdentity: null,
      }),
    ).toBe("595991733685");
  });

  it("prefere o wa_identity de telefone quando existe", () => {
    expect(
      zernioAdapter.resolveRecipient({
        isGroup: false,
        groupChatId: null,
        phoneNumber: "000",
        waIdentity: "phone:+595991733685",
      }),
    ).toBe("595991733685");
  });

  it("grupo devolve null — a API de grupos é outro recurso, com id próprio", () => {
    expect(
      zernioAdapter.resolveRecipient({
        isGroup: true,
        groupChatId: "123@g.us",
        phoneNumber: null,
        waIdentity: null,
      }),
    ).toBeNull();
  });

  it("sem telefone devolve o id OPACO — dizer null é afirmar que não dá para falar com quem acabou de escrever", () => {
    // Medido em produção: contato do rollout novo (BSUID, sem telefone) fazia o
    // envio parar em `missing_phone_number`. Para este canal o telefone não
    // endereça nada — quem endereça é a thread.
    expect(
      zernioAdapter.resolveRecipient({
        isGroup: false,
        groupChatId: null,
        phoneNumber: null,
        waIdentity: "lid:PY.853283837822954",
      }),
    ).toBe("PY.853283837822954");
  });

  it("sem telefone E sem identidade devolve null — aí sim não há destinatário", () => {
    expect(
      zernioAdapter.resolveRecipient({
        isGroup: false,
        groupChatId: null,
        phoneNumber: null,
        waIdentity: null,
      }),
    ).toBeNull();
  });
});

describe("send — endereça pela THREAD, não pelo telefone", () => {
  it("põe a thread na URL e o accountId no corpo", async () => {
    respondeOk(200);
    await zernioAdapter.send({
      organizationId: ORG,
      sessionRef: CREDS.accountId,
      to: "595991733685",
      providerConversationId: THREAD,
      kind: "text",
      body: "olá",
    });

    expect(ultimaChamada().url).toBe(
      `https://zernio.com/api/v1/inbox/conversations/${THREAD}/messages`,
    );
    expect(corpo()).toMatchObject({ accountId: CREDS.accountId, message: "olá" });
    // O telefone NÃO endereça este envio — se aparecer na URL, alguém copiou o
    // adapter do canal oficial sem ler a diferença.
    expect(ultimaChamada().url).not.toContain("595991733685");
  });

  it("autentica com Bearer", async () => {
    respondeOk();
    await zernioAdapter.send({
      organizationId: ORG,
      sessionRef: CREDS.accountId,
      to: "595991733685",
      providerConversationId: THREAD,
      kind: "text",
      body: "x",
    });
    expect(ultimaChamada().init.headers?.Authorization).toBe("Bearer sk_test");
  });

  it("devolve o wamid como externalId", async () => {
    respondeOk();
    const r = await zernioAdapter.send({
      organizationId: ORG,
      sessionRef: CREDS.accountId,
      to: "5959",
      providerConversationId: THREAD,
      kind: "text",
      body: "x",
    });
    expect(r.externalId).toBe(WAMID);
  });

  it("aceita 201 tanto quanto 200 — abrir conversa e responder devolvem códigos diferentes", async () => {
    respondeOk(201);
    const r = await zernioAdapter.send({
      organizationId: ORG,
      sessionRef: CREDS.accountId,
      to: "5959",
      providerConversationId: THREAD,
      kind: "text",
      body: "x",
    });
    expect(r.externalId).toBe(WAMID);
  });

  it("SEM thread lança com motivo nomeado, em vez de montar URL com undefined", async () => {
    await expect(
      zernioAdapter.send({
        organizationId: ORG,
        sessionRef: CREDS.accountId,
        to: "595991733685",
        kind: "text",
        body: "x",
      }),
    ).rejects.toThrow(/zernio_no_conversation/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("sem credencial LANÇA — um `sent` sem id diria enviado para o que nunca saiu", async () => {
    credsRef.current = null;
    await expect(
      zernioAdapter.send({
        organizationId: ORG,
        sessionRef: "x",
        to: "y",
        providerConversationId: THREAD,
        kind: "text",
        body: "z",
      }),
    ).rejects.toThrow(/zernio_not_configured/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("isConfigured é SEMPRE true — a credencial vive na sessão, e isto é síncrono", async () => {
    // Medido em produção: olhar só o env respondia "não configurado" para toda
    // instalação que conectou pela tela, e o handler gravava `queued` sem nunca
    // chamar `send`. A mensagem ficava parada, sem erro, com o canal ligado.
    credsRef.current = null;
    expect(zernioAdapter.isConfigured()).toBe(true);
    credsRef.current = CREDS;
    expect(zernioAdapter.isConfigured()).toBe(true);
  });
});

describe("send — mídia", () => {
  const media = { url: "https://s/x.jpg", mime: "image/jpeg", filename: "x.jpg", caption: "olha" };

  it("imagem vira attachmentType image com a legenda em message", async () => {
    respondeOk();
    await zernioAdapter.send({
      organizationId: ORG,
      sessionRef: CREDS.accountId,
      to: "5959",
      providerConversationId: THREAD,
      kind: "image",
      media,
    });
    expect(corpo()).toMatchObject({
      attachmentType: "image",
      attachmentUrl: media.url,
      attachmentName: "x.jpg",
      message: "olha",
    });
  });

  it("áudio pede voiceNote — sem a flag chega como anexo de música", async () => {
    respondeOk();
    await zernioAdapter.send({
      organizationId: ORG,
      sessionRef: CREDS.accountId,
      to: "5959",
      providerConversationId: THREAD,
      kind: "audio",
      media: { ...media, mime: "audio/ogg", filename: "a.ogg", caption: null },
    });
    expect(corpo()).toMatchObject({ attachmentType: "audio", voiceNote: true });
  });

  it("áudio com legenda NÃO manda message — a bolha de voz não leva legenda (#3266)", async () => {
    respondeOk();
    await zernioAdapter.send({
      organizationId: ORG,
      sessionRef: CREDS.accountId,
      to: "5959",
      providerConversationId: THREAD,
      kind: "audio",
      media: { ...media, mime: "audio/ogg", filename: "a.ogg", caption: "olha" },
    });
    expect(corpo()).toMatchObject({ attachmentType: "audio", voiceNote: true });
    expect(corpo()).not.toHaveProperty("message");
  });

  it("documento cai em file, não em image", async () => {
    respondeOk();
    await zernioAdapter.send({
      organizationId: ORG,
      sessionRef: CREDS.accountId,
      to: "5959",
      providerConversationId: THREAD,
      kind: "document",
      media: { ...media, mime: "application/pdf", filename: "d.pdf", caption: null },
    });
    expect(corpo().attachmentType).toBe("file");
  });
});

describe("erros", () => {
  it("erro do provider carrega o CODE — é o que distingue fora-da-janela de bloqueado", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 400,
      statusText: "Bad Request",
      json: async () => ({ error: "24h window closed", code: "PLATFORM_LIMITATION" }),
    });
    await expect(
      zernioAdapter.send({
        organizationId: ORG,
        sessionRef: CREDS.accountId,
        to: "5959",
        providerConversationId: THREAD,
        kind: "text",
        body: "x",
      }),
    ).rejects.toThrow(/PLATFORM_LIMITATION/);
  });

  it("success:false com HTTP 200 também é falha", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ success: false, error: "nope" }),
    });
    await expect(
      zernioAdapter.send({
        organizationId: ORG,
        sessionRef: CREDS.accountId,
        to: "5959",
        providerConversationId: THREAD,
        kind: "text",
        body: "x",
      }),
    ).rejects.toThrow(/zernio_send_failed/);
  });
});

describe("sendTemplate — o contrato conferido decide onde cada valor vai", () => {
  // docs.zernio.com/messages/create-inbox-conversation (15/10/2026): texto do
  // cabeçalho + corpo + sufixo de link numa lista plana; imagem em headerMedia.
  // Antes, só as chaves numéricas do corpo saíam: a imagem trocada e o valor do
  // cabeçalho se perdiam sem aviso.
  const contrato = deriveTemplateContract({
    name: "oferta_cafeteira",
    language: "pt_BR",
    parameter_format: "POSITIONAL",
    components: [
      { type: "HEADER", format: "IMAGE" },
      { type: "BODY", text: "Olá {{1}}, sua {{2}}" },
      { type: "BUTTONS", buttons: [{ type: "URL", text: "Ver", url: "https://loja.exemplo.com.br/{{1}}" }] },
    ] as never,
  });

  it("manda headerMedia e a lista na ordem do contrato", async () => {
    respondeOk(201);
    await zernioAdapter.sendTemplate!({
      organizationId: ORG,
      sessionRef: CREDS.accountId,
      to: "5511900000710",
      name: "oferta_cafeteira",
      language: "pt_BR",
      values: { "button0:1": "cafeteira", "2": "encomenda", "1": "Ana", "header:1": "https://cdn.x/p.jpg" },
      contrato,
    });
    expect(ultimaChamada().url).toBe(`${CREDS.baseUrl}/v1/inbox/conversations`);
    expect(corpo()).toMatchObject({
      templateName: "oferta_cafeteira",
      templateLanguage: "pt_BR",
      templateParams: ["Ana", "encomenda", "cafeteira"],
      headerMedia: { type: "image", link: "https://cdn.x/p.jpg" },
    });
  });

  it("a recusa carrega o código da plataforma marcado — é ele que diz se a campanha para", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 400,
      statusText: "Bad Request",
      json: async () => ({ error: "Template paused", code: "platform_api_error", platformError: { code: 132015 } }),
    });
    await expect(
      zernioAdapter.sendTemplate!({
        organizationId: ORG,
        sessionRef: CREDS.accountId,
        to: "5511900000710",
        name: "oferta_cafeteira",
        language: "pt_BR",
        values: { "1": "Ana", "2": "x", "button0:1": "cafeteira" },
        contrato,
      }),
    ).rejects.toThrow(/\[plataforma:132015\]/);
  });
});

describe("códigos que o handler grava", () => {
  it("nomeiam o canal, para o operador saber qual falhou", () => {
    expect(zernioAdapter.codes).toEqual({
      notConfigured: "zernio_not_configured",
      sendFailed: "zernio_error",
      unknownError: "zernio_unknown",
    });
  });
});

/**
 * A MÍDIA RECEBIDA NÃO PODE LEVAR A CREDENCIAL PARA ONDE O PAYLOAD MANDAR.
 *
 * `fetchInboundMedia` busca o anexo pela URL que veio no payload do webhook, e
 * manda a API key do tenant no `Authorization`. Sem guarda, isso é pior que o
 * SSRF comum: além de fazer o servidor bater num endereço interno
 * (`169.254.169.254` é o metadado de nuvem), ele ENTREGA a credencial ao host
 * que o payload escolheu.
 *
 * O irmão WAHA resolve por construção — `lib/messaging/media/waha-source.ts`
 * descarta host e porta do payload e reconstrói sobre `WAHA_API_BASE_URL`.
 * Aqui não dá para fixar a base (o provedor pode servir mídia de outro host),
 * então vale o par que o repo já usa em `lib/automation/actions/call-webhook.ts`.
 *
 * O que estes casos guardam é COMPORTAMENTO, não a presença do import: o
 * critério é `fetch` NÃO ter sido chamado. Um guard que lance depois do fetch
 * deixaria a credencial sair na mesma e ainda assim "passaria" num teste que
 * só checasse a exceção.
 */
describe("fetchInboundMedia não busca onde o payload mandar", () => {
  const PROIBIDAS = [
    ["metadado de nuvem", "http://169.254.169.254/latest/meta-data/"],
    ["loopback", "http://127.0.0.1:9000/interno"],
    ["localhost por nome", "http://localhost:3000/interno"],
    ["rede privada", "http://10.0.0.5/interno"],
    ["literal IPv6", "http://[::1]:9000/interno"],
    ["esquema que não é http(s)", "file:///etc/passwd"],
  ] as const;

  for (const [rotulo, url] of PROIBIDAS) {
    it(`recusa ${rotulo} — e sem chamar fetch`, async () => {
      credsRef.current = CREDS;
      fetchMock.mockClear();
      await expect(
        zernioAdapter.fetchInboundMedia!({ organizationId: ORG, sessionRef: CREDS.accountId, url }),
      ).rejects.toThrow();
      expect(
        fetchMock,
        "a credencial não pode sair: o guard tem de barrar ANTES do fetch",
      ).not.toHaveBeenCalled();
    });
  }

  it("deixa passar uma URL pública do provedor (guarda de vacuidade)", async () => {
    // Sem este caso, um guard que recusasse TUDO deixaria os de cima verdes e
    // quebraria a feature em silêncio.
    credsRef.current = CREDS;
    fetchMock.mockClear();
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      arrayBuffer: async () => new ArrayBuffer(4),
      headers: new Headers({ "content-type": "image/png" }),
    });
    const r = await zernioAdapter.fetchInboundMedia!({
      organizationId: ORG,
      sessionRef: CREDS.accountId,
      url: "https://zernio.com/api/v1/media/abc123",
    });
    expect(r.mime).toBe("image/png");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
