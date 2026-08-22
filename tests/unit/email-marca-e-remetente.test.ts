/**
 * O E-MAIL SAI COM A MARCA DE QUEM HOSPEDA — remetente e corpo.
 *
 * Nenhum dos três templates de e-mail deste produto tinha teste (medido antes
 * desta fase: `grep` por `resend|invite|email-delivery` nos arquivos de teste só
 * achava a própria allowlist da catraca de marca). O resultado foi que 100% dos
 * e-mails de LGPD de todo clone diziam ter sido processados pelo SonghaiCRM, e
 * ninguém foi avisado por gate nenhum.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { NEUTROS_DE_SAIDA, type MarcaDeSaida } from "@/lib/branding/saida";
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
    // o pior caso era o literal "SonghaiCRM" e a questão não existia.
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

    expect(fromAddress("Vendas Turbo")).toBeNull();
  });

  it("o endereço é do operador e o NOME é da marca", async () => {
    process.env.RESEND_FROM_EMAIL = "nao-responda@revenda.com.br";
    const { fromAddress } = await import("@/lib/email/resend");

    expect(fromAddress("Vendas Turbo")).toBe("Vendas Turbo <nao-responda@revenda.com.br>");
    // Sem marca não se inventa uma: sai o endereço puro.
    expect(fromAddress()).toBe("nao-responda@revenda.com.br");
  });

  it("nome de marca não injeta cabeçalho SMTP", async () => {
    process.env.RESEND_FROM_EMAIL = "nao-responda@revenda.com.br";
    const { fromAddress } = await import("@/lib/email/resend");

    const sujo = fromAddress('Acme" <evil@x.com>\r\nBcc: vitima@y.com');
    expect(sujo).not.toContain("\r");
    expect(sujo).not.toContain("\n");
    // `<`, `>`, `"` e as quebras somem; o resto do texto fica, colado — o que
    // importa é que não sobrou cabeçalho nenhum para o SMTP interpretar.
    expect(sujo).toBe("Acme evil@x.comBcc: vitima@y.com <nao-responda@revenda.com.br>");
  });

  it("chave configurada mas remetente vazio = NÃO CONFIGURADO, não envio quebrado", async () => {
    // É a decisão que joga o fluxo no caminho bom que já existe: `pending_review`
    // no worker de LGPD e o link de aceite na tela do convite. Antes, o domínio
    // herdado fazia a Resend recusar e o operador caçava rede e contêiner.
    process.env.RESEND_API_KEY = "re_chave_valida_de_teste";
    process.env.RESEND_FROM_EMAIL = "";
    const { sendEmail, isEmailConfigured } = await import("@/lib/email/resend");

    expect(isEmailConfigured()).toBe(false);
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
