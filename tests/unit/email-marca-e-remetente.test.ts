/**
 * O E-MAIL SAI COM A MARCA DE QUEM HOSPEDA — remetente e corpo.
 *
 * Nenhum dos três templates de e-mail deste produto tinha teste (medido antes
 * desta fase: `grep` por `resend|invite|email-delivery` nos arquivos de teste só
 * achava a própria allowlist da catraca de marca). O resultado foi que 100% dos
 * e-mails de LGPD de todo clone diziam ter sido processados pelo DeskcommCRM, e
 * ninguém foi avisado por gate nenhum.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { NEUTROS_DE_SAIDA, type MarcaDeSaida } from "@/lib/branding/saida";
import type { SmtpConfig } from "@/lib/email/config";
import { buildInviteEmail } from "@/lib/email/templates/invite";

const MARCA: MarcaDeSaida = {
  nome: "Vendas Turbo",
  logoUrl: null,
  accent: "#2f6f4e",
  accentFg: "#ffffff",
  origens: { nome: "banco", cor: "banco" },
};

describe("convite de time", () => {
  const convite = () =>
    buildInviteEmail({
      inviterName: "Ana",
      orgName: "Clínica Bem Viver",
      acceptUrl: "https://crm.exemplo.com.br/team/accept-invite/tok",
      role: "agent",
      expiresAt: new Date("2026-08-20T12:00:00.000Z"),
      marca: MARCA,
    });

  it("assunto e corpo trazem a marca de quem convidou, não a do produto", () => {
    const { subject, html, text } = convite();

    expect(subject).toContain("Vendas Turbo");
    expect(html).toContain("Vendas Turbo");
    expect(text).toContain("Vendas Turbo");
    expect(`${subject} ${html} ${text}`).not.toMatch(/deskcomm/i);
  });

  it("o botão usa o accent E a frente calculada — não um azul fixo", () => {
    const { html } = convite();

    expect(html).toContain(`background:${MARCA.accent}`);
    expect(html).toContain(`color:${MARCA.accentFg}`);
    // `#0ea5e9` era o azul que ninguém escolheu: não pertence à rampa do produto
    // e não tinha relação com marca nenhuma.
    expect(html).not.toContain("#0ea5e9");
  });

  it("o resto do corpo vem dos neutros da régua, não de cinzas inventados", () => {
    const { html } = convite();

    expect(html).toContain(NEUTROS_DE_SAIDA.texto);
    expect(html).toContain(NEUTROS_DE_SAIDA.suave);
    // Os cinzas de dois design systems diferentes que conviviam no arquivo.
    for (const orfao of ["#1c1917", "#57534e", "#78716c", "#f5f5f4", "#0c0a09"]) {
      expect(html).not.toContain(orfao);
    }
  });

  it("o logo de quem convidou vai no topo, com dimensão em ATRIBUTO", () => {
    // POR QUE: `MarcaDeSaida.logoUrl` era resolvido, entregue a este template e
    // renderizado por ninguém — meia marca no e-mail que a pessoa abre ANTES de
    // ter visto qualquer tela. A dimensão vai também no atributo porque Outlook
    // desktop descarta `height` de style e desenharia a arte no tamanho original.
    const { html } = buildInviteEmail({
      inviterName: "Ana",
      orgName: "Clínica Bem Viver",
      acceptUrl: "https://crm.exemplo.com.br/team/accept-invite/tok",
      role: "agent",
      expiresAt: new Date("2026-08-20T12:00:00.000Z"),
      marca: { ...MARCA, logoUrl: "https://cdn.exemplo.test/revendedor.png" },
    });

    expect(html).toContain('src="https://cdn.exemplo.test/revendedor.png"');
    expect(html).toContain('height="40"');
    // Legendado com a marca, não com "logo": num leitor de tela (e num cliente
    // que bloqueia imagem) é o `alt` que diz de quem é o e-mail.
    expect(html).toContain('alt="Vendas Turbo"');
  });

  it("sem logo configurado o corpo não tem `<img>` nenhum", () => {
    // Guarda de vacuidade do caso acima e defeito real evitado: um `<img>` com
    // `src` vazio faz o cliente de e-mail desenhar o ícone de imagem quebrada no
    // topo — pior que ausência, e é o estado de fábrica de toda instalação.
    expect(convite().html).not.toContain("<img");
  });

  it("logo com caminho relativo não desenha `<img>` — no e-mail ele seria quebrado", () => {
    // A marca padrão do produto resolve o logo de `public/brand/` como caminho
    // relativo (`/brand/...`), que o próprio app serve. Num cliente de e-mail,
    // relativo não resolve para nada: desenhar seria o ícone de imagem quebrada
    // no topo do primeiro e-mail que a pessoa recebe do sistema.
    const { html } = buildInviteEmail({
      inviterName: "Ana",
      orgName: "Clínica Bem Viver",
      acceptUrl: "https://crm.exemplo.com.br/team/accept-invite/tok",
      role: "agent",
      expiresAt: new Date("2026-08-20T12:00:00.000Z"),
      marca: { ...MARCA, logoUrl: "/brand/canti-crm-logo-full.png" },
    });

    expect(html).not.toContain("<img");
  });

  it("URL de logo com aspas não escapa do atributo", () => {
    // `platform_branding.logo_url` é `text` livre no banco e a tela de marca
    // ainda não o edita — o valor pode ter vindo de SQL ou de um `.env` colado.
    const { html } = buildInviteEmail({
      inviterName: "Ana",
      orgName: "Acme",
      acceptUrl: "https://x/y",
      role: "agent",
      expiresAt: new Date("2026-08-20T12:00:00.000Z"),
      marca: { ...MARCA, logoUrl: 'https://x/y.png" onerror="alert(1)' },
    });

    expect(html).not.toContain('onerror="alert(1)"');
    expect(html).toContain("&quot; onerror=&quot;alert(1)");
  });

  it("marca com HTML dentro é escapada no corpo", () => {
    // O nome vem de um campo que o operador digita numa tela; antes desta fase
    // o pior caso era o literal "DeskcommCRM" e a questão não existia.
    const { html } = buildInviteEmail({
      inviterName: "Ana",
      orgName: "Acme",
      acceptUrl: "https://x/y",
      role: "agent",
      expiresAt: new Date("2026-08-20T12:00:00.000Z"),
      marca: { ...MARCA, nome: '<img src=x onerror="alert(1)">' },
    });

    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;img src=x");
  });
});

describe("remetente", () => {
  const ORIGINAIS = {
    key: process.env.RESEND_API_KEY,
    from: process.env.RESEND_FROM_EMAIL,
  };

  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    for (const [chave, valor] of [
      ["RESEND_API_KEY", ORIGINAIS.key],
      ["RESEND_FROM_EMAIL", ORIGINAIS.from],
    ] as const) {
      if (valor === undefined) delete process.env[chave];
      else process.env[chave] = valor;
    }
    vi.resetModules();
  });

  it("sem RESEND_FROM_EMAIL não existe remetente — e NUNCA um domínio do produto", async () => {
    process.env.RESEND_FROM_EMAIL = "";
    const { fromAddress } = await import("@/lib/email/resend");

    expect(fromAddress(process.env.RESEND_FROM_EMAIL ?? null, "Vendas Turbo")).toBeNull();
  });

  it("o endereço é do operador e o NOME é da marca", async () => {
    process.env.RESEND_FROM_EMAIL = "nao-responda@revenda.com.br";
    const { fromAddress } = await import("@/lib/email/resend");

    expect(fromAddress("nao-responda@revenda.com.br", "Vendas Turbo")).toBe(
      "Vendas Turbo <nao-responda@revenda.com.br>",
    );
    // Sem marca não se inventa uma: sai o endereço puro.
    expect(fromAddress("nao-responda@revenda.com.br")).toBe("nao-responda@revenda.com.br");
  });

  it("nome de marca não injeta cabeçalho SMTP", async () => {
    process.env.RESEND_FROM_EMAIL = "nao-responda@revenda.com.br";
    const { fromAddress } = await import("@/lib/email/resend");

    const sujo = fromAddress(
      "nao-responda@revenda.com.br",
      'Acme" <evil@x.com>\r\nBcc: vitima@y.com',
    );
    expect(sujo).not.toContain("\r");
    expect(sujo).not.toContain("\n");
    // `<`, `>`, `"` e as quebras somem; o resto do texto fica, colado — o que
    // importa é que não sobrou cabeçalho nenhum para o SMTP interpretar.
    expect(sujo).toBe("Acme evil@x.comBcc: vitima@y.com <nao-responda@revenda.com.br>");
  });

  it("ENDEREÇO com caractere de cabeçalho é recusado — ele virou entrada de tela na 0341", async () => {
    // Enquanto o endereço vinha só do `.env`, mexer nele exigia SSH: quem podia
    // já tinha o servidor. Desde a 0341 ele vem de um campo do painel, e um
    // `\r\n` aqui emenda um cabeçalho novo no `From:` — um `Bcc:` para terceiro,
    // por exemplo. RECUSA em vez de limpar: endereço com caractere de cabeçalho
    // não é endereço a consertar, é endereço a não usar.
    const { fromAddress } = await import("@/lib/email/resend");

    expect(fromAddress("ok@x.com\r\nBcc: vitima@y.com")).toBeNull();
    expect(fromAddress("ok@x.com\nBcc: vitima@y.com")).toBeNull();
    expect(fromAddress('"<evil@x.com>')).toBeNull();
    expect(fromAddress("a@x.com, b@y.com")).toBeNull();
    // controle positivo: o endereço legítimo continua passando
    expect(fromAddress("ok@x.com")).toBe("ok@x.com");
  });

  it("chave configurada mas remetente vazio = NÃO CONFIGURADO, não envio quebrado", async () => {
    // É a decisão que joga o fluxo no caminho bom que já existe: `pending_review`
    // no worker de LGPD e o link de aceite na tela do convite. Antes, o domínio
    // herdado fazia a Resend recusar e o operador caçava rede e contêiner.
    process.env.RESEND_API_KEY = "re_chave_valida_de_teste";
    process.env.RESEND_FROM_EMAIL = "";
    const { sendEmail, isEmailConfigured } = await import("@/lib/email/resend");

    expect(await isEmailConfigured()).toBe(false);
    const r = await sendEmail({ to: "a@b.com", subject: "s", html: "<p>x</p>" });
    expect(r).toEqual({ ok: false, error: "not_configured" });
  });

  it("domínio não verificado tem NOME próprio, e não vira 'send_failed' genérico", async () => {
    process.env.RESEND_API_KEY = "re_chave_valida_de_teste";
    process.env.RESEND_FROM_EMAIL = "nao-responda@revenda.com.br";
    vi.doMock("resend", () => ({
      Resend: class {
        emails = {
          send: async () => ({
            data: null,
            error: {
              name: "validation_error",
              message:
                "The revenda.com.br domain is not verified. Please add and verify your domain on https://resend.com/domains",
            },
          }),
        };
      },
    }));
    const { sendEmail } = await import("@/lib/email/resend");

    const r = await sendEmail({ to: "a@b.com", subject: "s", html: "<p>x</p>" });
    expect(r.error).toBe("dominio_nao_verificado");
    // A mensagem crua continua disponível: falhar fechado na AÇÃO, aberto na
    // INFORMAÇÃO.
    expect(r.details).toContain("not verified");
    vi.doUnmock("resend");
  });

  it("limite de envio continua distinguível do resto", async () => {
    process.env.RESEND_API_KEY = "re_chave_valida_de_teste";
    process.env.RESEND_FROM_EMAIL = "nao-responda@revenda.com.br";
    vi.doMock("resend", () => ({
      Resend: class {
        emails = {
          send: async () => ({
            data: null,
            error: { name: "rate_limit_exceeded", message: "Too many requests" },
          }),
        };
      },
    }));
    const { sendEmail } = await import("@/lib/email/resend");

    expect((await sendEmail({ to: "a@b.com", subject: "s", html: "x" })).error).toBe(
      "rate_limited",
    );
    vi.doUnmock("resend");
  });
});

/**
 * O MESMO CONTRATO DE REMETENTE, DO OUTRO LADO — o transporte SMTP.
 *
 * Os casos da Resend acima NÃO foram substituídos, e isso é o ponto: os dois
 * caminhos convivem (decisão do dono do produto sobre o PR #714), então cada um
 * precisa do seu próprio guarda. A regra que os dois compartilham é a mesma que
 * este arquivo já defendia: sem remetente configurado não existe e-mail, e
 * NUNCA se inventa um domínio do produto.
 *
 * Crédito: @betoarts (PR #714).
 */
describe("remetente — SMTP", () => {
  const config = {
    host: "smtp.revenda.com.br",
    port: 465,
    security: "tls" as const,
    username: "nao-responda@revenda.com.br",
    password: "segredo",
    fromEmail: "nao-responda@revenda.com.br",
    fromName: "",
    source: "environment" as const,
  };

  it("sem remetente não existe e-mail de saída — e NUNCA um domínio do produto", async () => {
    const { formatFromAddress, isSmtpConfigured } = await import("@/lib/email/smtp");

    expect(isSmtpConfigured({ ...config, fromEmail: "" })).toBe(false);
    expect(formatFromAddress({ ...config, fromEmail: "" }, "Vendas Turbo")).toBeNull();
  });

  it("o endereço é do operador e o NOME é da marca", async () => {
    const { formatFromAddress } = await import("@/lib/email/smtp");

    expect(formatFromAddress(config, "Vendas Turbo")).toBe(
      "Vendas Turbo <nao-responda@revenda.com.br>",
    );
    // Sem marca não se inventa uma: sai o endereço puro.
    expect(formatFromAddress(config)).toBe("nao-responda@revenda.com.br");
  });

  it("nome de marca não injeta cabeçalho SMTP", async () => {
    const { formatFromAddress } = await import("@/lib/email/smtp");

    const sujo = formatFromAddress(config, 'Acme" <evil@x.com>\r\nBcc: vitima@y.com');
    expect(sujo).not.toContain("\r");
    expect(sujo).not.toContain("\n");
    // `<`, `>`, `"` e as quebras somem; o resto do texto fica, colado — o que
    // importa é que não sobrou cabeçalho nenhum para o SMTP interpretar.
    expect(sujo).toBe("Acme evil@x.comBcc: vitima@y.com <nao-responda@revenda.com.br>");
  });
});

/**
 * O ROTEADOR: SMTP QUANDO HÁ SMTP, RESEND QUANDO NÃO HÁ.
 *
 * Este é o caso que segura a decisão do dono do produto sobre o PR #714 — "os
 * dois caminhos convivem; quem tem Resend não mexe em nada". Sem ele, alguém
 * simplifica `lib/email/roteador.ts` para chamar só o SMTP, o `typecheck` passa,
 * o `lint` passa, os dois casos de remetente acima passam (eles testam os
 * transportes, não a escolha entre eles) — e toda instalação que hoje entrega
 * pela Resend para de mandar convite, em silêncio, na atualização seguinte.
 *
 * O que ele NÃO afirma: que há queda de um transporte para o outro quando o
 * envio FALHA. Não há, e é de propósito (o porquê está no cabeçalho do
 * roteador): a escolha é por configuração, para o mesmo convite não sair duas
 * vezes e para o erro do SMTP do operador não ficar escondido atrás de um
 * sucesso emprestado.
 */
describe("roteador de e-mail", () => {
  // Tipadas pelo CONTRATO (`SmtpConfig`), não pela forma que a fixture tem hoje:
  // com `typeof BASE`, o `source: "none"` da primeira fixture virava o tipo do
  // parâmetro e a segunda (`"environment"`) deixava de caber — `pnpm typecheck`
  // reprovava em TS2345 nas duas chamadas. Amarrar ao tipo do módulo também faz
  // o teste reprovar no dia em que a fixture divergir do contrato.
  const BASE: SmtpConfig = {
    host: "",
    port: 587,
    security: "starttls",
    username: "",
    password: "",
    fromEmail: "",
    fromName: "",
    source: "none",
  };
  const COM_SMTP: SmtpConfig = {
    ...BASE,
    host: "smtp.revenda.com.br",
    fromEmail: "nao-responda@revenda.com.br",
    source: "environment",
  };

  /**
   * `importActual` no módulo de SMTP de propósito: só o ENVIO é substituído, e
   * `isSmtpConfigured` continua sendo o do produto. Mockar a regra de
   * "configurado" faria o teste medir o próprio mock.
   */
  async function rotear(config: SmtpConfig) {
    vi.resetModules();
    const porSmtp = vi.fn(async () => ({ ok: true, id: "id-smtp" }));
    const pelaResend = vi.fn(async () => ({ ok: true, id: "id-resend" }));
    vi.doMock("@/lib/email/config", () => ({ getSmtpConfig: async () => config }));
    vi.doMock("@/lib/email/smtp", async () => ({
      ...(await vi.importActual<Record<string, unknown>>("@/lib/email/smtp")),
      sendEmail: porSmtp,
    }));
    vi.doMock("@/lib/email/resend", async () => ({
      ...(await vi.importActual<Record<string, unknown>>("@/lib/email/resend")),
      sendEmail: pelaResend,
      isEmailConfigured: () => true,
    }));
    const { sendEmail, transporteDeEmail } = await import("@/lib/email/roteador");
    const resultado = await sendEmail({ to: "a@b.com", subject: "s", html: "<p>x</p>" });
    const transporte = await transporteDeEmail();
    vi.doUnmock("@/lib/email/config");
    vi.doUnmock("@/lib/email/smtp");
    vi.doUnmock("@/lib/email/resend");
    vi.resetModules();
    return { resultado, transporte, porSmtp, pelaResend };
  }

  it("com SMTP configurado, o envio sai pelo SMTP", async () => {
    const { resultado, transporte, porSmtp, pelaResend } = await rotear(COM_SMTP);

    expect(transporte).toBe("smtp");
    expect(porSmtp).toHaveBeenCalledTimes(1);
    expect(pelaResend).not.toHaveBeenCalled();
    // O desfecho diz POR ONDE foi: com dois transportes possíveis, "falhou" sem
    // isto não diz a quem instalou onde olhar.
    expect(resultado).toMatchObject({ ok: true, id: "id-smtp", via: "smtp" });
  });

  it("sem SMTP configurado, o envio CAI NA RESEND — quem já tinha e-mail não perde", async () => {
    const { resultado, transporte, porSmtp, pelaResend } = await rotear(BASE);

    expect(transporte).toBe("resend");
    expect(pelaResend).toHaveBeenCalledTimes(1);
    expect(porSmtp).not.toHaveBeenCalled();
    expect(resultado).toMatchObject({ ok: true, id: "id-resend", via: "resend" });
  });

  it("host sem remetente não é SMTP configurado — e cai na Resend, não no vazio", async () => {
    // Meia configuração é o estado real de quem preencheu a tela pela metade.
    // Tratá-la como "tem SMTP" mandaria o envio para um transporte que devolve
    // `not_configured` enquanto a Resend do operador estava lá, funcionando.
    const { transporte, pelaResend } = await rotear({ ...COM_SMTP, fromEmail: "" });

    expect(transporte).toBe("resend");
    expect(pelaResend).toHaveBeenCalledTimes(1);
  });

  const ORIGINAIS_DA_RESEND = {
    key: process.env.RESEND_API_KEY,
    from: process.env.RESEND_FROM_EMAIL,
  };
  afterEach(() => {
    // Sem isto, o último caso deixaria `RESEND_*` em branco para quem rodar no
    // mesmo worker depois — teste que suja o ambiente do vizinho vira "falha
    // que só acontece na suíte inteira".
    for (const [chave, valor] of [
      ["RESEND_API_KEY", ORIGINAIS_DA_RESEND.key],
      ["RESEND_FROM_EMAIL", ORIGINAIS_DA_RESEND.from],
    ] as const) {
      if (valor === undefined) delete process.env[chave];
      else process.env[chave] = valor;
    }
    vi.resetModules();
  });

  it("sem NENHUM dos dois, o desfecho continua sendo not_configured", async () => {
    // É o contrato de que dependem o `pending_review` do worker de LGPD e o
    // link de aceite na tela do convite. O roteador não pode transformá-lo em
    // outra coisa.
    vi.resetModules();
    vi.doMock("@/lib/email/config", () => ({ getSmtpConfig: async () => BASE }));
    process.env.RESEND_API_KEY = "";
    process.env.RESEND_FROM_EMAIL = "";
    const { sendEmail, emailConfigurado } = await import("@/lib/email/roteador");

    expect(await emailConfigurado()).toBe(false);
    expect(await sendEmail({ to: "a@b.com", subject: "s", html: "x" })).toMatchObject({
      ok: false,
      error: "not_configured",
      via: "resend",
    });
    vi.doUnmock("@/lib/email/config");
    vi.resetModules();
  });
});
