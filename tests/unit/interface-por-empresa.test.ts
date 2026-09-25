/**
 * Portas por EMPRESA (issue #1341, migration 0367).
 *
 * A escolha por vínculo (0221) é a PESSOA. O que faltava era a escolha da
 * ORGANIZAÇÃO — o universo da instalação, um degrau acima. Estes casos fixam as
 * duas propriedades que fazem o degrau existir sem virar autorização:
 *
 *  1. a leitura resolve EMPRESA ∩ VÍNCULO ∩ papel — nenhum dos dois lados abre o
 *     que o outro fechou, e o papel continua decidindo por cima dos dois;
 *  2. a combinação nunca devolve um conjunto vazio: sem interseção sobram as
 *     portas essenciais, porque `destinos: []` é recusado pelo schema e valor
 *     recusado vira interface COMPLETA em `lerInterface` — falha ABERTA, o
 *     oposto do que se quer de uma configuração de menu.
 *
 * O último bloco MEDE a resposta da pergunta de aceite: quantos itens o menu
 * lateral tem hoje e quantos sobram por configuração escolhida. Os números são
 * de MÓDULO (a projeção que o menu consome), não de tela: o instrumento de tela
 * é `tests/e2e/navegacao.spec.ts:222`, que segue intacto.
 */
import { describe, expect, it } from "vitest";

import { NAV_CATALOG } from "@/lib/navigation/catalogo";
import {
  combinarInterfaces,
  destinosDaInterface,
  essencial,
  interfaceSettingsSchema,
  interfaceTemDestino,
  PORTAS_ESSENCIAIS,
  INTERFACE_COMPLETA,
  lerInterface,
  type InterfaceSettings,
} from "@/lib/navigation/interface";
import { GRUPO_NO_RODAPE, sidebarGroups } from "@/lib/navigation/registry";

const completa = { preset: "completa" } as const;
const simplificada = { preset: "simplificada" } as const;

const hrefs = (settings: unknown, role: "agent" | "admin" = "admin") =>
  destinosDaInterface(settings, false, role).map((d) => d.href);

/**
 * Os itens do MENU LATERAL — o mesmo recorte que o instrumento de tela mede:
 * só os grupos que aparecem na dobra, sem o grupo do rodapé.
 */
const itensNoMenuLateral = (settings: unknown, role: "agent" | "admin" = "admin") =>
  sidebarGroups(false, role, settings as InterfaceSettings | undefined)
    .filter((grupo) => grupo.group.id !== GRUPO_NO_RODAPE)
    .reduce((total, grupo) => total + grupo.items.length, 0);

const essenciais = (role: "agent" | "admin" = "admin") =>
  NAV_CATALOG.filter((d) => essencial(d, role)).map((d) => d.href);

describe("portas por empresa (issue #1341)", () => {
  it("sem escolha de nenhum dos lados nada muda: a empresa completa segue completa", () => {
    expect(combinarInterfaces(completa, completa)).toEqual(INTERFACE_COMPLETA);
    expect(combinarInterfaces(undefined, null).destinos).toBeUndefined();
    expect(hrefs(combinarInterfaces(completa, completa))).toEqual(NAV_CATALOG.map((d) => d.href));
  });

  it("o vínculo NÃO abre porta que a empresa não oferece", () => {
    // A empresa oferece um punhado; o vínculo pede tudo. Vale o que a empresa
    // ofereceu — antes desta mudança o vínculo vencia sempre.
    const daEmpresa = { preset: "completa", destinos: ["/app/inbox", "/app/contacts"] } as const;
    const resultado = hrefs(combinarInterfaces(daEmpresa, completa));
    expect(resultado).toContain("/app/inbox");
    expect(resultado).toContain("/app/contacts");
    expect(resultado).not.toContain("/app/products");
    expect(resultado).not.toContain("/app/ai/agents");
  });

  it("o vínculo estreita DENTRO da empresa, e nunca além dela", () => {
    const daEmpresa = {
      preset: "completa",
      destinos: ["/app/inbox", "/app/contacts", "/app/products", "/app/ai/agents"],
    } as const;
    const doVinculo = { preset: "completa", destinos: ["/app/inbox", "/app/products"] } as const;
    expect(hrefs(combinarInterfaces(daEmpresa, doVinculo)).sort()).toEqual(
      [...essenciais(), "/app/inbox", "/app/products"].sort(),
    );
  });

  it("empresa simplificada estreita o vínculo completo (o limite vale dos dois lados)", () => {
    const soEmpresa = hrefs(combinarInterfaces(simplificada, completa));
    expect(soEmpresa).toEqual(hrefs(simplificada));
    expect(soEmpresa).not.toContain("/app/products");
  });

  it("sem interseção sobram as essenciais — nunca `destinos: []` (seria falha ABERTA)", () => {
    // `destinos: []` é recusado pelo schema, e valor recusado vira interface
    // COMPLETA: se a combinação devolvesse lista vazia, a escolha da empresa se
    // transformaria em "mostre tudo". Por isso o piso é o conjunto essencial.
    expect(interfaceSettingsSchema.safeParse({ preset: "completa", destinos: [] }).success).toBe(
      false,
    );
    const daEmpresa = { preset: "completa", destinos: ["/app/inbox"] } as const;
    const doVinculo = { preset: "completa", destinos: ["/app/products"] } as const;
    const resultado = combinarInterfaces(daEmpresa, doVinculo);
    expect(resultado.destinos).not.toEqual([]);
    expect(interfaceSettingsSchema.safeParse(resultado).success).toBe(true);
    expect(lerInterface(resultado).settings.destinos).toEqual(resultado.destinos);
    expect(hrefs(resultado).sort()).toEqual(essenciais().sort());
  });

  it("o PAPEL continua mandando por cima das duas escolhas (controle negativo)", () => {
    const paraAgente = hrefs(combinarInterfaces(completa, completa), "agent");
    const paraAdmin = hrefs(combinarInterfaces(completa, completa));
    // a área administrativa da organização não entra para quem é agente...
    expect(paraAgente).not.toContain("/app/settings/tenant");
    // ...e marcar essa porta na escolha da EMPRESA não promove ninguém
    const comAdminMarcado = combinarInterfaces(
      { preset: "completa", destinos: ["/app/settings/tenant", "/app/inbox"] },
      completa,
    );
    expect(hrefs(comAdminMarcado, "agent")).not.toContain("/app/settings/tenant");
    // o papel só tira: o conjunto do agente é estritamente menor que o do admin
    expect(paraAgente.length).toBeLessThan(paraAdmin.length);
    expect(paraAgente.every((href) => paraAdmin.includes(href))).toBe(true);
  });
});

describe("a organização não consegue se trancar do lado de fora", () => {
  /**
   * A tela que hospeda esta escolha é `/app/settings/tenant`. Se ela puder ser
   * ocultada, a organização que a ocultar perde a porta que DESFAZ a decisão —
   * e não há caminho de volta pela tela, só por banco. É o único item desta
   * configuração que, ao sumir, leva embora a própria capacidade de reconfigurar.
   *
   * Estes casos guardam a PROPRIEDADE (quem administra sempre alcança a tela da
   * escolha), não a lista: quem trocar o href da tela tem de trocar aqui junto,
   * e é isso que se quer — a lista e a tela andam juntas ou o teste reprova.
   */
  const TELA_DA_ESCOLHA = "/app/settings/tenant";

  it("some de todo jeito? não: escolha mínima, sem interseção e vínculo hostil deixam a tela de pé", () => {
    const hostis: unknown[] = [
      { preset: "simplificada" },
      { preset: "completa", destinos: ["/app/inbox"] },
      combinarInterfaces({ preset: "completa", destinos: ["/app/inbox"] }, { preset: "completa", destinos: ["/app/kanban"] }),
      combinarInterfaces({ preset: "simplificada" }, { preset: "completa", destinos: ["/app/tasks"] }),
    ];
    for (const escolha of hostis) {
      expect(
        hrefs(escolha, "admin"),
        `a escolha ${JSON.stringify(escolha)} escondeu a tela que desfaz a escolha`,
      ).toContain(TELA_DA_ESCOLHA);
    }
  });

  it("e ela é essencial por PERTENCIMENTO à lista, não por posição nela", () => {
    // A versão anterior de `essencial` enumerava PORTAS_ESSENCIAIS[0..2]: uma
    // porta acrescentada à lista não teria efeito nenhum, e a lista passaria a
    // prometer uma garantia que o código não dava. Este caso mede a garantia
    // para TODAS as entradas, então ele quebra se alguém voltar a indexar.
    for (const porta of PORTAS_ESSENCIAIS) {
      // O metadado vem do CATÁLOGO, e não de um literal montado aqui: literal
      // compila com um `href` que o catálogo já não tem, e o caso ficaria verde
      // sobre uma porta que não existe mais.
      const d = NAV_CATALOG.find((item) => item.href === porta);
      expect(d, `${porta} está em PORTAS_ESSENCIAIS e não existe no catálogo`).toBeDefined();
      expect(essencial(d!, "admin"), `${porta} está na lista e não é tratada como essencial`).toBe(true);
    }
  });

  it("estar na lista NÃO concede acesso: quem não administra continua sem ver", () => {
    // Controle negativo — sem ele, o caso acima passaria também se `essencial`
    // devolvesse `true` para todo mundo, que seria conceder porta de admin a
    // `agent` em nome de não trancar ninguém.
    const tela = NAV_CATALOG.find((d) => d.href === TELA_DA_ESCOLHA)!;
    expect(hrefs({ preset: "simplificada" }, "agent")).not.toContain(TELA_DA_ESCOLHA);
    expect(essencial(tela, "agent")).toBe(false);
    expect(essencial(tela, "admin")).toBe(true);
  });

  it("controle: uma porta comum continua ocultável — senão a garantia seria vacuidade", () => {
    // Se TUDO fosse essencial, os casos acima passariam sem medir nada.
    expect(hrefs({ preset: "completa", destinos: ["/app/inbox"] }, "admin")).not.toContain("/app/kanban");
  });
});

describe("medição da folga (pergunta de aceite da issue #1341)", () => {
  /**
   * Baseline: a configuração de HOJE — nenhuma escolha, nem da empresa nem do
   * vínculo. É o número que o issue publica (15 itens: atendimento 4, CRM 3,
   * IA 3, canais 2, análise 3), medido aqui pelo módulo que alimenta o menu.
   */
  it("hoje: 15 itens no menu lateral, folga 0 (é o teto da dobra a 1280x900)", () => {
    expect(itensNoMenuLateral(INTERFACE_COMPLETA)).toBe(15);
    // `undefined` é o caminho de quem não tem escolha nenhuma gravada
    expect(itensNoMenuLateral(undefined)).toBe(15);
  });

  /**
   * Depois: a folga deixa de ser um número único e passa a ser escolhida.
   * A escolha da empresa é interseção, então o menu só ENCOLHE — a mudança não
   * tem como empurrar o instrumento de tela para o vermelho.
   */
  it("configuração COMPLETA (ninguém escolheu): 15 itens, folga 0 — igual a hoje", () => {
    expect(itensNoMenuLateral(combinarInterfaces(completa, completa))).toBe(15);
  });

  it("configuração SIMPLIFICADA (empresa escolhe o preset): 6 itens, folga 9", () => {
    const itens = itensNoMenuLateral(combinarInterfaces(simplificada, completa));
    expect(itens).toBe(6);
    expect(15 - itens).toBe(9);
  });

  it("configuração MÍNIMA (empresa escolhe 1 porta): 1 item, folga 14", () => {
    const minima = combinarInterfaces({ preset: "completa", destinos: ["/app/inbox"] }, completa);
    expect(interfaceTemDestino(minima, "admin")).toBe(true); // a guarda exige ≥1 porta
    const itens = itensNoMenuLateral(minima);
    expect(itens).toBe(1);
    expect(15 - itens).toBe(14);
  });

  it("nenhuma escolha da empresa pode AUMENTAR o menu (é interseção, não soma)", () => {
    const casos: unknown[] = [
      simplificada,
      { preset: "completa", destinos: ["/app/inbox"] },
      { preset: "completa", destinos: ["/app/inbox", "/app/contacts", "/app/products"] },
      { preset: "completa", destinos: essenciais() },
    ];
    for (const daEmpresa of casos) {
      for (const doVinculo of [completa, simplificada, undefined]) {
        expect(itensNoMenuLateral(combinarInterfaces(daEmpresa, doVinculo))).toBeLessThanOrEqual(15);
      }
    }
  });
});
