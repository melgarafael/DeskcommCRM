// components/kanban/LeadDossier.test.tsx
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { LeadDossier } from "./LeadDossier";
import { CHAVE_DAS_SECOES_RECOLHIDAS } from "./SecaoDoDossie";
import type { Lead } from "@/lib/types/leads";

/**
 * A ORDEM E O RECOLHIMENTO DAS SEÇÕES DO DOSSÊ — issue #3181.
 *
 * ─── O defeito, como o autor o descreveu ────────────────────────────────────
 *
 * A ordem era fixa: Contato → Linha do tempo → Dados do negócio. Com o uso, a
 * linha do tempo cresce (mensagens, mudanças de etapa, automações, follow-ups) e
 * os campos do funil — destino, datas, passageiros, produtos vendidos — ficam
 * atrás de uma parede de rolagem. A ordem dos campos já segue a lógica do
 * atendimento; com a linha do tempo no meio, essa lógica se perde e os campos
 * ficam vazios.
 *
 * ─── Por que o teste mede ORDEM, e não presença ─────────────────────────────
 *
 * Uma asserção de presença (`getByText("Dados do negócio")`) fica verde com a
 * ordem antiga: as três seções sempre estiveram na tela. Quem prova a inversão é
 * a POSIÇÃO no DOM — é o que se lê aqui, por `querySelectorAll("[data-secao]")`,
 * que devolve os nós em ordem de documento, e pelo índice do texto de cada
 * título no `textContent` do painel.
 *
 * ─── O que é mockado, e o que isso custa ────────────────────────────────────
 *
 * As peças de DENTRO das seções (contato, campos, tarefas, propostas) e o
 * `LeadTimeline` são substituídas por marcadores: o objeto deste arquivo é a
 * CASCA do dossiê — ordem, recolhimento e recorte da lista. O desenho da linha
 * do tempo tem teste próprio (`lib/leads/timeline-grouping`), e o formulário de
 * campos também (`LeadFieldsForm`, os testes de `CustomFieldsEditor`). O
 * `LeadTimeline` mockado desenha UMA linha por item recebido, que é como o
 * recorte "no máximo três entradas" fica observável no DOM.
 */

const linhaDoTempo = vi.hoisted(() => ({ itens: [] as Array<{ id: string; type: string }> }));

vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (chave: string) => chave }));
vi.mock("@/hooks/i18n/useLocaleDeData", () => ({ useTagDeIdioma: () => "pt-BR" }));
vi.mock("@/hooks/auth/AuthProvider", () => ({
  useUser: () => ({ id: "u1", is_platform_admin: false, support: false }),
  useActiveOrg: () => ({ role: "agent" }),
  // O seletor de etapa do cabeçalho (#3272) lê a régua de mover card.
  usePermission: () => false,
}));
vi.mock("@/hooks/leads/useLeadTimeline", () => ({
  useLeadTimeline: () => ({
    itens: linhaDoTempo.itens,
    chegouAoVivo: new Set<string>(),
    isLoading: false,
    isError: false,
    realtimeStatus: "connected",
    seguranca: { divergencias: 0 },
  }),
}));

vi.mock("./ContatoDoNegocio", () => ({ ContatoDoNegocio: () => <div data-peca="contato" /> }));
vi.mock("./LeadFieldsForm", () => ({ LeadFieldsForm: () => <div data-peca="campos" /> }));
vi.mock("./TarefasDoNegocio", () => ({ TarefasDoNegocio: () => <div data-peca="tarefas" /> }));
vi.mock("./PropostasDoNegocio", () => ({ PropostasDoNegocio: () => null }));
vi.mock("./ConversaNoDossie", () => ({ ConversaNoDossie: () => null }));
vi.mock("./ScoreSlot", () => ({ ScoreSlot: () => null }));
vi.mock("./OwnerBadge", () => ({ OwnerBadge: () => null }));
vi.mock("./LeadTimeline", () => ({
  LeadTimeline: ({ itens }: { itens: Array<{ id: string; type: string }> }) => (
    <ul data-peca="linha-do-tempo">
      {itens.map((i) => (
        <li key={i.id} data-entrada={i.id} />
      ))}
    </ul>
  ),
}));

// jsdom não implementa `scrollIntoView`, e o atalho "Editar campos" o chama.
window.HTMLElement.prototype.scrollIntoView ??= () => undefined;

const LEAD = {
  id: "lead-1",
  title: "Viagem Rio",
  contact_id: "contato-1",
  contact_phone: "+5521999999999",
  value_cents: 250000,
  currency: "BRL",
  score: null,
  conversa: null,
  owner_kind: null,
  owner_user_id: null,
  owner_agent_id: null,
  owner_agent: null,
} as unknown as Lead;

function montarDossie() {
  return render(
    <LeadDossier
      open
      onOpenChange={() => undefined}
      lead={LEAD}
      pipelineId="funil-1"
      fieldDefs={[]}
      stageName="Novo"
    />,
  );
}

/** Os identificadores das seções, NA ORDEM DO DOM. */
function ordemDasSecoes(): string[] {
  return [...document.querySelectorAll("[data-secao]")].map((n) => n.getAttribute("data-secao")!);
}

function secao(id: string): HTMLElement {
  const no = document.querySelector(`[data-secao="${id}"]`);
  expect(no, `a seção ${id} não está no DOM`).not.toBeNull();
  return no as HTMLElement;
}

function entradasVisiveis(): string[] {
  return [...document.querySelectorAll("[data-entrada]")].map((n) => n.getAttribute("data-entrada")!);
}

function seisAtividades() {
  // A rota devolve `performed_at` decrescente: o primeiro item da lista é o mais
  // recente, e é por isso que "as últimas três" é um corte no INÍCIO.
  return ["a6", "a5", "a4", "a3", "a2", "a1"].map((id) => ({ id, type: "stage_changed" }));
}

describe("a ordem das seções do dossiê (#3181)", () => {
  beforeEach(() => {
    window.localStorage.clear();
    linhaDoTempo.itens = seisAtividades();
  });

  it("⭐ a ordem padrão é Contato, Dados do negócio, Linha do tempo", () => {
    montarDossie();

    expect(ordemDasSecoes()).toEqual(["contato", "dados-do-negocio", "linha-do-tempo"]);

    // A mesma ordem pelo TEXTO que o atendente lê, e não só pelos ids: o id
    // poderia estar certo com o título trocado de lugar. O seletor pega o
    // primeiro `<span>` do cabeçalho — o segundo é o sinal `+`/`−`, que é
    // `aria-hidden` mas continua no `textContent` do `<h3>`.
    const titulos = ordemDasSecoes().map((id) => secao(id).querySelector("h3 button span")?.textContent);
    expect(titulos).toEqual(["Contato", "Dados do negócio", "Linha do tempo"]);

    // E os campos do negócio vêm ANTES de a linha do tempo começar: era
    // exatamente isso que a ordem antiga não entregava.
    const campos = document.querySelector('[data-peca="campos"]');
    const timeline = document.querySelector('[data-peca="linha-do-tempo"]');
    expect(campos).not.toBeNull();
    expect(timeline).not.toBeNull();
    expect(campos!.compareDocumentPosition(timeline!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("as três seções nascem ABERTAS — sem preferência salva, ninguém esconde conteúdo", () => {
    montarDossie();

    for (const id of ["contato", "dados-do-negocio", "linha-do-tempo"]) {
      expect(secao(id).getAttribute("data-recolhida")).toBe("nao");
      const cabecalho = within(secao(id)).getByRole("button");
      expect(cabecalho, `a seção ${id} não se anuncia aberta`).toHaveAttribute("aria-expanded", "true");
    }
    // O painel inteiro: contato, campos, tarefas e timeline montados.
    for (const peca of ["contato", "campos", "tarefas", "linha-do-tempo"]) {
      expect(document.querySelector(`[data-peca="${peca}"]`), `falta a peça ${peca}`).not.toBeNull();
    }
  });
});

describe("a linha do tempo recolhida (#3181)", () => {
  beforeEach(() => {
    window.localStorage.clear();
    linhaDoTempo.itens = seisAtividades();
  });

  it("⭐ recolhida: no máximo 3 entradas (as mais recentes) e o 'ver tudo'", async () => {
    window.localStorage.setItem(CHAVE_DAS_SECOES_RECOLHIDAS, JSON.stringify(["linha-do-tempo"]));

    montarDossie();

    await waitFor(() => expect(secao("linha-do-tempo").getAttribute("data-recolhida")).toBe("sim"));

    expect(entradasVisiveis()).toEqual(["a6", "a5", "a4"]);
    expect(entradasVisiveis().length).toBeLessThanOrEqual(3);
    expect(within(secao("linha-do-tempo")).getByRole("button", { name: "Ver tudo" })).toBeInTheDocument();
    expect(within(secao("linha-do-tempo")).getByRole("button", { name: "Linha do tempo" })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
  });

  it("⭐ aberta: TODAS as entradas continuam lá", async () => {
    montarDossie();

    await waitFor(() => expect(entradasVisiveis().length).toBe(6));
    // Nada de "ver tudo" com a lista inteira na tela: o botão não teria destino.
    expect(screen.queryByRole("button", { name: "Ver tudo" })).not.toBeInTheDocument();
  });

  it("o 'ver tudo' abre a seção com a lista completa", async () => {
    const user = userEvent.setup();
    window.localStorage.setItem(CHAVE_DAS_SECOES_RECOLHIDAS, JSON.stringify(["linha-do-tempo"]));
    montarDossie();

    const verTudo = await within(secao("linha-do-tempo")).findByRole("button", { name: "Ver tudo" });
    await user.click(verTudo);

    expect(secao("linha-do-tempo").getAttribute("data-recolhida")).toBe("nao");
    expect(entradasVisiveis()).toHaveLength(6);
  });

  it("linha do tempo curta não inventa um 'ver tudo' vazio", async () => {
    linhaDoTempo.itens = [{ id: "a1", type: "lead_created" }];
    window.localStorage.setItem(CHAVE_DAS_SECOES_RECOLHIDAS, JSON.stringify(["linha-do-tempo"]));
    montarDossie();

    await waitFor(() => expect(entradasVisiveis()).toEqual(["a1"]));
    expect(screen.queryByRole("button", { name: "Ver tudo" })).not.toBeInTheDocument();
  });
});

describe("o estado recolhido é LEMBRADO entre renderizações (#3181)", () => {
  beforeEach(() => {
    window.localStorage.clear();
    linhaDoTempo.itens = seisAtividades();
  });

  it("⭐ recolher a linha do tempo sobrevive a um segundo dossiê", async () => {
    const user = userEvent.setup();
    const primeiro = montarDossie();

    await user.click(within(secao("linha-do-tempo")).getByRole("button", { name: "Linha do tempo" }));
    expect(secao("linha-do-tempo").getAttribute("data-recolhida")).toBe("sim");
    expect(JSON.parse(window.localStorage.getItem(CHAVE_DAS_SECOES_RECOLHIDAS) ?? "[]")).toContain(
      "linha-do-tempo",
    );
    primeiro.unmount();

    // Segundo render, o mesmo navegador: fica como a pessoa deixou.
    montarDossie();
    await waitFor(() => expect(secao("linha-do-tempo").getAttribute("data-recolhida")).toBe("sim"));
    expect(entradasVisiveis()).toEqual(["a6", "a5", "a4"]);
  });

  it("recolher 'Contato' não recolhe as outras seções", async () => {
    const user = userEvent.setup();
    montarDossie();

    await user.click(within(secao("contato")).getByRole("button", { name: "Contato" }));

    expect(secao("contato").getAttribute("data-recolhida")).toBe("sim");
    expect(secao("dados-do-negocio").getAttribute("data-recolhida")).toBe("nao");
    expect(secao("linha-do-tempo").getAttribute("data-recolhida")).toBe("nao");
    expect(JSON.parse(window.localStorage.getItem(CHAVE_DAS_SECOES_RECOLHIDAS) ?? "[]")).toEqual(["contato"]);
  });

  it("reabrir a seção também é lembrado", async () => {
    const user = userEvent.setup();
    window.localStorage.setItem(CHAVE_DAS_SECOES_RECOLHIDAS, JSON.stringify(["contato", "linha-do-tempo"]));
    montarDossie();

    await waitFor(() => expect(secao("contato").getAttribute("data-recolhida")).toBe("sim"));
    await user.click(within(secao("contato")).getByRole("button", { name: "Contato" }));

    expect(secao("contato").getAttribute("data-recolhida")).toBe("nao");
    expect(JSON.parse(window.localStorage.getItem(CHAVE_DAS_SECOES_RECOLHIDAS) ?? "[]")).toEqual([
      "linha-do-tempo",
    ]);
    // A outra continua fechada: alternar uma seção não mexe no resto.
    expect(secao("linha-do-tempo").getAttribute("data-recolhida")).toBe("sim");
  });

  it("storage bloqueado (aba privada) não derruba o dossiê nem o clique", async () => {
    const user = userEvent.setup();
    const estoura = () => {
      throw new Error("SecurityError");
    };
    // `Object.defineProperty` na INSTÂNCIA, e não `spyOn`: o `Storage` do jsdom
    // traz os dois métodos no protótipo, e é a instância que o React usa.
    for (const metodo of ["getItem", "setItem"] as const) {
      Object.defineProperty(window.localStorage, metodo, { value: estoura, configurable: true });
    }

    try {
      montarDossie();
      await user.click(within(secao("linha-do-tempo")).getByRole("button", { name: "Linha do tempo" }));

      // O clique vale nesta sessão; só não sobrevive a um F5.
      expect(secao("linha-do-tempo").getAttribute("data-recolhida")).toBe("sim");
    } finally {
      for (const metodo of ["getItem", "setItem"] as const) {
        delete (window.localStorage as unknown as Record<string, unknown>)[metodo];
      }
    }
  });
});

describe("os campos do negócio continuam alcançáveis (#3181)", () => {
  beforeEach(() => {
    window.localStorage.clear();
    linhaDoTempo.itens = seisAtividades();
  });

  it("o atalho 'Editar campos' ABRE a seção recolhida e monta o formulário", async () => {
    const user = userEvent.setup();
    window.localStorage.setItem(CHAVE_DAS_SECOES_RECOLHIDAS, JSON.stringify(["dados-do-negocio"]));
    montarDossie();

    await waitFor(() => expect(secao("dados-do-negocio").getAttribute("data-recolhida")).toBe("sim"));
    // Recolhida, o formulário fica MONTADO e escondido — fechar no meio de uma
    // edição não pode descartar o que já foi digitado.
    expect(document.querySelector('[data-peca="campos"]')).not.toBeNull();

    await user.click(screen.getByRole("button", { name: "Editar campos" }));

    expect(secao("dados-do-negocio").getAttribute("data-recolhida")).toBe("nao");
    expect(within(secao("dados-do-negocio")).getByRole("button", { expanded: true })).toBeInTheDocument();
  });
});
