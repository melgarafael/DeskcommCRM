import { describe, expect, it } from "vitest";

import type { MarcaDeSaida } from "@/lib/branding/saida";

import { buildEmailDaCobranca } from "./cobranca";

const MARCA: MarcaDeSaida = {
  nome: "Revenda <Teste>", logoUrl: null, accent: "#336699", accentFg: "#ffffff", origens: { nome: "padrao", cor: "padrao" },
};

describe("e-mail da cobrança", () => {
  it("⭐ título no assunto, texto escapado e o botão que paga", () => {
    const e = buildEmailDaCobranca({
      titulo: "Não identificamos o pagamento de 05/10",
      corpo: "Pague <já>",
      marca: MARCA,
      botao: { rotulo: "Pagar agora", href: "https://invoice.stripe.com/i/abc" },
      rodape: "Você recebe este aviso porque administra esta empresa.",
      idioma: "pt-BR",
    });
    expect(e.subject).toBe("Não identificamos o pagamento de 05/10 — Revenda <Teste>");
    expect(e.html).toContain("Pague &lt;já&gt;");
    expect(e.html).toContain('href="https://invoice.stripe.com/i/abc"');
    expect(e.html).not.toContain("<img");
    expect(e.text).toContain("https://invoice.stripe.com/i/abc");
  });

  it("sem botão, só o texto", () => {
    const e = buildEmailDaCobranca({ titulo: "t", corpo: "c", marca: MARCA, botao: null, rodape: "r", idioma: "pt-BR" });
    expect(e.html).not.toContain("<a ");
  });
});
