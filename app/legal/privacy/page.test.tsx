import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  redirect: vi.fn((destino: string) => {
    throw new Error(`NEXT_REDIRECT:${destino}`);
  }),
}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: { getUser: async () => ({ data: { user: null } }) },
  }),
}));
vi.mock("@/lib/i18n/idiomaAnonimo", () => ({ idiomaDoVisitante: async () => "pt-BR" }));
vi.mock("@/lib/legal/operador", () => ({
  resolverOperador: async () => ({
    sistema: "Marca da Revenda",
    nome: null,
    razaoSocial: null,
    cnpj: null,
    dpoEmail: null,
    politicaPropria: null,
    resolvido: false,
  }),
  nomeDoOperador: () => "o operador desta instalação",
}));

import PrivacyPage from "./page";

describe("/legal/privacy — seção dos dados do Google", () => {
  // O Google recusou a verificação do app porque a política padrão explicava a
  // LGPD e não dizia nada sobre os dados da conta Google. Cada trecho abaixo é
  // uma exigência da política de dados de usuário dos serviços de API do Google.
  it("declara o que é lido, para quê, que não se vende nem treina modelo, e como desfazer", async () => {
    const { container } = render(await PrivacyPage());
    const texto = container.textContent ?? "";

    expect(container.querySelector("#dados-do-google")).not.toBeNull();
    expect(texto).toContain("9. Dados do Google (Agenda e Google Ads)");
    expect(texto).toContain("Google Agenda:");
    expect(texto).toContain("O sistema não lê e-mails");
    expect(texto).toContain("Google Ads:");
    expect(texto).toContain("não são vendidos");
    expect(texto).toContain("não são usados para publicidade");
    expect(texto).toContain("não são usados para treinar modelos de inteligência artificial");
    expect(texto).toContain("Política de Dados de Usuário dos Serviços de API do Google");
    expect(texto).toContain("requisitos de Uso Limitado");
    expect(texto).toContain("Agenda → Desconectar");

    const revogar = container.querySelector('a[href="https://myaccount.google.com/permissions"]');
    expect(revogar).not.toBeNull();
  });

  it("a política continua sendo a mesma LGPD de antes: as oito seções originais seguem", async () => {
    const { container } = render(await PrivacyPage());
    const titulos = Array.from(container.querySelectorAll("h2")).map((h) => h.textContent);
    expect(titulos.slice(0, 8)).toEqual([
      "1. Quem é o controlador",
      "2. Que dados são tratados",
      "3. Para que são usados",
      "4. Com quem são compartilhados",
      "5. Por quanto tempo",
      "6. Seus direitos",
      "7. Segurança",
      "8. Encarregado e contato",
    ]);
  });
});
