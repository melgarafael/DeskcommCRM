/**
 * O hub é a vitrine de um grupo: mostra TUDO que ele tem, com descrição,
 * organizado pela jornada de quem usa. É onde as sete telas que só existiam
 * atrás das abas de IA passam a ser descobertas.
 *
 * A permissão é do registro (`navegacao-registry.test.ts`); aqui é o desenho.
 */
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";

import { NavHub } from "@/components/shell/NavHub";
import { DICIONARIO } from "@/lib/i18n/dicionario";
import { hubSections } from "@/lib/navigation/registry";

afterEach(cleanup);

describe("NavHub", () => {
  it("apresenta a equipe digital e as três etapas da jornada, na ordem", () => {
    render(<NavHub group="ia" isPlatformAdmin role={null} title="Agente de IA" subtitle="" />);
    const secoes = screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent?.trim());
    expect(secoes).toEqual([
      "Montar a equipe",
      "Montar o agente",
      "Ensinar o agente",
      "Acompanhar o agente",
    ]);
  });

  it("desenterra Conhecimento, que só existia atrás das abas", () => {
    render(<NavHub group="ia" isPlatformAdmin role={null} title="Agente de IA" subtitle="" />);
    const link = screen.getByRole("link", { name: /Conhecimento/ });
    expect(link).toHaveAttribute("href", "/app/ai/knowledge/sources");
  });

  it("cada card explica para que serve — é o que o sidebar não cabe dizer", () => {
    render(<NavHub group="ia" isPlatformAdmin role={null} title="Agente de IA" subtitle="" />);
    const link = screen.getByRole("link", { name: /Conhecimento/ });
    expect(link.textContent).toMatch(/consulta antes de responder/i);
  });

  it("mostra também o que já está no sidebar — é inventário, não sobra", () => {
    render(<NavHub group="ia" isPlatformAdmin role={null} title="Agente de IA" subtitle="" />);
    expect(screen.getByRole("link", { name: /Funcionários/ })).toBeTruthy();
  });

  it("some com a seção inteira quando a permissão esvazia", () => {
    render(
      <NavHub group="organizacao" isPlatformAdmin={false} role="viewer" title="Org" subtitle="" />,
    );
    const secoes = screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent?.trim());
    expect(secoes).toContain("Sua conta");
    expect(secoes).not.toContain("Dados e acesso");
  });

  it("agrupa os cards sob a própria seção, não numa lista solta", () => {
    render(<NavHub group="ia" isPlatformAdmin role={null} title="Agente de IA" subtitle="" />);
    const ensinar = screen.getByRole("region", { name: "Ensinar o agente" });
    expect(within(ensinar).getByRole("link", { name: /Memória/ })).toBeTruthy();
    expect(within(ensinar).queryByRole("link", { name: /Credenciais/ })).toBeNull();
  });

  it("traduz o conteúdo do hub quando a página entrega o idioma", () => {
    render(
      <NavHub
        group="ia"
        isPlatformAdmin
        role={null}
        title="Agente de IA"
        subtitle="Tudo que define quem atende por você — e como acompanhar o que ele faz."
        locale="es"
      />,
    );

    expect(
      screen.getByText("Todo lo que define quién atiende por ti — y cómo seguir lo que hace."),
    ).toBeTruthy();
    expect(screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent?.trim())).toEqual([
      "Montar el equipo",
      "Configurar el agente",
      "Enseñar al agente",
      "Acompañar al agente",
    ]);
    expect(
      screen.getByRole("link", { name: /Credenciales.*La clave del proveedor de IA/ }),
    ).toBeTruthy();
  });

  it("todo texto registrado no hub de IA tem tradução em espanhol", () => {
    const textos = hubSections("ia", true, "admin").flatMap(({ section, items }) => [
      section,
      ...items.flatMap((item) => [item.label, item.description]),
    ]);

    expect(textos.filter((texto) => !DICIONARIO[texto]?.es)).toEqual([]);
  });
});
