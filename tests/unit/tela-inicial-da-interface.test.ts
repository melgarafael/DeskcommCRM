import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { NAV_CATALOG } from "@/lib/navigation/catalogo";
import {
  combinarInterfaces,
  destinosDaInterface,
  homeDaInterface,
  essencial,
  interfaceSettingsSchema,
  lerInterface,
  type InterfaceSettings,
} from "@/lib/navigation/interface";

/**
 * TELA INICIAL (#4864) — a preferência por onde se ENTRA.
 *
 * O pedido da comunidade é de quem opera um nicho: dona de loja e vendedora
 * abrem o sistema para UMA tela, e o Inbox (regra fixa de hoje) é a tela errada.
 * O que estes casos protegem é o par que a issue exige:
 *
 *   1. a escolha, quando vale, decide a entrada;
 *   2. a escolha NUNCA vira 404 nem tela vazia — porta oculta, papel que perdeu
 *      a porta ou valor velho caem na regra de sempre, sem exceção.
 *
 * Menu e tela inicial são APRESENTAÇÃO, não autorização (#2059): nada aqui
 * concede acesso, e `destinosDaInterface` continua sendo quem decide o visível.
 */

const completa = { preset: "completa" } as const;
const hrefsDe = (settings: unknown, role: "agent" | "admin" = "admin") =>
  destinosDaInterface(settings, false, role).map((d) => d.href);

describe("tela inicial: a escolha decide a entrada", () => {
  it("abre a porta escolhida em vez do Inbox", () => {
    expect(homeDaInterface({ preset: "completa", inicio: "/app/kanban" }, false, "admin")).toBe(
      "/app/kanban",
    );
    // O Inbox continua visível — a escolha é sobre ENTRAR, não sobre esconder.
    expect(hrefsDe({ preset: "completa", inicio: "/app/kanban" })).toContain("/app/inbox");
  });

  it("sem escolha, a regra de sempre não muda um byte", () => {
    expect(homeDaInterface(completa, false, "admin")).toBe("/app/inbox");
    // Menu enxuto sem Inbox: continua sendo a primeira porta não essencial — na
    // ordem do CATÁLOGO, que é a ordem em que `destinos` é normalizado.
    const semInbox = { preset: "completa", destinos: ["/app/tasks", "/app/kanban"] } as const;
    const naoEssenciais = destinosDaInterface(semInbox, false, "admin").filter(
      (d) => !essencial(d, "admin"),
    );
    expect(homeDaInterface(semInbox, false, "admin")).toBe(naoEssenciais[0]?.href);
    expect(naoEssenciais.map((d) => d.href)).not.toContain("/app/inbox");
  });

  it("o vínculo vence a empresa; a empresa vale para quem não escolheu", () => {
    expect(
      combinarInterfaces(
        { preset: "completa", inicio: "/app/agenda" },
        { preset: "completa", inicio: "/app/tasks" },
      ).inicio,
    ).toBe("/app/tasks");
    expect(
      combinarInterfaces({ preset: "completa", inicio: "/app/agenda" }, { preset: "completa" })
        .inicio,
    ).toBe("/app/agenda");
    expect(combinarInterfaces(undefined, null).inicio).toBeUndefined();
  });

  it("a escolha atravessa a combinação também quando há lista explícita de portas", () => {
    // As quatro saídas de `combinarInterfaces` reconstroem o objeto: a `inicio`
    // precisa sobreviver a TODAS, senão a escolha some do `ActiveOrg`.
    const daEmpresa = { preset: "completa", inicio: "/app/tasks" } as const;
    const doVinculo = { preset: "completa", destinos: ["/app/inbox", "/app/tasks"] } as const;
    const combinada = combinarInterfaces(daEmpresa, doVinculo);
    expect(combinada.inicio).toBe("/app/tasks");
    expect(homeDaInterface(combinada, false, "admin")).toBe("/app/tasks");

    // Preset simplificado dos dois lados (a saída `soPreset`), com escolha da empresa.
    const simplificada = combinarInterfaces(
      { preset: "simplificada", inicio: "/app/agenda" },
      { preset: "simplificada" },
    );
    expect(simplificada.inicio).toBe("/app/agenda");
  });
});

describe("tela inicial: escolha que não vale cai na regra de sempre", () => {
  it("porta que a empresa ocultou depois não vira entrada", () => {
    const combinada = combinarInterfaces(
      // A empresa passou a mostrar só Tarefas…
      { preset: "completa", destinos: ["/app/tasks"] },
      // …mas o vínculo tinha escolhido o Kanban como entrada.
      { preset: "completa", inicio: "/app/kanban" },
    );
    expect(hrefsDe(combinada)).not.toContain("/app/kanban");
    expect(homeDaInterface(combinada, false, "admin")).toBe("/app/tasks");
  });

  it("porta que o PAPEL não alcança não vira entrada", () => {
    // `/app/settings/tenant` exige admin. O atendente que herdou a escolha
    // entra no Inbox, nunca numa porta que a tela negaria.
    const settings: InterfaceSettings = { preset: "completa", inicio: "/app/settings/tenant" };
    expect(homeDaInterface(settings, false, "agent")).toBe("/app/inbox");
    expect(homeDaInterface(settings, false, "admin")).toBe("/app/settings/tenant");
  });

  it("valor velho ou fora do catálogo é descartado na leitura, sem lançar", () => {
    expect(lerInterface({ preset: "completa", inicio: "/app/removido" }).settings.inicio).toBeUndefined();
    expect(lerInterface({ preset: "completa", inicio: 42 }).settings.inicio).toBeUndefined();
    expect(
      homeDaInterface({ preset: "completa", inicio: "/app/removido" }, false, "admin"),
    ).toBe("/app/inbox");
  });

  it("a escrita recusa caminho que não é porta do catálogo", () => {
    for (const inventada of [
      "/app/m/loja",
      "/app/qualquer",
      "https://evil.test",
      "//evil.test",
      "",
    ]) {
      expect(
        interfaceSettingsSchema.safeParse({ preset: "completa", inicio: inventada }).success,
        inventada,
      ).toBe(false);
    }
    expect(interfaceSettingsSchema.safeParse({ preset: "completa", inicio: "/app/agenda" }).success).toBe(
      true,
    );
  });

  it("nunca devolve 404 nem tela vazia, para nenhuma porta e nenhum papel", () => {
    const catalogo = NAV_CATALOG.map((d) => d.href);
    for (const porta of catalogo) {
      for (const role of ["viewer", "agent", "ai_operator", "manager", "admin"] as const) {
        const settings = { preset: "completa" as const, inicio: porta as never };
        const entrada = homeDaInterface(settings, false, role);
        // A entrada é sempre uma porta do catálogo (ou o Perfil, último recurso)…
        expect(catalogo).toContain(entrada);
        // …e, fora o Perfil, está entre as portas que a pessoa REALMENTE vê.
        const visiveis = destinosDaInterface({ preset: "completa", inicio: porta }, false, role).map(
          (d) => d.href,
        );
        if (entrada !== "/app/settings/profile") expect(visiveis).toContain(entrada);
      }
    }
  });
});

describe("tela inicial: o seletor do membro mede contra a EMPRESA, não contra quem vê", () => {
  // Achado da triagem do #4869: `ActiveOrg.interface_settings` já é
  // `combinarInterfaces(empresa, vínculo DE QUEM ESTÁ VENDO)`. Usado como "menu
  // da empresa" no diálogo do membro, um admin com menu próprio mais curto
  // esconderia do seletor portas que o membro enxerga.
  const empresaCrua = { preset: "completa" } as const;
  const vinculoDoAdminRestrito = { preset: "completa", destinos: ["/app/inbox"] } as const;
  const vinculoDoMembro = { preset: "completa", inicio: "/app/kanban" } as const;
  const opcoes = (visiveis: unknown) =>
    destinosDaInterface(visiveis, false, "agent")
      .filter((d) => !essencial(d, "agent"))
      .map((d) => d.href);

  it("a empresa crua oferece a porta que o menu combinado do admin esconderia", () => {
    const certo = opcoes(combinarInterfaces(empresaCrua, vinculoDoMembro));
    const doAdmin = opcoes(
      combinarInterfaces(combinarInterfaces(empresaCrua, vinculoDoAdminRestrito), vinculoDoMembro),
    );
    expect(certo).toContain("/app/kanban");
    expect(doAdmin).not.toContain("/app/kanban");
    // E a entrada do membro é mesmo o Kanban — a tela que o seletor tem de mostrar.
    expect(homeDaInterface(combinarInterfaces(empresaCrua, vinculoDoMembro), false, "agent")).toBe(
      "/app/kanban",
    );
  });

  it("a página da Equipe passa o menu CRU da organização, não o do ActiveOrg", () => {
    // Componente de servidor com sessão: o contrato é lido na fonte, como em
    // `setores-modulo-desligado.test.ts`.
    const pagina = readFileSync("app/app/team/page.tsx", "utf8");
    expect(pagina).not.toMatch(/interfaceDaEmpresa=\{activeOrg\??\.interface_settings\}/);
    expect(pagina).toMatch(/\.from\("organizations"\)\s*\.select\("interface_settings"\)/);
    expect(pagina).toContain("interfaceDaEmpresa={interfaceDaEmpresa}");
  });
});
