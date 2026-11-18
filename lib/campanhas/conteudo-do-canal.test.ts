/**
 * O conteúdo segue o que o número aceita — nunca uma escolha solta do corpo da
 * requisição. Estes casos não tocam o banco: o banco só é lido quando há um
 * modelo para conferir (ver `modelo-da-conexao.ts`).
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";

import { moduloLigado } from "@/lib/instalacao/modulos";

import {
  camposDeGravacao,
  decidirConteudo,
  decidirVelocidade,
  fraseDaRecusa,
  lerModoDoCanal,
} from "./conteudo-do-canal";
import { LIMITE_DO_ASSUNTO_DO_EMAIL, LIMITE_DO_CORPO_DO_EMAIL } from "./conteudo-de-email";

// Doc 305 (A): a campanha por e-mail é o módulo `campanha_por_email`. Ligado em
// todo caso deste arquivo, menos nos que medem a chave desligada (no fim).
vi.mock("@/lib/instalacao/modulos", () => ({ moduloLigado: vi.fn(async () => true) }));

const SEM_BANCO = new Proxy({} as SupabaseClient, {
  get() {
    throw new Error("este caso não deveria ler o banco");
  },
});

const base = { organizationId: "org", channelSessionId: "canal", extras: [] as string[] };

describe("decidirConteudo", () => {
  it("número por QR: texto livre, e as colunas de modelo ficam vazias", async () => {
    const r = await decidirConteudo(SEM_BANCO, { ...base, modoDoCanal: "text", pedido: { message_body: "Oi" } });
    expect(r).toEqual({
      ok: true,
      modo: "text",
      colunas: {
        message_mode: "text",
        provider_template_name: null,
        provider_template_language: null,
        provider_template_variables: {},
        email_subject: null,
      },
    });
  });

  it("pedir texto livre num número oficial é recusado — fora das 24 horas a plataforma recusa", async () => {
    const r = await decidirConteudo(SEM_BANCO, {
      ...base,
      modoDoCanal: "template",
      pedido: { message_mode: "text", message_body: "Oi" },
    });
    expect(r).toMatchObject({ ok: false, codigo: "campanha_modo_do_canal", status: 422 });
  });

  it("modelo em número por QR também é recusado", async () => {
    const r = await decidirConteudo(SEM_BANCO, { ...base, modoDoCanal: "text", pedido: { message_mode: "template" } });
    expect(r).toMatchObject({ ok: false, codigo: "campanha_modo_do_canal" });
  });

  it("número oficial com números extras é recusado: cada número tem os próprios modelos", async () => {
    const r = await decidirConteudo(SEM_BANCO, { ...base, extras: ["outro"], modoDoCanal: "template", pedido: {} });
    expect(r).toMatchObject({ ok: false, codigo: "campanha_modelo_um_numero" });
  });

  it("rascunho oficial sem modelo ainda passa — quem cobra o conteúdo é a preparação", async () => {
    const r = await decidirConteudo(SEM_BANCO, { ...base, modoDoCanal: "template", pedido: {} });
    expect(r).toMatchObject({ ok: true, modo: "template", colunas: { message_mode: "template", provider_template_name: null } });
  });

  it("modelo sem idioma é recusado antes de ir ao banco", async () => {
    const r = await decidirConteudo(SEM_BANCO, {
      ...base,
      modoDoCanal: "template",
      pedido: { provider_template_name: "oferta" },
    });
    expect(r).toMatchObject({ ok: false, codigo: "campanha_modelo_inexistente" });
  });

  it("canal que não faz campanha (rede social)", async () => {
    const r = await decidirConteudo(SEM_BANCO, { ...base, modoDoCanal: null, pedido: {} });
    expect(r).toMatchObject({ ok: false, codigo: "campanha_canal_indisponivel" });
  });
});

/**
 * O banco da CONTA RESEND: só a tabela `organization_resend_accounts` responde.
 * Qualquer outra leitura estoura — um caso de e-mail que fosse procurar número
 * estaria medindo o caminho errado.
 */
const CONTA_CONECTADA = { from_email: "contato@empresa.test", api_key_last4: "abcd" };

function bancoDaContaResend(resposta: "conectada" | "sem_conta" | "indisponivel"): SupabaseClient {
  const cadeia = {
    select: () => cadeia,
    eq: () => cadeia,
    maybeSingle: async () => {
      if (resposta === "indisponivel") return { data: null, error: { message: "leitura falhou" } };
      return { data: resposta === "conectada" ? CONTA_CONECTADA : null, error: null };
    },
  };
  return new Proxy({} as SupabaseClient, {
    get(_alvo, prop) {
      if (prop === "from") {
        return (tabela: string) => {
          if (tabela !== "organization_resend_accounts") {
            throw new Error(`e-mail não deveria ler ${tabela}`);
          }
          return cadeia;
        };
      }
      if (prop === "then") return undefined;
      throw new Error(`leitura inesperada do banco: ${String(prop)}`);
    },
  });
}

const EMAIL = { email_subject: "Novidades de outubro", message_body: "Olá! Passando para contar." };

describe("decidirConteudo — campanha de E-MAIL (#3441)", () => {
  it("o canal de e-mail sai da capability, e não de uma escolha da requisição", async () => {
    await expect(lerModoDoCanal(SEM_BANCO, "org", null)).resolves.toEqual({
      existe: true,
      modo: "email",
      transmissao: false,
    });
  });

  it("(a) aceita assunto + corpo: o modo, as colunas e o texto aparado", async () => {
    const canal = await lerModoDoCanal(SEM_BANCO, "org", null);
    const r = await decidirConteudo(bancoDaContaResend("conectada"), {
      organizationId: "org",
      channelSessionId: null,
      extras: [],
      modoDoCanal: canal.existe ? canal.modo : null,
      pedido: { ...EMAIL, message_body: "  Olá! Passando para contar.  " },
    });
    expect(r).toEqual({
      ok: true,
      modo: "email",
      colunas: {
        message_mode: "email",
        provider_template_name: null,
        provider_template_language: null,
        provider_template_variables: {},
        email_subject: "Novidades de outubro",
      },
      conteudoDeEmail: { assunto: "Novidades de outubro", corpo: "Olá! Passando para contar." },
    });
  });

  it("(a) recusa assunto vazio, corpo vazio e os dois estouros — com motivo próprio", async () => {
    const canal = await lerModoDoCanal(SEM_BANCO, "org", null);
    const decidir = (pedido: Record<string, string | null>) =>
      decidirConteudo(bancoDaContaResend("conectada"), {
        organizationId: "org",
        channelSessionId: null,
        extras: [],
        modoDoCanal: canal.existe ? canal.modo : null,
        pedido,
      });

    await expect(decidir({ email_subject: "   ", message_body: "corpo" })).resolves.toMatchObject({
      ok: false,
      codigo: "campanha_email_assunto_vazio",
      status: 422,
    });
    await expect(decidir({ email_subject: "assunto", message_body: "  " })).resolves.toMatchObject({
      ok: false,
      codigo: "campanha_email_corpo_vazio",
    });
    await expect(
      decidir({ email_subject: "a".repeat(LIMITE_DO_ASSUNTO_DO_EMAIL + 1), message_body: "corpo" }),
    ).resolves.toMatchObject({ ok: false, codigo: "campanha_email_assunto_longo" });
    await expect(
      decidir({ email_subject: "assunto", message_body: "b".repeat(LIMITE_DO_CORPO_DO_EMAIL + 1) }),
    ).resolves.toMatchObject({ ok: false, codigo: "campanha_email_corpo_longo" });
  });

  it("(d) organização SEM conta Resend recebe recusa com motivo — nunca texto livre", async () => {
    const canal = await lerModoDoCanal(SEM_BANCO, "org", null);
    const r = await decidirConteudo(bancoDaContaResend("sem_conta"), {
      organizationId: "org",
      channelSessionId: null,
      extras: [],
      modoDoCanal: canal.existe ? canal.modo : null,
      pedido: EMAIL,
    });
    expect(r).toMatchObject({ ok: false, codigo: "campanha_email_sem_conta", status: 409 });
  });

  it("(d) conta que não pôde ser LIDA não é tratada como ausente", async () => {
    const canal = await lerModoDoCanal(SEM_BANCO, "org", null);
    const r = await decidirConteudo(bancoDaContaResend("indisponivel"), {
      organizationId: "org",
      channelSessionId: null,
      extras: [],
      modoDoCanal: canal.existe ? canal.modo : null,
      pedido: EMAIL,
    });
    expect(r).toMatchObject({ ok: false, codigo: "campanha_email_conta_indisponivel", status: 503 });
  });

  it("(b) WhatsApp continua recusando assunto — não regride", async () => {
    const r = await decidirConteudo(SEM_BANCO, {
      ...base,
      modoDoCanal: "text",
      pedido: { message_body: "Oi", email_subject: "assunto de e-mail" },
    });
    expect(r).toMatchObject({ ok: false, codigo: "campanha_modo_do_canal", status: 422 });
  });

  it("(e) a gravação recebe o conteúdo novo: modo email, assunto e corpo aparado", async () => {
    const canal = await lerModoDoCanal(SEM_BANCO, "org", null);
    const decisao = await decidirConteudo(bancoDaContaResend("conectada"), {
      organizationId: "org",
      channelSessionId: null,
      extras: [],
      modoDoCanal: canal.existe ? canal.modo : null,
      pedido: { ...EMAIL, message_body: "  Olá! Passando para contar.  " },
    });
    if (!decisao.ok) throw new Error("deveria ter passado");
    expect(camposDeGravacao(decisao, "  Olá! Passando para contar.  ")).toEqual({
      message_body: "Olá! Passando para contar.",
      message_mode: "email",
      provider_template_name: null,
      provider_template_language: null,
      provider_template_variables: {},
      email_subject: "Novidades de outubro",
    });
  });

  it("e-mail não usa modelo nem rodízio de números", async () => {
    const canal = await lerModoDoCanal(SEM_BANCO, "org", null);
    const modoDoCanal = canal.existe ? canal.modo : null;
    await expect(
      decidirConteudo(bancoDaContaResend("conectada"), {
        organizationId: "org",
        channelSessionId: null,
        extras: ["outro-numero"],
        modoDoCanal,
        pedido: EMAIL,
      }),
    ).resolves.toMatchObject({ ok: false, codigo: "campanha_modo_do_canal" });
    await expect(
      decidirConteudo(bancoDaContaResend("conectada"), {
        organizationId: "org",
        channelSessionId: null,
        extras: [],
        modoDoCanal,
        pedido: { ...EMAIL, provider_template_name: "oferta" },
      }),
    ).resolves.toMatchObject({ ok: false, codigo: "campanha_modo_do_canal" });
  });
});

describe("decidirConteudo — a campanha por e-mail segue o módulo campanha_por_email (doc 305)", () => {
  const pedidoDeEmail = (db: SupabaseClient) =>
    decidirConteudo(db, {
      organizationId: "org",
      channelSessionId: null,
      extras: [],
      modoDoCanal: "email",
      pedido: EMAIL,
    });

  it("desligado: criar ou editar é recusado com código próprio, antes de ler a conta de envio", async () => {
    vi.mocked(moduloLigado).mockClear();
    vi.mocked(moduloLigado).mockResolvedValueOnce(false);
    // SEM_BANCO estoura em qualquer leitura: a recusa vem antes da conta Resend.
    const r = await pedidoDeEmail(SEM_BANCO);
    expect(r).toMatchObject({ ok: false, codigo: "campanha_email_desligada", status: 404 });
    expect(vi.mocked(moduloLigado).mock.calls[0]![1]).toBe("campanha_por_email");
  });

  it("desligado: a recusa vem antes da conferência de modo — a resposta não descreve o e-mail", async () => {
    vi.mocked(moduloLigado).mockResolvedValueOnce(false);
    const r = await decidirConteudo(SEM_BANCO, {
      organizationId: "org",
      channelSessionId: null,
      extras: [],
      modoDoCanal: "email",
      pedido: { message_mode: "text", message_body: "Oi" },
    });
    expect(r).toMatchObject({ ok: false, codigo: "campanha_email_desligada" });
  });

  it("ligado: a campanha de e-mail é aceita como no restante deste arquivo", async () => {
    vi.mocked(moduloLigado).mockResolvedValueOnce(true);
    const r = await pedidoDeEmail(bancoDaContaResend("conectada"));
    expect(r).toMatchObject({ ok: true, modo: "email", colunas: { message_mode: "email" } });
  });

  it("campanha de WhatsApp não pergunta pelo módulo, ligado ou não", async () => {
    vi.mocked(moduloLigado).mockClear();
    const r = await decidirConteudo(SEM_BANCO, { ...base, modoDoCanal: "text", pedido: { message_body: "Oi" } });
    expect(r).toMatchObject({ ok: true, modo: "text" });
    expect(moduloLigado).not.toHaveBeenCalled();
  });
});

describe("decidirVelocidade", () => {
  // O número oficial cujo provedor faz broadcast, sem variável no modelo.
  const oficial = { modo: "template" as const, transmissao: true, variaveis: {} };

  it("rápida no número oficial passa; sem pedir, fica a que estava", () => {
    expect(decidirVelocidade({ ...oficial, pedida: "rapida", atual: "gradual" })).toEqual({ ok: true, velocidade: "rapida" });
    expect(decidirVelocidade({ ...oficial, pedida: undefined, atual: "rapida" })).toEqual({ ok: true, velocidade: "rapida" });
    expect(decidirVelocidade({ ...oficial, pedida: undefined, atual: "gradual" })).toEqual({ ok: true, velocidade: "gradual" });
  });

  it("rápida ou broadcast pedidos num número por QR são recusados com o código e a frase", () => {
    for (const pedida of ["rapida", "transmissao"] as const) {
      const r = decidirVelocidade({ pedida, atual: "gradual", modo: "text", transmissao: false, variaveis: {} });
      expect(r).toMatchObject({ ok: false, codigo: "campanha_velocidade_do_canal", status: 422 });
    }
  });

  it("campanha rápida ou por broadcast que troca para um número por QR volta a gradual em vez de travar no CHECK", () => {
    for (const atual of ["rapida", "transmissao"] as const) {
      expect(
        decidirVelocidade({ pedida: undefined, atual, modo: "text", transmissao: false, variaveis: {} }),
      ).toEqual({ ok: true, velocidade: "gradual" });
    }
  });

  it("broadcast passa no número que o faz, sem variável ou só com texto fixo", () => {
    expect(decidirVelocidade({ ...oficial, pedida: "transmissao", atual: "gradual" })).toEqual({
      ok: true,
      velocidade: "transmissao",
    });
    expect(
      decidirVelocidade({
        ...oficial,
        pedida: "transmissao",
        atual: "gradual",
        variaveis: { "1": { kind: "fixed", value: "Cafeteira Elétrica" } },
      }),
    ).toEqual({ ok: true, velocidade: "transmissao" });
  });

  it("broadcast com variável que muda por pessoa é recusado, e a frase nomeia a variável", () => {
    const r = decidirVelocidade({
      ...oficial,
      pedida: "transmissao",
      atual: "gradual",
      variaveis: { "1": { kind: "contact_first_name" }, "2": { kind: "fixed", value: "Cafeteira" } },
    });
    expect(r).toMatchObject({ ok: false, codigo: "campanha_transmissao_variavel", status: 422 });
    const frase = r.ok ? "" : fraseDaRecusa(r, (x) => x);
    expect(frase).toContain("({{1}})");
    expect(frase).not.toContain("{{2}}");
    expect(frase).not.toContain("{variaveis}");
  });

  it("trocar o modelo de uma campanha por broadcast para um com nome também é recusado", () => {
    const r = decidirVelocidade({
      ...oficial,
      pedida: undefined,
      atual: "transmissao",
      variaveis: { "1": { kind: "contact_name" } },
    });
    expect(r).toMatchObject({ ok: false, codigo: "campanha_transmissao_variavel" });
  });

  it("broadcast pedido num número oficial cujo provedor não o faz é recusado; a que estava vira rápida", () => {
    const semTransmissao = { ...oficial, transmissao: false };
    expect(decidirVelocidade({ ...semTransmissao, pedida: "transmissao", atual: "gradual" })).toMatchObject({
      ok: false,
      codigo: "campanha_velocidade_do_canal",
    });
    expect(decidirVelocidade({ ...semTransmissao, pedida: undefined, atual: "transmissao" })).toEqual({
      ok: true,
      velocidade: "rapida",
    });
  });
});
