import { describe, expect, it } from "vitest";

import {
  NAV_DESTINATIONS,
  NAV_GROUPS,
  canSee,
  hubSections,
  searchable,
  sidebarGroups,
} from "@/lib/navigation/registry";

/**
 * O registro é a fonte única da navegação. Estes testes cobrem as projeções
 * puras — quem renderiza (sidebar, hub, ⌘K) não decide nada, só desenha o que
 * sai daqui. A completude do registro contra as rotas de verdade é assunto de
 * `navegacao-completude.test.ts`.
 */

const ADMIN = { platform: false, role: "admin" as const };
const MANAGER = { platform: false, role: "manager" as const };
const AGENT = { platform: false, role: "agent" as const };
const VIEWER = { platform: false, role: "viewer" as const };

function dest(href: string) {
  const d = NAV_DESTINATIONS.find((x) => x.href === href);
  if (!d) throw new Error(`destino ausente do registro: ${href}`);
  return d;
}

describe("integridade do registro", () => {
  it("não tem href duplicado", () => {
    const vistos = new Map<string, number>();
    for (const d of NAV_DESTINATIONS) vistos.set(d.href, (vistos.get(d.href) ?? 0) + 1);
    const duplicados = [...vistos.entries()].filter(([, n]) => n > 1).map(([href]) => href);
    expect(duplicados).toEqual([]);
  });

  it("todo destino aponta para um grupo declarado", () => {
    const ids = new Set(NAV_GROUPS.map((g) => g.id));
    const orfaos = NAV_DESTINATIONS.filter((d) => !ids.has(d.group)).map((d) => d.href);
    expect(orfaos).toEqual([]);
  });

  it("todo destino tem descrição — é o que o hub e o ⌘K mostram", () => {
    const semTexto = NAV_DESTINATIONS.filter((d) => d.description.trim() === "").map((d) => d.href);
    expect(semTexto).toEqual([]);
  });

  it("todo destino de um grupo com hub declara sua seção", () => {
    const comHub = new Set(NAV_GROUPS.filter((g) => g.hub).map((g) => g.id));
    const semSecao = NAV_DESTINATIONS.filter((d) => comHub.has(d.group) && !d.section).map(
      (d) => d.href,
    );
    expect(semSecao).toEqual([]);
  });
});

describe("canSee", () => {
  it("nega quem está abaixo do minRole", () => {
    expect(canSee(dest("/app/audit"), MANAGER.platform, MANAGER.role)).toBe(true);
    expect(canSee(dest("/app/audit"), AGENT.platform, AGENT.role)).toBe(false);
  });

  it("destino sem minRole é visível até para viewer", () => {
    expect(canSee(dest("/app/inbox"), VIEWER.platform, VIEWER.role)).toBe(true);
  });

  it("platform admin vê tudo, inclusive sem org ativa", () => {
    for (const d of NAV_DESTINATIONS) expect(canSee(d, true, null)).toBe(true);
  });

  it("sem papel e sem ser platform admin não vê nada", () => {
    expect(canSee(dest("/app/inbox"), false, null)).toBe(false);
  });
});

describe("sidebarGroups", () => {
  it("devolve os grupos na ordem declarada em NAV_GROUPS", () => {
    const ordem = sidebarGroups(true, null).map((g) => g.group.id);
    const esperada = NAV_GROUPS.map((g) => g.id).filter((id) => ordem.includes(id));
    expect(ordem).toEqual(esperada);
  });

  it("só inclui destino marcado como sidebar", () => {
    const hrefs = sidebarGroups(true, null).flatMap((g) => g.items.map((i) => i.href));
    // Conhecimento existe no registro, mas é do hub — não do sidebar.
    expect(hrefs).not.toContain("/app/ai/knowledge/sources");
    expect(hrefs).toContain("/app/ai/agents");
  });

  it("Etapas do funil é CRM, não Configurações — o achado que originou esta mudança", () => {
    // ⚠️ ESTA ASSERÇÃO MUDOU DE SUPERFÍCIE, e a propriedade guardada é a mesma.
    // Ela cobrava presença no SIDEBAR, que era só o jeito de a tela deixar de
    // ser "um card perdido em Configurações". Com o hub do CRM (`/app/crm`),
    // ela mora atrás de "Ver tudo em CRM" — continua sendo CRM, continua fora
    // de Configurações, e o caminho tem um clique a mais porque desenhar as
    // colunas do funil é trabalho de montagem, não de todo dia.
    //
    // O que NÃO pode voltar é o destino trocar de grupo: é isso que a primeira
    // asserção prende, e ela não depende de onde o item é desenhado.
    expect(dest("/app/settings/tenant/pipelines").group).toBe("crm");
    const hub = hubSections("crm", true, null).flatMap((s) => s.items.map((i) => i.href));
    expect(hub).toContain("/app/settings/tenant/pipelines");
  });

  it("o CRM tem hub, e o sidebar dele fica só com o uso diário", () => {
    // A decisão que devolveu a dobra em 900px (e2e `navegacao.spec.ts`): quando
    // Tarefas virou o quinto destino de CRM, o menu passou a rolar por 13px.
    // O conserto foi o hub — o desenho que o grupo IA já usava —, não mais
    // densidade raspada do `Sidebar.tsx`.
    //
    // A lista é EXATA de propósito. `toContain` deixaria um sexto item entrar
    // calado no sidebar e reabrir a mesma corrida por pixel.
    //
    // Comandas NÃO entra: ela chegou pedindo a quarta linha, e o e2e mediu o
    // menu rolando em 1280×900 — a mesma corrida por pixel que o hub existe
    // para encerrar. Ela mora dentro do hub, em "O dia a dia da venda", que é
    // onde o grupo com hub recebe tela nova (ver o comentário no destino, em
    // lib/navigation/catalogo.ts).

    // `/app/prospecting` NÃO está aqui, e a ausência é decisão, não esquecimento:
    // a tela existe e é alcançável pelo hub e pelo ⌘K, mas o menu já está no
    // limite — com ela seriam 20 portas e o e2e reprova por scroll em 900px. A
    // razão e a condição que encerram a exceção estão ao lado do item, em
    // `lib/navigation/catalogo.ts`.
    const crm = sidebarGroups(true, null).find((g) => g.group.id === "crm");
    expect(crm?.items.map((i) => i.href)).toEqual([
      "/app/kanban",
      "/app/contacts",
      "/app/tasks",
      // "/app/calls" (telefonia por SIP) NÃO entra aqui, e a ausência é a
      // decisão: o módulo é OPCIONAL e nasce desligado (doc 27), então a porta
      // no sidebar custaria um item a TODA instalação — e o vigésimo item é o
      // que faz o menu rolar em 900px, que é a corrida por pixel que este
      // teste existe para vigiar. A tela vive no hub do grupo e no ⌘K. Volta
      // para cá no dia em que o app souber que o módulo está ligado (hoje isso
      // é profile do compose, não estado que o aplicativo conheça).
    ]);
    // E continua alcançável: o hub é a porta dela.
    expect(
      hubSections("crm", true, null).flatMap((s) => s.items.map((i) => i.href)),
    ).toContain("/app/comandas");
    expect(NAV_GROUPS.find((g) => g.id === "crm")?.hub?.href).toBe("/app/crm");
  });

  it("omite o grupo inteiro quando o papel não vê nenhum item dele", () => {
    // CANAIS é todo manager+/admin: um agent não deve ver o título órfão.
    const ids = sidebarGroups(AGENT.platform, AGENT.role).map((g) => g.group.id);
    expect(ids).not.toContain("canais");
    expect(ids).toContain("atendimento");
  });

  it("a ordem dentro do grupo de IA é a do uso real: agentes, follow-ups, roteadores", () => {
    // Provedores e Execuções NÃO entram aqui, e a razão é medida: pô-las na
    // sidebar estourou a dobra em 900px (e2e `navegacao.spec.ts`). Elas seguem
    // o padrão das outras nove telas do grupo — alcançáveis pelo hub "Ver tudo
    // em IA", que é o desenho existente para tela de configuração.
    const ia = sidebarGroups(true, null).find((g) => g.group.id === "ia");
    expect(ia?.items.map((i) => i.href)).toEqual([
      "/app/ai/agents",
      "/app/ai/followups",
      "/app/ai/routers",
    ]);
  });
});

describe("hubSections", () => {
  it("o hub do CRM é inventário: as seis telas do grupo, nas duas seções", () => {
    // As seções são a régua do sidebar escrita por extenso — o que se abre todo
    // dia contra o que se define uma vez. Lista EXATA: `toContain` deixaria uma
    // tela nova entrar sem que ninguém decidisse de que lado dela ela cai.
    const secoes = hubSections("crm", true, null);
    expect(secoes.map((s) => s.section)).toEqual(["O dia a dia da venda", "Preparar a venda"]);
    expect(secoes.flatMap((s) => s.items.map((i) => i.href))).toEqual([
      "/app/prospecting",
      "/app/kanban",
      "/app/campaigns",
      "/app/contacts",
      "/app/tasks",
      "/app/calls",
      "/app/comandas",
      "/app/products",
      "/app/settings/tenant/pipelines",
    ]);
  });

  it("agrupa a IA nas três etapas da jornada, na ordem", () => {
    const secoes = hubSections("ia", true, null).map((s) => s.section);
    expect(secoes).toEqual(["Montar o agente", "Ensinar o agente", "Acompanhar o agente"]);
  });

  it("o hub mostra também o que já está no sidebar — é inventário, não sobra", () => {
    const hrefs = hubSections("ia", true, null).flatMap((s) => s.items.map((i) => i.href));
    expect(hrefs).toContain("/app/ai/agents");
    expect(hrefs).toContain("/app/ai/knowledge/sources");
  });

  it("não vaza destino acima do papel", () => {
    const hrefs = hubSections("organizacao", VIEWER.platform, VIEWER.role).flatMap((s) =>
      s.items.map((i) => i.href),
    );
    expect(hrefs).not.toContain("/app/settings/api-tokens");
    expect(hrefs).toContain("/app/settings/profile");
  });

  it("some com a seção que ficou vazia pela permissão", () => {
    /**
     * Esta asserção era `expect(secoes).not.toContain("Dados e acesso")`, e o
     * que a fazia passar era um ACIDENTE do catálogo: por um tempo, os dois
     * destinos daquela seção eram `admin`. Quando "Dados externos" entrou nela
     * SEM `minRole` — o banco externo é lido por qualquer autenticado, decisão
     * do dono no #1130 —, a seção passou a existir para o `viewer` e o teste
     * ficou vermelho. Ele não pegou defeito nenhum: reprovou o CATÁLOGO por uma
     * mudança que a projeção tratou certo.
     *
     * A propriedade não é sobre uma seção nomeada; é sobre TODA seção, em todo
     * grupo, para todo papel. Escrita assim, ela não envelhece quando alguém
     * acrescenta, move ou reclassifica um destino.
     */
    for (const grupo of NAV_GROUPS) {
      for (const quem of [VIEWER, AGENT, MANAGER, ADMIN]) {
        for (const s of hubSections(grupo.id, quem.platform, quem.role)) {
          expect(
            s.items.length,
            `${grupo.id} / "${s.section}" veio vazia para ${quem.role}`,
          ).toBeGreaterThan(0);
        }
      }
    }

    /**
     * E a testemunha de que a projeção está mesmo sendo exercitada: precisa
     * existir ALGUMA seção que o admin vê e o viewer não. Sem isto, o laço
     * acima seguiria verde num catálogo onde nada é gateado — verde por
     * ausência de caso, que se lê igual a verde por acerto. A seção sai do
     * catálogo, nunca escrita à mão.
     */
    const secoesDe = (quem: typeof VIEWER | typeof ADMIN) =>
      new Set(
        NAV_GROUPS.flatMap((g) =>
          hubSections(g.id, quem.platform, quem.role).map((s) => `${g.id}/${s.section}`),
        ),
      );
    const doViewer = secoesDe(VIEWER);
    const somemParaOViewer = [...secoesDe(ADMIN)].filter((s) => !doViewer.has(s));
    expect(
      somemParaOViewer.length,
      "nenhuma seção some para o viewer — a projeção por papel deixou de ser exercitada",
    ).toBeGreaterThan(0);
  });
});

describe("searchable", () => {
  it("expõe todo destino visível, do sidebar ou não", () => {
    const hrefs = searchable(ADMIN.platform, ADMIN.role).map((d) => d.href);
    expect(hrefs).toContain("/app/ai/knowledge/sources");
    expect(hrefs).toContain("/app/inbox");
  });

  it("respeita o papel", () => {
    const hrefs = searchable(AGENT.platform, AGENT.role).map((d) => d.href);
    expect(hrefs).not.toContain("/app/audit");
  });
});
