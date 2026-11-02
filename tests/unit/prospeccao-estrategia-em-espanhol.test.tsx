/**
 * A ESTRATÉGIA, OS PROBLEMAS E O MOTIVO DO SCORE SAEM EM ESPANHOL NA TELA —
 * E O AGENTE CONTINUA RECEBENDO O MESMO PORTUGUÊS, BYTE A BYTE.
 *
 * Achado do mantenedor no #2711 (19/10): com a interface em `es`, o modal da
 * auditoria mostrava a estratégia inteira, as descrições de problema e o
 * motivo do score em português. O mesmo texto vai ao prompt do agente
 * (`blocoDeEstrategiaParaAgente`, campo `Auditoria` de
 * `montarDadosDeAbordagem`), então a tradução só pode acontecer na TELA.
 *
 * Três provas, uma por direção:
 *   1. sem tradutor, a saída é a de antes (frases literais copiadas do código
 *      anterior a esta mudança) — é o que o modelo recebe;
 *   2. toda frase que a tela pode mostrar tem espanhol no dicionário, numa
 *      matriz que percorre todos os ramos;
 *   3. a tela, com o `t` em espanhol, mostra o espanhol.
 */
import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { DICIONARIO, traduzir } from "@/lib/i18n/dicionario";
import {
  blocoDeEstrategiaParaAgente,
  instrucaoDeAbordagemFria,
  montarDadosDeAbordagem,
  montarEstrategia,
  pontuarCandidato,
  vocabularioDoNicho,
  type EntradaDaEstrategia,
  type EstrategiaDoLead,
  type OfertaDaCampanha,
} from "@/lib/prospecting/estrategia-site";
import { CLASSES_DE_SITE, descreverProblema, type ItemDoRaioX } from "@/lib/prospecting/site-classify";

const paraEspanhol = (texto: string) => traduzir(texto, "es");

// A fábrica do mock sobe acima dos imports: ela importa o próprio tradutor
// em vez de ler a constante de cima, que ainda não existe quando ela roda.
vi.mock("@/hooks/i18n/useT", async () => {
  const { traduzir: traduzirNoMock } = await import("@/lib/i18n/dicionario");
  return { useT: () => (texto: string) => traduzirNoMock(texto, "es") };
});

import { AuditoriaDoSite } from "@/components/prospecting/AuditoriaDoSite";

const base: EntradaDaEstrategia = {
  classe: "sem-site",
  problemas: [],
  checklist: { tem: [], falta: [] },
  nota: 4.9,
  numAvaliacoes: 120,
  temInstagram: false,
  ofertas: ["site"],
  nicho: "clínica",
  provisorio: false,
  status: "new",
  followUpsEnviados: 0,
};

const PROBLEMAS: string[][] = [
  [],
  ["nao-mobile"],
  ["lento"],
  ["construtor-Wix"],
  ["sem-https"],
  ["http-sem-redirecionar"],
  ["http-503", "quase-vazia", "conteudo-misto", "sem-atualizacao-desde-2019"],
  ["dns-morto", "fora-do-ar"],
  ["sem-atualizacao", "falta-whatsapp", "falta-tel"],
];
const REPUTACOES: Array<[number | null, number | null]> = [
  [4.9, 120],
  [4.6, 20],
  [3.5, 3],
  [null, null],
];
/** Oferta e, quando ela pede, o volume de avaliações que a acompanha. */
const OFERTAS: Array<[OfertaDaCampanha[], number | null]> = [
  [["site"], null],
  [["automacao_crm"], 80],
];
const FALTAS: ItemDoRaioX[] = ["whatsapp", "tel", "mapa"];

/** Todas as entradas da matriz: cada ramo de `montarEstrategia` é visitado. */
function* matriz(): Generator<EntradaDaEstrategia> {
  for (const classe of CLASSES_DE_SITE)
    for (const provisorio of [false, true])
      for (const problemas of PROBLEMAS)
        for (const [nota, avaliacoes] of REPUTACOES)
          for (const [ofertas, volume] of OFERTAS)
            for (const temInstagram of [false, true])
              for (const followUpsEnviados of [0, 2])
                for (const status of ["new", "sent", "skipped"])
                  for (const nicho of ["clínica", "pet shop", ""])
                    yield {
                      ...base,
                      classe,
                      provisorio,
                      problemas,
                      nota,
                      // Automação com volume alto é o único caminho do "Site ok, demanda alta".
                      numAvaliacoes: nota === null ? null : (volume ?? avaliacoes),
                      ofertas,
                      temInstagram,
                      followUpsEnviados,
                      status,
                      nicho,
                      checklist: { tem: [], falta: followUpsEnviados > 0 ? FALTAS : [] },
                    };
}

function textosDa(e: EstrategiaDoLead): string[] {
  return [
    e.cenario,
    e.angulo,
    e.proximoPasso,
    ...e.ganchos,
    ...e.objecoes.flatMap((o) => [o.objecao, o.resposta]),
  ];
}

describe("sem tradutor, o texto é o de antes (o que o agente recebe)", () => {
  it("frases literais da estratégia, copiadas do código anterior", () => {
    const naoMobile = montarEstrategia({ ...base, classe: "site-ruim", problemas: ["nao-mobile"] });
    expect(naoMobile.cenario).toBe("Site não-mobile");
    expect(naoMobile.angulo).toBe(
      "O site quebra no celular — e quase toda pesquisa local é no celular. O site atende bem quem quase não existe (desktop) e falha onde está agenda de pacientes.",
    );

    const semSite = montarEstrategia({ ...base, nota: 4.6, numAvaliacoes: 20 });
    expect(semSite.ganchos[0]).toBe(
      "Nota 4.6 com 20 avaliações: a reputação já existe, só não trabalha fora do Maps.",
    );
    expect(semSite.angulo).toBe(
      "Negócio bem avaliado mas invisível para quem pesquisa no Google fora do Maps. Cada pesquisa sem resultado é agenda de pacientes indo para o concorrente que aparece. Presença digital quase zero: hoje só chega quem indica. Um site abre o canal de quem pesquisa por conta própria.",
    );

    const comFollowUp = montarEstrategia({ ...base, followUpsEnviados: 2 });
    expect(comFollowUp.proximoPasso).toBe(
      "Já foram 2 follow-up(s): gere a próxima copy trazendo um elemento NOVO (prazo, exemplo, diagnóstico) — repetir o argumento queima o lead.",
    );

    const comProblemas = montarEstrategia({
      ...base,
      classe: "site-ruim",
      problemas: ["quase-vazia", "http-503"],
      checklist: { tem: [], falta: ["whatsapp", "tel"] },
    });
    expect(comProblemas.ganchos).toContain(
      "Problemas detectados: página praticamente vazia (não apresenta serviços nem contato); o site responde com erro (503).",
    );
    // O gancho das faltas do checklist deixou de existir (#3723): `falta-tel`
    // em site com `wa.me` mandava a empresa ouvir que não tem telefone.
    expect(comProblemas.ganchos.some((g) => g.startsWith("Faltas concretas no site"))).toBe(false);
    expect(vocabularioDoNicho("pet shop")).toBe("clientes de pet shop");
    expect(vocabularioDoNicho("")).toBe("clientes novos");
  });

  it("frases literais das descrições de problema e do motivo do score", () => {
    expect(descreverProblema("http-503")).toBe("o site responde com erro (503)");
    expect(descreverProblema("construtor-Wix")).toBe(
      "feito em construtor pronto (Wix) — mesma cara de milhares de outros",
    );
    expect(descreverProblema("sem-atualizacao-desde-2019")).toBe("parado desde 2019");
    expect(descreverProblema("falta-tel")).toBe("sem telefone clicável");
    expect(descreverProblema("falta-xyz")).toBe("sem xyz");
    expect(descreverProblema("nao-mobile")).toBe("não abre direito no celular");
    expect(descreverProblema("codigo-que-nao-existe")).toBe("codigo-que-nao-existe");
    expect(pontuarCandidato(5, 120, "site-ok", "site", true).motivo).toBe(
      "nota alta + volume de avaliações · verificação pendente",
    );
    expect(pontuarCandidato(null, null, "site-ok").motivo).toBe("site em ordem");
  });

  it("o campo Auditoria e o bloco de estratégia do prompt seguem em português", () => {
    const dados = montarDadosDeAbordagem(
      { name: "Clínica Vitta", category: null, address: null, website: "https://vitta.test/", rating: 4.9, socials: [] },
      {
        classe: "site-ruim",
        problemas: ["nao-mobile", "http-503", "falta-tel"],
        conteudo_resumo: null,
        provisorio: false,
        verificado_em: "2026-10-10T12:00:00.000Z",
      },
    );
    // `falta-tel` do checklist não entra no campo que o agente lê (#3723).
    expect(dados["Auditoria"]).toBe(
      "Site com problemas (verificado em 10/10/2026) — não abre direito no celular; o site responde com erro (503)",
    );
    const bloco = blocoDeEstrategiaParaAgente(montarEstrategia({ ...base, classe: "fora-do-ar" }));
    expect(bloco).toContain("Cenário: Site fora do ar");
    expect(bloco).toContain("Ângulo: O site NÃO ABRE — quem clica encontra erro.");
  });

  it("saída na 2ª mensagem: a frase de só cumprimentar vem logo depois dos critérios, e a estratégia fica fora", () => {
    const estrategia = montarEstrategia({ ...base, classe: "fora-do-ar" });
    const frase =
      "Esta primeira mensagem NÃO apresenta serviço, preço nem proposta: só cumprimenta e confirma se falou com a empresa certa.";
    const comFrase = instrucaoDeAbordagemFria("Seja cordial.", "tem site", "Voz: direta.", estrategia, true);
    expect(comFrase).toContain(`Critérios a confirmar durante a conversa: tem site\n${frase}\nVoz: direta.`);
    // A estratégia é ângulo de venda: nesse modo ela não entra (doc 170 = B, spec do #3091).
    expect(comFrase).not.toContain("Estratégia de abordagem");
    expect(comFrase).toBe(instrucaoDeAbordagemFria("Seja cordial.", "tem site", "Voz: direta.", null, true));
    // Sem o modo, nada muda: a estratégia entra e a frase não.
    const semFrase = instrucaoDeAbordagemFria("Seja cordial.", "tem site", "Voz: direta.", estrategia);
    expect(semFrase).not.toContain(frase);
    expect(semFrase).toContain("Estratégia de abordagem");
  });

  it("chamar sem tradutor é o mesmo que passar a identidade, em toda a matriz", () => {
    const identidade = (texto: string) => texto;
    let casos = 0;
    for (const entrada of matriz()) {
      expect(montarEstrategia(entrada, identidade)).toEqual(montarEstrategia(entrada));
      casos++;
    }
    expect(casos).toBeGreaterThan(1000);
  });
});

describe("toda frase que a tela pode mostrar tem espanhol", () => {
  it("estratégia, problemas e motivo: cada chave pedida ao t existe em es", () => {
    const pedidas = new Set<string>();
    const gravar = (texto: string) => {
      pedidas.add(texto);
      return texto;
    };
    for (const entrada of matriz()) {
      montarEstrategia(entrada, gravar);
      for (const problema of entrada.problemas) descreverProblema(problema, gravar);
      pontuarCandidato(
        entrada.nota,
        entrada.numAvaliacoes,
        entrada.classe,
        entrada.ofertas[0],
        entrada.provisorio,
        gravar,
      );
    }
    descreverProblema("falta-xyz", gravar);
    descreverProblema("falta-mapa", gravar);
    // Controle de não-vacuidade: a matriz alcançou as objeções e os ramos.
    expect(pedidas.size).toBeGreaterThan(80);
    const semEspanhol = [...pedidas].filter((chave) => !DICIONARIO[chave]?.es);
    expect(semEspanhol).toEqual([]);
  });

  it("com o t em espanhol, nada sai em português nem com marcador sobrando", () => {
    for (const entrada of matriz()) {
      const pt = montarEstrategia(entrada);
      const es = montarEstrategia(entrada, paraEspanhol);
      for (const texto of textosDa(es)) expect(texto).not.toMatch(/\{[a-z]+\}/);
      expect(es.cenario).not.toBe(pt.cenario);
    }
    expect(descreverProblema("http-503", paraEspanhol)).toBe("el sitio responde con error (503)");
    expect(pontuarCandidato(5, 120, "site-ok", "site", true, paraEspanhol).motivo).toBe(
      "nota alta + volumen de reseñas · verificación pendiente",
    );
  });
});

describe("a tela mostra o espanhol", () => {
  it("o modal da auditoria traduz cenário, ângulo, problema e objeção", () => {
    const { container } = render(
      <AuditoriaDoSite
        site={{ classe: "site-ruim", problemas: ["nao-mobile"], checklist: { tem: [], falta: [] } }}
        nota={4.9}
        numAvaliacoes={120}
        temInstagram={false}
        ofertas={["site"]}
        nicho="clínica"
        status="new"
      />,
    );
    const texto = container.textContent ?? "";
    expect(texto).toContain("Sitio no adaptado al celular");
    expect(texto).toContain("no se ve bien en el celular");
    expect(texto).toContain("Ya tengo sitio");
    expect(texto).not.toContain("não abre direito no celular");
    expect(texto).not.toContain("O site quebra no celular");
  });
});
