/**
 * AS DUAS COLUNAS DA TELA DE NOVO TENANT FALAM A MESMA LÍNGUA — issue #4526.
 *
 * O relato: as frases do onboarding "não estão compatíveis ou com discordância",
 * e a coluna citada — "E nunca irá fazer - Respeitar quem pediu para parar" —
 * "ficou muito estranho". Estranho porque é literalmente o título da coluna
 * colado no primeiro item: "nunca vai fazer" + "Respeitar quem pediu para parar"
 * diz o CONTRÁRIO do que a conferência faz. E metade dos itens começava por
 * "Não", a outra metade por verbo na afirmativa, e ainda "Só oferecer…" e
 * "Deixar valores…" — quatro formas verbais diferentes na mesma lista.
 *
 * O que este teste guarda, em quatro frentes:
 *
 *   1. PARALELISMO — todo item é uma ação no infinitivo, e nenhum começa por
 *      "E", "Não", "Nunca" ou "Só". A coluna lê como lista de ações proibidas
 *      ("O que ele nunca faz: Prometer preço…"), não como frase truncada.
 *   2. NADA SOME — a lista do onboarding cobre as MESMAS conferências, na
 *      mesma ordem, que `CONFERENCIAS_DE_SAIDA`. Apagar um item para "resolver"
 *      a frase é o jeito errado de fechar esta issue: o que está na vista é o
 *      que o runtime promete (ver `seguranca-lista-casa-com-a-cadeia`).
 *   3. A NOTA DIZ A VERDADE — a frase antiga afirmava que nenhuma conferência
 *      tem interruptor; quatro delas têm (`escolha`/`escolhaEmOutraTela`), e a
 *      nota que ficou não afirma isso.
 *   4. O ESTADO É O DO MOTOR (#1041) — a coluna não promete mais proteção que a
 *      instalação nova não tem: cada item que depende de interruptor carrega o
 *      estado REAL daquela organização e o caminho para ligar. Numa organização
 *      recém-criada as quatro camadas configuráveis vêm desligadas
 *      (`padraoDasCamadasNoAmbiente` com `PROMISE_SEMANTIC_ENABLED` vazio,
 *      `afirmacao_clinica` e `restricao_comercial` sem padrão de ambiente, e a
 *      tarefa do Jev que decide a conferência de fato sem aceite) — e é isso que
 *      o teste monta, pelas funções de verdade, não por fixture.
 *
 * As frases vêm de `NUNCA_FAZ`, e não do `rotulo` da conferência: o painel do
 * agente usa o rótulo como TÍTULO da proteção ("Respeitar quem pediu para
 * parar"), forma que, debaixo de "nunca faz", inverte o sentido. São dois
 * lugares com duas falas, presos à mesma lista de gates por chave.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";

vi.mock("@/app/actions/onboarding/createDefaultAgent", () => ({
  createDefaultAgent: vi.fn(),
  skipAi: vi.fn(),
}));
vi.mock("sonner", () => ({
  toast: { warning: vi.fn(), error: vi.fn(), success: vi.fn() },
}));

import { SetupAiForm } from "@/app/onboarding/setup-ai/_form";
import { CONFERENCIAS_DE_SAIDA, NUNCA_FAZ, itensDaColuna } from "@/lib/ai/guardrails/lista-de-conferencia";
import type { EstadoDasCamadas, ItemDaColuna } from "@/lib/ai/guardrails/lista-de-conferencia";
import { estadoEfetivoDasCamadas, padraoDasCamadasNoAmbiente } from "@/lib/agent-engine/guardrails/camadas-da-org";
import { lerConfigDoJev } from "@/lib/ai/decisao/config";
import { estadoEfetivoDaTarefa, TAREFA_DA_AFIRMACAO_DE_FATO } from "@/lib/ai/decisao/tarefas";

/** As capacidades reais vêm do catálogo; aqui só a forma — o que se mede é a coluna do "nunca". */
const CAPACIDADES = ["Ver o que a empresa atende", "Mover oportunidade de etapa"];
const FRASES = Object.values(NUNCA_FAZ);
const TITULO_ESQUERDA = "O que ele já sabe fazer";
const TITULO_DIREITA = "O que ele nunca faz";

/**
 * O ambiente de uma instalação nova: `.env.example` traz
 * `PROMISE_SEMANTIC_ENABLED=` vazio, e vazio não é "true".
 */
const PADRAO_DE_INSTALACAO_NOVA = padraoDasCamadasNoAmbiente({ PROMISE_SEMANTIC_ENABLED: "" });

/** As quatro conferências que dependem de um interruptor — as outras rodam sempre. */
const DEPENDEM_DE_INTERRUPTOR = [
  "semantic_promise",
  "factual_claim",
  "clinical_claim",
  "commercial_restriction",
] as const;

/** O estado que o motor tem numa organização recém-criada — medido pelas funções reais. */
function estadoDaOrgNova(): EstadoDasCamadas {
  return {
    painel: estadoEfetivoDasCamadas([], PADRAO_DE_INSTALACAO_NOVA),
    afirmacaoDeFato: estadoEfetivoDaTarefa(lerConfigDoJev(null), TAREFA_DA_AFIRMACAO_DE_FATO),
  };
}

function itensDaOrgNova(): ItemDaColuna[] {
  return itensDaColuna(estadoDaOrgNova());
}

function montar(conferencias: ItemDaColuna[] = itensDaOrgNova()) {
  return render(<SetupAiForm capacidades={CAPACIDADES} conferencias={conferencias} />);
}

/** A coluna da direita, como o usuário a vê. */
function colunaDoNunca(): HTMLElement {
  const direita = screen.getByRole("heading", { name: TITULO_DIREITA }).closest("section");
  expect(direita, "a coluna do 'nunca' não tem título próprio").not.toBeNull();
  return direita as HTMLElement;
}

/** O `<li>` do item, pelo começo da frase. */
function itemDaColuna(frase: string | undefined): HTMLElement {
  // NUNCA_FAZ é Record<string, string>: a chave ausente chega aqui como undefined.
  if (frase === undefined) throw new Error("NUNCA_FAZ não tem frase para esta conferência");
  const achado = within(colunaDoNunca())
    .getAllByRole("listitem")
    .find((li) => (li.textContent ?? "").includes(frase));
  expect(achado, `o item "${frase}" não está na coluna`).toBeDefined();
  return achado as HTMLElement;
}

afterEach(cleanup);

describe("onboarding de novo tenant: frases paralelas, sem rótulo grudado", () => {
  it("a lista do 'nunca' cobre as MESMAS conferências, na mesma ordem — nada some", () => {
    // A chave é o `nome` do gate: é ela que casa a fala com o que roda.
    expect(Object.keys(NUNCA_FAZ)).toEqual(CONFERENCIAS_DE_SAIDA.map((c) => c.nome));
    expect(FRASES).toHaveLength(CONFERENCIAS_DE_SAIDA.length);
  });

  it("todo item é uma ação no infinitivo — nenhum começa por 'E', 'Não', 'Nunca' ou 'Só'", () => {
    for (const frase of FRASES) {
      expect(frase, `"${frase}" abre com rótulo ou negação em vez de ação`).not.toMatch(
        /^(E|Não|Nunca|Só)\b/,
      );
      expect(frase, `"${frase}" não é uma ação no infinitivo`).toMatch(
        /^[A-ZÁÉÍÓÚÂÊÔÃÕ][a-zà-ú]+(ar|er|ir)\b/,
      );
      // Rótulo grudado em item é o defeito relatado ("E nunca irá fazer - …").
      expect(frase, `"${frase}" carrega rótulo de coluna`).not.toContain(" - ");
    }
  });

  it("as duas colunas usam a mesma forma: 'O que ele …' e itens em ação", () => {
    montar();
    const esquerda = screen.getByRole("heading", { name: TITULO_ESQUERDA }).closest("section");
    const direita = screen.getByRole("heading", { name: TITULO_DIREITA }).closest("section");
    expect(esquerda, "a coluna do 'já sabe' não tem título próprio").not.toBeNull();
    expect(direita, "a coluna do 'nunca' não tem título próprio").not.toBeNull();

    const itensDaDireita = within(direita as HTMLElement).getAllByRole("listitem");
    expect(itensDaDireita).toHaveLength(CONFERENCIAS_DE_SAIDA.length);
    // O texto renderizado é o mesmo que o título promete — sem "· E nunca …".
    for (const li of itensDaDireita) {
      expect(li.textContent ?? "").not.toMatch(/^·\s*(E|Não)\b/);
    }
  });

  it("a nota da coluna não afirma que nenhuma conferência tem escolha", () => {
    montar();
    expect(screen.queryByText(/não têm interruptor/i)).toBeNull();
  });
});

describe("onboarding de novo tenant: a coluna diz o estado REAL de cada camada (#1041)", () => {
  it("nenhum padrão de fábrica foi mexido para a coluna ficar bonita", () => {
    // O conserto é de TELA. Ligar guarda por padrão para cumprir a promessa
    // seria trocar um texto bonito por comportamento novo sem pedido.
    expect(PADRAO_DE_INSTALACAO_NOVA).toEqual({
      promessa_semantica: false,
      jailbreak: true,
      afirmacao_clinica: false,
      restricao_comercial: false,
    });
    expect(lerConfigDoJev(null).ligado).toBe(false);
    expect(estadoDaOrgNova().afirmacaoDeFato).toBe("desligada");
  });

  it("organização nova: as quatro que dependem de interruptor vêm desligadas — e o motor também", () => {
    const porNome = new Map(itensDaOrgNova().map((i) => [i.nome, i]));
    for (const nome of DEPENDEM_DE_INTERRUPTOR) {
      expect(porNome.get(nome)?.estado, `${nome} aparece ativo numa organização nova`).toBe("desligada");
    }
    // As outras não são escolha de ninguém: rodam sempre, sem selo.
    const sempreLigadas = CONFERENCIAS_DE_SAIDA.map((c) => c.nome).filter(
      (nome) => !(DEPENDEM_DE_INTERRUPTOR as readonly string[]).includes(nome),
    );
    expect(sempreLigadas).toHaveLength(CONFERENCIAS_DE_SAIDA.length - 4);
    for (const nome of sempreLigadas) {
      expect(porNome.get(nome)?.estado, `${nome} ganhou interruptor que não existe`).toBeNull();
    }
  });

  it("na tela: todo item diz o seu estado, e o desligado carrega a marca e o caminho para ligar", () => {
    montar();
    const itens = within(colunaDoNunca()).getAllByRole("listitem");
    expect(itens).toHaveLength(CONFERENCIAS_DE_SAIDA.length);

    // Nenhum item fica sem estado na tela — nem os que rodam sempre.
    for (const li of itens) {
      expect(li.getAttribute("data-estado"), `"${li.textContent}" não diz o estado`).not.toBeNull();
    }

    const desligados = itens.filter((li) => li.getAttribute("data-estado") === "desligada");
    expect(desligados, "a organização nova tem quatro camadas desligadas").toHaveLength(4);
    for (const li of desligados) {
      const texto = li.textContent ?? "";
      expect(texto).toMatch(/desligada nesta organização/i);
      // O caminho é o da tela onde o interruptor mora, não um "configuração do agente" genérico.
      expect(texto).toMatch(/Confere antes de enviar|cartão do Jev/i);
      // E não é prometido como ativo: "desligada" não pode virar "ligada".
      expect(texto).not.toMatch(/\bligada nesta organização/i);
    }

    // O caminho certo por camada: as três do painel contra a do cartão do Jev.
    expect(itemDaColuna(NUNCA_FAZ.semantic_promise).textContent).toMatch(/Confere antes de enviar/);
    expect(itemDaColuna(NUNCA_FAZ.clinical_claim).textContent).toMatch(/Confere antes de enviar/);
    expect(itemDaColuna(NUNCA_FAZ.commercial_restriction).textContent).toMatch(/Confere antes de enviar/);
    expect(itemDaColuna(NUNCA_FAZ.factual_claim).textContent).toMatch(/cartão do Jev/);

    // As que rodam sempre não ganham selo de "desligada" nem caminho.
    for (const nome of ["stop", "lgpd", "pacing", "disclosure"]) {
      const li = itemDaColuna(NUNCA_FAZ[nome]);
      expect(li.getAttribute("data-estado")).toBe("sempre");
      expect(li.textContent ?? "").not.toMatch(/desligada nesta organização/i);
    }
  });

  it("com a camada ligada nas configurações, o item passa a aparecer ligado — e só ele", () => {
    const comClinicaLigada: EstadoDasCamadas = {
      ...estadoDaOrgNova(),
      painel: { ...estadoDaOrgNova().painel, afirmacao_clinica: true },
    };
    const itens = itensDaColuna(comClinicaLigada);
    expect(itens.find((i) => i.nome === "clinical_claim")?.estado).toBe("ligada");

    montar(itens);
    const li = itemDaColuna(NUNCA_FAZ.clinical_claim);
    expect(li.getAttribute("data-estado")).toBe("ligada");
    expect(li.textContent ?? "").toMatch(/\bligada nesta organização/);
    expect(li.textContent ?? "").not.toMatch(/desligada nesta organização/i);

    // Ligar uma não liga as outras três: o estado é por camada, não da coluna.
    expect(itens.filter((i) => i.estado === "desligada")).toHaveLength(3);
    expect(itemDaColuna(NUNCA_FAZ.commercial_restriction).getAttribute("data-estado")).toBe("desligada");
  });

  it("a conferência de fato ligada no Jev aparece ligada; só observando, diz que ainda não barra", () => {
    const observando = itensDaColuna({ ...estadoDaOrgNova(), afirmacaoDeFato: "observando" });
    expect(observando.find((i) => i.nome === "factual_claim")?.estado).toBe("so_anota");
    montar(observando);
    expect(itemDaColuna(NUNCA_FAZ.factual_claim).getAttribute("data-estado")).toBe("so_anota");
    expect(itemDaColuna(NUNCA_FAZ.factual_claim).textContent ?? "").toMatch(/só anota/i);

    cleanup();
    const decidindo = itensDaColuna({ ...estadoDaOrgNova(), afirmacaoDeFato: "decidindo" });
    expect(decidindo.find((i) => i.nome === "factual_claim")?.estado).toBe("ligada");
    montar(decidindo);
    expect(itemDaColuna(NUNCA_FAZ.factual_claim).getAttribute("data-estado")).toBe("ligada");
  });
});
