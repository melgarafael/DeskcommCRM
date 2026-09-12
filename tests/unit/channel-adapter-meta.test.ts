import { afterEach, describe, expect, it, vi } from "vitest";

import { getAdapter } from "@/lib/channels";

/**
 * O adapter resolve a credencial POR SESSÃO (banco) com o env como fallback. Sem
 * mockar o admin client, o `fetch` stubado captura a query do Supabase em vez da
 * chamada à Graph API — foi assim que estes testes vermelharam quando a resolução
 * por sessão entrou, e o vermelho foi correto.
 */
/**
 * O estado do "banco" que a resolução por sessão enxerga.
 *
 * - `token`   → instalação de uma organização só (quem conectou pela tela);
 * - `porOrg`  → busca filtrada por organização (#236): a chave é
 *               `organization_id|phone_number_id`, e cada tenant tem o SEU
 *               cifrado e o SEU token;
 * - `erro`    → falha de consulta (PGRST116 etc.);
 * - `decifravel: false` → a decifra devolve null (GUC da chave ausente).
 */
const sessaoNoBanco: {
  token: string | null;
  porOrg: Record<string, { cifrado: string; token: string }> | null;
  erro: { code?: string; message?: string } | null;
  decifravel: boolean;
} = { token: null, porOrg: null, erro: null, decifravel: true };

/**
 * Cadeia ENCADEÁVEL, não de um nível só.
 *
 * A resolução por sessão filtra `organization_id` E o identificador E
 * `archived_at is null` (issue #236 / migration 0165), então um stub em que
 * `eq()` já devolve `maybeSingle` deixa de casar com o código real — e um mock
 * que não casa com o código testa o mock. Aqui qualquer combinação de
 * `.eq()/.is()` volta para o mesmo objeto e o terminal é `maybeSingle`.
 */
function cadeia(filtros: Record<string, unknown>): Record<string, unknown> {
  const alvo: Record<string, unknown> = {
    maybeSingle: async () => {
      if (sessaoNoBanco.erro) return { data: null, error: sessaoNoBanco.erro };
      const chave = `${filtros.organization_id ?? ""}|${filtros.meta_phone_number_id ?? ""}`;
      const daOrg = sessaoNoBanco.porOrg?.[chave];
      const cifrado = sessaoNoBanco.porOrg
        ? (daOrg?.cifrado ?? null)
        : sessaoNoBanco.token
          ? "\\xdeadbeef"
          : null;
      return {
        data: cifrado
          ? { meta_phone_number_id: "sessao-pn", meta_token_encrypted: cifrado }
          : null,
        error: null,
      };
    },
  };
  alvo.select = () => alvo;
  alvo.eq = (col: string, val: unknown) => {
    filtros[col] = val;
    return alvo;
  };
  alvo.is = () => alvo;
  return alvo;
}

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: () => cadeia({}),
    rpc: async (nome: string, args: { ciphertext?: string }) => {
      if (nome !== "fn_decrypt_oauth" || !sessaoNoBanco.decifravel) {
        return { data: null, error: null };
      }
      const cifrado = String(args?.ciphertext ?? "");
      const daOrg = Object.values(sessaoNoBanco.porOrg ?? {}).find((s) => s.cifrado === cifrado);
      return {
        data: daOrg?.token ?? (sessaoNoBanco.porOrg ? null : sessaoNoBanco.token),
        error: null,
      };
    },
  }),
}));

const a = () => getAdapter("meta_cloud");

/**
 * A organização atravessa o seam de canal desde a issue #236: `sessionRef` é
 * identificador do PROVIDER e não identifica linha sozinho.
 */
const ORG = "00000000-0000-4000-8000-000000000236";

function configurar() {
  vi.stubEnv("META_PHONE_NUMBER_ID", "1103328999528818");
  vi.stubEnv("META_SYSTEM_USER_TOKEN", "tok");
  vi.stubEnv("META_GRAPH_VERSION", "v22.0");
}

function stubFetch(resposta: unknown, ok = true) {
  const spy = vi.fn().mockResolvedValue({
    ok,
    status: ok ? 200 : 400,
    json: async () => resposta,
  });
  vi.stubGlobal("fetch", spy);
  return spy;
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  sessaoNoBanco.token = null;
  sessaoNoBanco.porOrg = null;
  sessaoNoBanco.erro = null;
  sessaoNoBanco.decifravel = true;
});

describe("adapter meta_cloud — endereçamento", () => {
  it("telefone vira E.164 em DÍGITOS, sem + e sem sufixo", () => {
    // `@c.us` é do outro canal. Um `+` sobrevivente vira (#131009) na Meta.
    expect(a().resolveRecipient({
      isGroup: false, groupChatId: null, phoneNumber: "+55 (31) 99896-6398", waIdentity: null,
    })).toBe("5531998966398");
  });

  it("grupo devolve null — a API de grupos não faz parte deste seam", () => {
    expect(a().resolveRecipient({
      isGroup: true, groupChatId: "123@g.us", phoneNumber: "+5531999998888", waIdentity: null,
    })).toBeNull();
  });

  it("sem telefone devolve null — não há `lid` neste canal", () => {
    expect(a().resolveRecipient({
      isGroup: false, groupChatId: null, phoneNumber: null, waIdentity: "lid:12345",
    })).toBeNull();
  });
});

describe("adapter meta_cloud — configuração", () => {
  it("isConfigured é SEMPRE true — a credencial pode viver na sessão, e isto é síncrono", () => {
    // O contrato anterior ("sem env → false") travava em `queued` toda
    // instalação que conectou o número pela TELA: o pre-check respondia "não
    // configurado" para um canal conectado e funcionando (issue #674). Quem
    // decide é o `send`, que consulta o banco — o mesmo desenho do zernio.
    vi.stubEnv("META_PHONE_NUMBER_ID", "");
    vi.stubEnv("META_SYSTEM_USER_TOKEN", "");
    expect(a().isConfigured()).toBe(true);
    configurar();
    expect(a().isConfigured()).toBe(true);
  });

  it("sem credencial NENHUMA o envio LANÇA meta_not_configured — e nada vai à rede", async () => {
    // `{externalId: null}` faria o handler gravar `sent` sem id — "enviado"
    // para algo que nunca saiu. O prefixo é o que o handler traduz para
    // `queued` com motivo.
    vi.stubEnv("META_PHONE_NUMBER_ID", "");
    vi.stubEnv("META_SYSTEM_USER_TOKEN", "");
    const spy = vi.fn();
    vi.stubGlobal("fetch", spy);
    await expect(
      a().send({ organizationId: ORG, sessionRef: "x", to: "5531999", kind: "text", body: "oi" }),
    ).rejects.toThrow(/meta_not_configured/);
    expect(spy).not.toHaveBeenCalled();
  });

  it("os códigos carregam o nome do provider — por isso vivem no adapter", () => {
    expect(a().codes.notConfigured).toContain("meta");
    expect(a().codes.sendFailed).toContain("meta");
  });
});

describe("adapter meta_cloud — envio", () => {
  it("texto vai como type:text e o phone_number_id entra na URL, não no corpo", async () => {
    configurar();
    const spy = stubFetch({ messages: [{ id: "wamid.T" }] });
    const r = await a().send({ organizationId: ORG, sessionRef: "ignorado", to: "5531998966398", kind: "text", body: "oi" });

    expect(r).toEqual({ externalId: "wamid.T" });
    const [url, init] = spy.mock.calls[0]!;
    expect(url).toContain("/v22.0/1103328999528818/messages");
    const corpo = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(corpo).toMatchObject({ messaging_product: "whatsapp", to: "5531998966398", type: "text" });
    expect(corpo).not.toHaveProperty("session");
  });

  it("áudio leva voice:true — sem isso vira anexo de música, não nota de voz", async () => {
    configurar();
    const spy = stubFetch({ messages: [{ id: "wamid.A" }] });
    await a().send({
      organizationId: ORG, sessionRef: "x", to: "5531998966398", kind: "audio",
      media: { url: "https://x/a.ogg", mime: "audio/ogg" },
    });
    const corpo = JSON.parse(spy.mock.calls[0]![1].body as string) as {
      type: string; audio: { link: string; voice: boolean };
    };
    expect(corpo.type).toBe("audio");
    expect(corpo.audio.voice).toBe(true);
  });

  it("imagem leva caption; documento leva filename", async () => {
    configurar();
    const spy = stubFetch({ messages: [{ id: "wamid.I" }] });
    await a().send({
      organizationId: ORG, sessionRef: "x", to: "5531", kind: "image",
      media: { url: "https://x/a.jpg", mime: "image/jpeg", caption: "olha" },
    });
    expect(JSON.parse(spy.mock.calls[0]![1].body as string).image).toEqual({
      link: "https://x/a.jpg", caption: "olha",
    });

    const spy2 = stubFetch({ messages: [{ id: "wamid.D" }] });
    await a().send({
      organizationId: ORG, sessionRef: "x", to: "5531", kind: "document",
      media: { url: "https://x/a.pdf", mime: "application/pdf", filename: "contrato.pdf" },
    });
    expect(JSON.parse(spy2.mock.calls[0]![1].body as string).document).toMatchObject({
      filename: "contrato.pdf",
    });
  });

  it("erro da Meta lança com o `details`, que diz QUAL parâmetro divergiu", async () => {
    configurar();
    stubFetch(
      {
        error: {
          code: 131009,
          message: "Parameter value is not valid",
          error_data: { details: "to: número em formato inválido" },
        },
      },
      false,
    );
    await expect(
      a().send({ organizationId: ORG, sessionRef: "x", to: "+5531", kind: "text", body: "oi" }),
    ).rejects.toThrow(/131009.*formato inválido/);
  });

  it("contato vai como type:contacts com formatted_name e wa_id", async () => {
    configurar();
    const spy = stubFetch({ messages: [{ id: "wamid.C" }] });
    const r = await a().send({
      organizationId: "org-1",
      sessionRef: "ignorado",
      to: "5531998966398",
      kind: "contact",
      contact: {
        fullName: "Maria Silva",
        phoneNumber: "+5511999887766",
        whatsappId: "5511999887766",
        vcard: "BEGIN:VCARD…",
      },
    });

    expect(r).toEqual({ externalId: "wamid.C" });
    const corpo = JSON.parse(spy.mock.calls[0]![1].body as string) as {
      type: string;
      contacts: Array<{ name: { formatted_name: string }; phones: Array<{ wa_id: string }> }>;
    };
    expect(corpo.type).toBe("contacts");
    expect(corpo.contacts[0]?.name.formatted_name).toBe("Maria Silva");
    expect(corpo.contacts[0]?.phones[0]?.wa_id).toBe("5511999887766");
  });

  it("resposta sem id devolve externalId null, sem estourar", async () => {
    configurar();
    stubFetch({ messages: [] });
    const r = await a().send({ organizationId: ORG, sessionRef: "x", to: "5531", kind: "text", body: "oi" });
    expect(r).toEqual({ externalId: null });
  });
});

describe("adapter meta_cloud — mídia recebida", () => {
  it("resolve o media_id na Graph e baixa os bytes com a credencial da sessão", async () => {
    configurar();
    sessaoNoBanco.token = "token-da-sessao";
    const bytes = new Uint8Array([79, 103, 103, 83]);
    const spy = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: "OK",
        json: async () => ({
          id: "987654321",
          url: "https://lookaside.fbsbx.com/whatsapp_business/attachments/?mid=987654321",
          mime_type: "audio/ogg; codecs=opus",
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: "OK",
        headers: new Headers({ "content-type": "audio/ogg" }),
        arrayBuffer: async () => bytes.buffer,
      });
    vi.stubGlobal("fetch", spy);

    const media = await a().fetchInboundMedia!({
      organizationId: ORG,
      sessionRef: "sessao-pn",
      url: "meta-media:987654321",
      hintMime: "audio/ogg; codecs=opus",
    });

    expect([...media.buffer]).toEqual([79, 103, 103, 83]);
    expect(media.mime).toBe("audio/ogg");
    expect(spy.mock.calls.map(([url]) => url)).toEqual([
      "https://graph.facebook.com/v22.0/987654321",
      "https://lookaside.fbsbx.com/whatsapp_business/attachments/?mid=987654321",
    ]);
    for (const [, init] of spy.mock.calls) {
      expect((init.headers as Record<string, string>).Authorization).toBe(
        "Bearer token-da-sessao",
      );
    }
  });
});

describe("credencial por sessão — o que destrava multi-tenant", () => {
  it("com token na SESSÃO, o env deixa de valer", async () => {
    // Ordem sessão-primeiro: um env esquecido não pode silenciar o que foi
    // configurado pela tela, senão o operador não entende por que nada mudou.
    configurar();
    sessaoNoBanco.token = "token-da-sessao";
    const spy = stubFetch({ messages: [{ id: "wamid.S" }] });

    await a().send({ organizationId: ORG, sessionRef: "sessao-pn", to: "5531", kind: "text", body: "oi" });

    const [, init] = spy.mock.calls[0]!;
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer token-da-sessao");
  });

  it("sem token na sessão, cai no env — instalação de número único segue funcionando", async () => {
    configurar();
    sessaoNoBanco.token = null;
    const spy = stubFetch({ messages: [{ id: "wamid.E" }] });

    await a().send({ organizationId: ORG, sessionRef: "qualquer", to: "5531", kind: "text", body: "oi" });

    const [, init] = spy.mock.calls[0]!;
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer tok");
  });
});

describe("elegibilidade é do `send` — os desfechos da #674", () => {
  it("sessão válida SEM ambiente: o envio sai, com o token da sessão", async () => {
    sessaoNoBanco.token = "token-da-sessao";
    const spy = stubFetch({ messages: [{ id: "wamid.S" }] });

    const r = await a().send({ organizationId: ORG, sessionRef: "sessao-pn", to: "5531", kind: "text", body: "oi" });

    expect(r).toEqual({ externalId: "wamid.S" });
    const [url, init] = spy.mock.calls[0]!;
    expect(String(url)).toContain("/sessao-pn/messages");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer token-da-sessao");
  });

  it("sessão AUSENTE e sem ambiente: lança meta_not_configured", async () => {
    const spy = vi.fn();
    vi.stubGlobal("fetch", spy);
    await expect(
      a().send({ organizationId: ORG, sessionRef: "sessao-pn", to: "5531", kind: "text", body: "oi" }),
    ).rejects.toThrow(/meta_not_configured/);
    expect(spy).not.toHaveBeenCalled();
  });

  it("falha de CONSULTA fecha a ação com o código — não cai no env", async () => {
    // O env está VÁLIDO de propósito: erro de resolução tem de fechar a ação e
    // abrir a informação (#236), nunca virar caminho feliz de outra conta.
    configurar();
    sessaoNoBanco.erro = { code: "PGRST116", message: "duas linhas casaram" };
    const spy = vi.fn();
    vi.stubGlobal("fetch", spy);
    await expect(
      a().send({ organizationId: ORG, sessionRef: "sessao-pn", to: "5531", kind: "text", body: "oi" }),
    ).rejects.toThrow(/meta_creds_lookup_failed/);
    expect(spy).not.toHaveBeenCalled();
  });

  it("decifragem que falha, sem env: meta_not_configured (não vira `sent` sem id)", async () => {
    sessaoNoBanco.token = "cifrado-existe";
    sessaoNoBanco.decifravel = false;
    const spy = vi.fn();
    vi.stubGlobal("fetch", spy);
    await expect(
      a().send({ organizationId: ORG, sessionRef: "sessao-pn", to: "5531", kind: "text", body: "oi" }),
    ).rejects.toThrow(/meta_not_configured/);
    expect(spy).not.toHaveBeenCalled();
  });

  it("duas organizações: cada envio sai com o token do SEU tenant", async () => {
    const OUTRA = "00000000-0000-4000-8000-0000000000bb";
    sessaoNoBanco.porOrg = {
      [`${ORG}|pn-a`]: { cifrado: "\\xaa", token: "tok-A" },
      [`${OUTRA}|pn-b`]: { cifrado: "\\xbb", token: "tok-B" },
    };
    const spy = stubFetch({ messages: [{ id: "wamid.X" }] });

    await a().send({ organizationId: ORG, sessionRef: "pn-a", to: "5531", kind: "text", body: "oi" });
    await a().send({ organizationId: OUTRA, sessionRef: "pn-b", to: "5531", kind: "text", body: "oi" });

    const auth = spy.mock.calls.map((c) => (c[1].headers as Record<string, string>).Authorization);
    expect(auth).toEqual(["Bearer tok-A", "Bearer tok-B"]);
  });
});
