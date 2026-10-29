/**
 * O REMETENTE DA AUTOMAÇÃO lido de `organizations.settings` (#3287, fatia 1).
 *
 * Função PURA sobre o jsonb, sem banco e sem rede — quem lê a linha é a ação
 * (`lib/automation/actions/send-email.ts`), e o que se prova aqui é a FORMA:
 *
 *   - os dois campos viram `fromName`/`replyTo` quando existem;
 *   - jsonb de qualquer forma (não-objeto, `branding` string, campo de tipo
 *     errado) cai no vazio de HOJE, sem lançar;
 *   - endereço de resposta torto é RECUSADO aqui e não segue para o cabeçalho —
 *     `Reply-To:` que o provedor devolveria como erro opaco é pior que nenhum.
 */
import { describe, expect, it } from "vitest";

import { remetenteDaOrganizacaoDeSettings } from "@/lib/email/remetente-da-organizacao";

const VAZIO = { fromName: null, replyTo: null };

describe("remetenteDaOrganizacaoDeSettings", () => {
  it("lê o nome e o responder-para gravados na marca da organização", () => {
    expect(
      remetenteDaOrganizacaoDeSettings({
        branding: { email_from_name: "Loja da Ana", email_reply_to: "contato@lojadaana.com" },
      }),
    ).toEqual({ fromName: "Loja da Ana", replyTo: "contato@lojadaana.com" });
  });

  it("apara espaço em branco nas pontas dos dois campos", () => {
    expect(
      remetenteDaOrganizacaoDeSettings({
        branding: { email_from_name: "  Loja da Ana  ", email_reply_to: "  contato@lojadaana.com " },
      }),
    ).toEqual({ fromName: "Loja da Ana", replyTo: "contato@lojadaana.com" });
  });

  it("campo vazio é ausência de configuração, não valor", () => {
    expect(
      remetenteDaOrganizacaoDeSettings({
        branding: { email_from_name: "   ", email_reply_to: "" },
      }),
    ).toEqual(VAZIO);
  });

  it("responder-para torto é recusado, e o nome continua valendo", () => {
    for (const torto of ["não é endereço", "sem-arroba.com", "@semlocal.com", "a@b", "x y@z.com"]) {
      expect(
        remetenteDaOrganizacaoDeSettings({
          branding: { email_from_name: "Loja da Ana", email_reply_to: torto },
        }),
        torto,
      ).toEqual({ fromName: "Loja da Ana", replyTo: null });
    }
  });

  it("jsonb de forma inesperada cai no vazio de hoje, sem lançar", () => {
    const lixo = [
      null,
      undefined,
      42,
      "texto",
      [1, 2],
      {},
      { branding: null },
      { branding: "azul" },
      { branding: [1] },
      // Campo de tipo errado: um nome numérico NÃO vira o texto "7" no cabeçalho.
      { branding: { email_from_name: 7, email_reply_to: { a: 1 } } },
    ];
    for (const entrada of lixo) {
      expect(() => remetenteDaOrganizacaoDeSettings(entrada)).not.toThrow();
      expect(remetenteDaOrganizacaoDeSettings(entrada), JSON.stringify(entrada) ?? "undefined").toEqual(
        VAZIO,
      );
    }
  });

  it("só o nome, ou só o responder-para, cada um resolve sozinho", () => {
    expect(remetenteDaOrganizacaoDeSettings({ branding: { email_from_name: "Ana" } })).toEqual({
      fromName: "Ana",
      replyTo: null,
    });
    expect(remetenteDaOrganizacaoDeSettings({ branding: { email_reply_to: "a@b.com" } })).toEqual({
      fromName: null,
      replyTo: "a@b.com",
    });
  });

  it("os campos da MARCA não viram remetente por acidente", () => {
    // `app_name` é o nome no menu lateral, não o nome no cabeçalho do e-mail:
    // quem escolhe o do e-mail é o campo próprio. Sem esta guarda, uma edição
    // futura que reaproveitasse o `app_name` passaria despercebida.
    expect(
      remetenteDaOrganizacaoDeSettings({
        branding: { app_name: "Loja da Ana", accent_hex: "#b3261e", logo_path: "x/y.png" },
      }),
    ).toEqual(VAZIO);
  });
});
