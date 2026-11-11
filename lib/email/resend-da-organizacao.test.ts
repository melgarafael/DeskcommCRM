/**
 * A CONTA RESEND DA ORGANIZAÇÃO (#3287, fatia da conta própria).
 *
 * O que este arquivo prova:
 *
 *   1. o LEITOR decifra a linha e degrada para `null` em qualquer lixo — nunca
 *      lança no caminho do envio, e NUNCA devolve o ciphertext (critério D);
 *   2. o VERIFICADOR de domínio recusa domínio não verificado com o MOTIVO
 *      próprio (critério E), chave recusada separadamente, e endereço torto
 *      antes de gastar chamada de rede;
 *   3. o ENVIO sai com o `from` da ORGANIZAÇÃO (o domínio dela), e o erro da
 *      Resend cai no MESMO vocabulário da plataforma (`dominio_nao_verificado`
 *      continua sendo ele, não um `send_failed` opaco).
 *
 * A SDK `resend` é MOCKADA: nenhum teste fala com a Resend de verdade, e a
 * chave que circula aqui é FIXTURE cifrada com a chave de teste do AES — chave
 * real de Resend nenhuma entra no arquivo (restrição da issue).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

// A chave de cifragem tem de existir ANTES de `lib/env`/carregar `aes_gcm`.
vi.hoisted(() => {
  process.env.AI_CRED_AES_KEY = "iBc1Z2gYaAH4rEHs1dHQ2dvNQ6t4OfrdE1/Y6OSvtZY=";
});

const { sendMock, listMock, getMock } = vi.hoisted(() => ({
  sendMock: vi.fn(),
  listMock: vi.fn(),
  getMock: vi.fn(),
}));

vi.mock("resend", () => ({
  // `function` (não arrow) para ser CONSTRUÍVEL: os testes fazem `new Resend(...)`.
  Resend: vi.fn(function () {
    return { emails: { send: sendMock }, domains: { list: listMock, get: getMock } };
  }),
}));

import { encryptKey, bufToBytea } from "@/lib/crypto/aes_gcm";
import {
  carregarContaResend,
  contaResendDaLinha,
  enviarPelaContaDaOrganizacao,
  estadoDaContaResend,
  verificarDominioNaResend,
  dominioOficialDaContaResend,
} from "@/lib/email/resend-da-organizacao";

const CHAVE_FIXTURE = "re_test_key_1234567890";

/** Uma linha de `organization_resend_accounts` CIFRADA de verdade, com a fixture. */
function linhaCifrada(fromEmail = "contato@lojadaana.com") {
  const env = encryptKey(CHAVE_FIXTURE);
  return {
    organization_id: "org-1",
    api_key_ciphertext: bufToBytea(env.ciphertext),
    api_key_iv: bufToBytea(env.iv),
    api_key_tag: bufToBytea(env.tag),
    api_key_last4: env.last4,
    from_email: fromEmail,
  };
}

/** Dublê de admin client servindo UMA tabela fixa. */
function adminCom(linha: unknown, erro: { code?: string; message: string } | null = null) {
  return {
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () =>
            erro ? { data: null, error: erro } : { data: linha, error: null },
        }),
      }),
    }),
  } as never;
}

beforeEach(() => {
  sendMock.mockReset();
  listMock.mockReset();
  getMock.mockReset();
});

describe("dominioOficialDaContaResend — registros da conta conectada", () => {
  const dominio = {
    name: "lojadaana.com",
    status: "verified",
    capabilities: { sending: "enabled", receiving: "disabled" },
    records: [
      {
        record: "SPF",
        type: "CNAME",
        name: "outbound",
        value: "envio.provedor.example",
        status: "verified",
        ttl: "Auto",
      },
    ],
  };

  it("obtém pelo id da própria conta e projeta só o diagnóstico público", async () => {
    listMock.mockResolvedValue({ data: { data: [{ ...dominio, id: "dominio-a" }] }, error: null });
    getMock.mockResolvedValue({ data: { ...dominio, id: "dominio-a" }, error: null });
    const resultado = await dominioOficialDaContaResend({
      apiKey: CHAVE_FIXTURE,
      fromEmail: "contato@lojadaana.com",
    });
    expect(getMock).toHaveBeenCalledWith("dominio-a");
    expect(resultado).toEqual({ ok: true, dominio });
    expect(JSON.stringify(resultado)).not.toContain(CHAVE_FIXTURE);
    expect(resultado).not.toHaveProperty("client");
  });

  it("não usa registros que a resposta atribui a outro domínio", async () => {
    listMock.mockResolvedValue({ data: { data: [{ ...dominio, id: "dominio-a" }] }, error: null });
    getMock.mockResolvedValue({ data: { ...dominio, name: "outra-empresa.example" }, error: null });
    await expect(
      dominioOficialDaContaResend({ apiKey: CHAVE_FIXTURE, fromEmail: "contato@lojadaana.com" }),
    ).resolves.toEqual({ ok: false, motivo: "consulta_indisponivel" });
  });
});

describe("contaResendDaLinha — o leitor", () => {
  it("decifra a linha e devolve a chave em claro + o remetente", () => {
    const conta = contaResendDaLinha(linhaCifrada());
    expect(conta).toEqual({ apiKey: CHAVE_FIXTURE, fromEmail: "contato@lojadaana.com" });
  });

  it("NUNCA devolve o ciphertext nem as colunas de cifra", () => {
    const conta = contaResendDaLinha(linhaCifrada());
    expect(conta).not.toHaveProperty("api_key_ciphertext");
    expect(conta).not.toHaveProperty("api_key_iv");
    expect(conta).not.toHaveProperty("api_key_tag");
    expect(JSON.stringify(conta)).not.toContain(bufToBytea(encryptKey(CHAVE_FIXTURE).ciphertext));
  });

  it("o parser devolve null para linha ilegível; quem carrega distingue ausência", () => {
    const torta = [
      null,
      undefined,
      "texto",
      42,
      {},
      // Coluna de cifra ausente.
      { from_email: "a@b.com" },
      // from_email vazio ou não-string.
      { ...linhaCifrada(""), from_email: "" },
      { ...linhaCifrada(), from_email: 7 },
      // Cifra fechada com OUTRA chave: decifrar estoura → null.
      { ...linhaCifrada(), api_key_iv: bufToBytea(Buffer.alloc(12, 9)) },
      // bytea torto.
      { ...linhaCifrada(), api_key_tag: "nao-e-hex" },
    ];
    for (const entrada of torta) {
      expect(
        () => contaResendDaLinha(entrada),
        JSON.stringify(entrada) ?? "undefined",
      ).not.toThrow();
      expect(contaResendDaLinha(entrada), JSON.stringify(entrada) ?? "undefined").toBeNull();
    }
  });

  it("chave muito curta não é conta utilizável", () => {
    const env = encryptKey("re_curta");
    expect(
      contaResendDaLinha({
        api_key_ciphertext: bufToBytea(env.ciphertext),
        api_key_iv: bufToBytea(env.iv),
        api_key_tag: bufToBytea(env.tag),
        from_email: "a@b.com",
      }),
    ).toBeNull();
  });
});

describe("carregarContaResend — a leitura no banco", () => {
  it("conta gravada com cifra inválida recusa; não se confunde com ausência", async () => {
    await expect(
      carregarContaResend(adminCom({ ...linhaCifrada(), api_key_tag: "invalida" }), "org-1"),
    ).rejects.toThrow("conta_resend_indisponivel");
  });

  it.each(["42P01", "42501", "XX000"])("erro %s não autoriza outro remetente", async (code) => {
    await expect(
      carregarContaResend(adminCom(null, { code, message: "falha sintética" }), "org-1"),
    ).rejects.toThrow("conta_resend_indisponivel");
  });

  it("lê a linha da ORGANIZAÇÃO e decifra", async () => {
    const conta = await carregarContaResend(adminCom(linhaCifrada()), "org-1");
    expect(conta).toEqual({ apiKey: CHAVE_FIXTURE, fromEmail: "contato@lojadaana.com" });
  });

  it("erro de leitura recusa em vez de devolver ausência", async () => {
    await expect(
      carregarContaResend(
        adminCom(null, { code: "42P01", message: "relation does not exist" }),
        "org-1",
      ),
    ).rejects.toThrow("conta_resend_indisponivel");
  });

  it('sem linha é null (a invariância "sem conta = como hoje")', async () => {
    expect(await carregarContaResend(adminCom(null), "org-1")).toBeNull();
  });
});

describe("estadoDaContaResend — o que a tela pode ver", () => {
  it("falha de leitura não informa à tela que a conta está ausente", async () => {
    await expect(
      estadoDaContaResend(adminCom(null, { code: "42501", message: "falha" }), "org-1"),
    ).rejects.toThrow("conta_resend_indisponivel");
  });
  it("devolve só endereço e os 4 últimos — nunca a chave", async () => {
    const estado = await estadoDaContaResend(adminCom(linhaCifrada()), "org-1");
    expect(estado).toEqual({ from_email: "contato@lojadaana.com", api_key_last4: "7890" });
    expect(JSON.stringify(estado)).not.toContain(CHAVE_FIXTURE);
    expect(estado).not.toHaveProperty("api_key_ciphertext");
  });

  it("sem linha é null", async () => {
    expect(await estadoDaContaResend(adminCom(null), "org-1")).toBeNull();
  });
});

describe("verificarDominioNaResend — critério E", () => {
  it("domínio verificado só para receber não anuncia conexão de envio", async () => {
    listMock.mockResolvedValue({
      data: {
        data: [
          {
            name: "lojadaana.com",
            status: "verified",
            capabilities: { sending: "disabled", receiving: "enabled" },
          },
        ],
      },
      error: null,
    });
    await expect(verificarDominioNaResend(CHAVE_FIXTURE, "contato@lojadaana.com")).resolves.toEqual(
      { ok: false, motivo: "envio_desabilitado" },
    );
  });

  it.each([
    ["restricted_api_key", 401, "permissao_insuficiente"],
    ["invalid_permission", 403, "permissao_insuficiente"],
    ["restricted_api_key", 403, "chave_recusada"],
    ["service_unavailable", 503, "consulta_indisponivel"],
    ["rate_limit_exceeded", 429, "consulta_indisponivel"],
  ])("classifica %s/%i sem expor a mensagem bruta", async (name, statusCode, motivo) => {
    listMock.mockResolvedValue({ data: null, error: { name, statusCode, message: CHAVE_FIXTURE } });
    const r = await verificarDominioNaResend(CHAVE_FIXTURE, "contato@lojadaana.com");
    expect(r).toEqual({ ok: false, motivo });
    expect(JSON.stringify(r)).not.toContain(CHAVE_FIXTURE);
  });

  it.each([
    "bad<sender@lojadaana.com",
    'bad"sender@lojadaana.com',
    "bad,sender@lojadaana.com",
    "bad;sender@lojadaana.com",
  ])("recusa %s pela mesma régua do From antes da rede", async (fromEmail) => {
    listMock.mockResolvedValue({
      data: { data: [{ name: "lojadaana.com", status: "verified" }] },
      error: null,
    });
    await expect(verificarDominioNaResend(CHAVE_FIXTURE, fromEmail)).resolves.toEqual({
      ok: false,
      motivo: "sem_endereco",
    });
    expect(listMock).not.toHaveBeenCalled();
  });

  it("domínio VERIFICADO na conta → ok", async () => {
    listMock.mockResolvedValue({
      data: { data: [{ name: "lojadaana.com", status: "verified" }] },
      error: null,
    });
    await expect(verificarDominioNaResend(CHAVE_FIXTURE, "contato@lojadaana.com")).resolves.toEqual(
      {
        ok: true,
      },
    );
  });

  it("domínio PENDENTE na conta → dominio_nao_verificado COM o domínio (mensagem própria)", async () => {
    listMock.mockResolvedValue({
      data: { data: [{ name: "lojadaana.com", status: "pending" }] },
      error: null,
    });
    await expect(verificarDominioNaResend(CHAVE_FIXTURE, "contato@lojadaana.com")).resolves.toEqual(
      {
        ok: false,
        motivo: "dominio_nao_verificado",
        dominio: "lojadaana.com",
      },
    );
  });

  it("domínio PARCIALMENTE verificado NÃO conta como verificado", async () => {
    listMock.mockResolvedValue({
      data: { data: [{ name: "lojadaana.com", status: "partially_verified" }] },
      error: null,
    });
    await expect(verificarDominioNaResend(CHAVE_FIXTURE, "contato@lojadaana.com")).resolves.toEqual(
      {
        ok: false,
        motivo: "dominio_nao_verificado",
        dominio: "lojadaana.com",
      },
    );
  });

  it("domínio ausente da conta → dominio_nao_verificado", async () => {
    listMock.mockResolvedValue({
      data: { data: [{ name: "outra.com", status: "verified" }] },
      error: null,
    });
    await expect(verificarDominioNaResend(CHAVE_FIXTURE, "contato@lojadaana.com")).resolves.toEqual(
      {
        ok: false,
        motivo: "dominio_nao_verificado",
        dominio: "lojadaana.com",
      },
    );
  });

  it("chave recusada pela Resend → chave_recusada (separado do domínio)", async () => {
    listMock.mockResolvedValue({
      data: null,
      error: { name: "validation_error", message: "bad key" },
    });
    await expect(
      verificarDominioNaResend("re_invalida_0000", "contato@lojadaana.com"),
    ).resolves.toEqual({
      ok: false,
      motivo: "chave_recusada",
    });
  });

  it("falha de rede não acusa chave inválida, sem lançar", async () => {
    listMock.mockRejectedValue(new Error("fetch failed"));
    await expect(verificarDominioNaResend(CHAVE_FIXTURE, "contato@lojadaana.com")).resolves.toEqual(
      {
        ok: false,
        motivo: "consulta_indisponivel",
      },
    );
  });

  it("endereço sem cara de endereço é recusado ANTES de chamar a Resend", async () => {
    await expect(verificarDominioNaResend(CHAVE_FIXTURE, "nao-e-endereco")).resolves.toEqual({
      ok: false,
      motivo: "sem_endereco",
    });
    expect(listMock).not.toHaveBeenCalled();
  });
});

describe("enviarPelaContaDaOrganizacao — o envio", () => {
  it("sai com o `from` da ORGANIZAÇÃO (o domínio dela), com o nome de exibição", async () => {
    sendMock.mockResolvedValue({ data: { id: "e-mail-org" }, error: null });
    const r = await enviarPelaContaDaOrganizacao(
      { apiKey: CHAVE_FIXTURE, fromEmail: "contato@lojadaana.com" },
      { to: "cliente@exemplo.com", subject: "Oi", html: "<p>Oi</p>", fromName: "Loja da Ana" },
    );
    expect(r).toEqual({ ok: true, id: "e-mail-org" });
    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(sendMock.mock.calls[0]![0].from).toBe("Loja da Ana <contato@lojadaana.com>");
  });

  it("sem nome de exibição, sai com o endereço puro", async () => {
    sendMock.mockResolvedValue({ data: { id: "e-mail-org" }, error: null });
    await enviarPelaContaDaOrganizacao(
      { apiKey: CHAVE_FIXTURE, fromEmail: "contato@lojadaana.com" },
      { to: "cliente@exemplo.com", subject: "Oi", html: "<p>Oi</p>" },
    );
    expect(sendMock.mock.calls[0]![0].from).toBe("contato@lojadaana.com");
  });

  it("erro de domínio não verificado no envio cai em `dominio_nao_verificado`, não genérico", async () => {
    sendMock.mockResolvedValue({
      data: null,
      error: { name: "validation_error", message: "The domain is not verified" },
    });
    const r = await enviarPelaContaDaOrganizacao(
      { apiKey: CHAVE_FIXTURE, fromEmail: "contato@lojadaana.com" },
      { to: "cliente@exemplo.com", subject: "Oi", html: "<p>Oi</p>" },
    );
    expect(r.ok).toBe(false);
    expect(r.error).toBe("dominio_nao_verificado");
  });

  it("rate limit cai em `rate_limited`", async () => {
    sendMock.mockResolvedValue({
      data: null,
      error: { name: "rate_limit_exceeded", message: "too many" },
    });
    const r = await enviarPelaContaDaOrganizacao(
      { apiKey: CHAVE_FIXTURE, fromEmail: "contato@lojadaana.com" },
      { to: "cliente@exemplo.com", subject: "Oi", html: "<p>Oi</p>" },
    );
    expect(r.error).toBe("rate_limited");
  });

  it("remetente injetável é recusado, sem chamar a Resend", async () => {
    const r = await enviarPelaContaDaOrganizacao(
      { apiKey: CHAVE_FIXTURE, fromEmail: "quebra\r\nBcc: terceiro@x.com" },
      { to: "cliente@exemplo.com", subject: "Oi", html: "<p>Oi</p>" },
    );
    expect(r).toEqual({ ok: false, error: "not_configured" });
    expect(sendMock).not.toHaveBeenCalled();
  });
});
