import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  DICROMACIAS,
  LIMIAR_ACROMATICO,
  PISOS,
  PISO_DE_CROMA,
  PISO_DE_SEPARACAO_DO_NEUTRO,
  PISO_DE_SEPARACAO_SIMULADA,
  ROTACAO_MAXIMA,
  deltaESimulado,
  derivarMarca,
  escolherAccent,
  extrairRegua,
  medirPares,
  melhorFrenteSobre,
  razaoDeContraste,
  reconciliarSemanticas,
  separacaoDoNeutro,
  simularDicromacia,
  superficiesDoTema,
} from "@/lib/branding/contraste";
import type { Regua, TemaDaRegua } from "@/lib/branding/contraste";
import { deltaEOklab, hexParaOklch, rampaDeSemente } from "@/lib/branding/rampa";
import type { Rampa } from "@/lib/branding/rampa";

const RAIZ = process.cwd();
const CSS = fs.readFileSync(path.join(RAIZ, "app/globals.css"), "utf8");
const REGUA: Regua = extrairRegua(CSS);

const rampaChapada = (hex: string): Rampa =>
  Array.from({ length: 11 }, () => hex) as unknown as Rampa;

/**
 * Fixture adversarial VERSIONADA. Não é amostra aleatória: cada semente foi posta aqui
 * por causar um modo de falha distinto.
 *
 *  `#0f172a`, `#1a1f36` — navy corporativa, croma baixíssimo (0,0398 e 0,0444); é onde
 *                         a ancoragem por lightness entrega outra cor ao cliente.
 *  `#f5c518`, `#f59e0b` — amarelo/âmbar: não alcançam 3:1 contra branco em NENHUM
 *                         universo, então forçam a caminhada de contraste a andar.
 *  `#ffffff`, `#000000`, `#808080`, `#fafafa` — croma zero: o caminho acromático.
 *  `#dc2626`, `#e11d48` — marca vermelha, que colide com `--color-error` sob protanopia.
 *  `#22c55e` — marca verde, que colide com `--color-success`.
 *  `#f59e0b` — marca âmbar, que colide com `--color-warning`.
 *  `#2563eb` — marca azul, que colide com `--color-info`.
 *  `#14b8a6`, `#4b0082`, `#7c3aed` — extremos de croma e de matiz, para o clamp de gamut.
 *  `#506d48` — a Sage: CONTROLE POSITIVO. Sem ela, um algoritmo que devolvesse cinza
 *              para tudo passaria em "nenhum papel abaixo do piso".
 */
const FIXTURE = [
  "#0f172a", "#f5c518", "#ffffff", "#000000", "#808080", "#dc2626", "#22c55e", "#f59e0b",
  "#2563eb", "#14b8a6", "#4b0082", "#e11d48", "#7c3aed", "#1a1f36", "#fafafa", "#506d48",
] as const;

describe("extrairRegua — os pares saem do globals.css, nunca de lista à mão", () => {
  it("acha os dois temas, a rampa do produto e os neutros", () => {
    expect(REGUA.rampaDoProduto).toHaveLength(11);
    expect(REGUA.rampaDoProduto[6]).toBe("#3b6fd4");
    expect(REGUA.claro.neutros).toHaveLength(11);
    expect(REGUA.escuro.neutros[9]).toBe("#141e30");
    expect(REGUA.claro.base.map((b) => b.chave)).toEqual([
      "--color-bg",
      "--color-surface",
      "--color-surface-elevated",
    ]);
  });

  it("alcança o anel de foco, que mora em @layer base e uma lista à mão perderia", () => {
    // Tema único agora: claro e escuro pintam o MESMO anel — `accent-600`, a própria
    // Signal Blue — e ele dá 4,06 contra bg, folgado acima do piso 3,0.
    const foco = REGUA.claro.papeis.find((p) => p.token.includes(":focus-visible"));
    expect(foco, "o anel de foco sumiu da régua").toBeDefined();
    expect(foco?.tipo).toBe("componente");
    expect(foco?.fonte).toMatchObject({ tipo: "grau", indice: 6 });

    const focoEscuro = REGUA.escuro.papeis.find((p) => p.token.includes(":focus-visible"));
    expect(focoEscuro?.fonte).toMatchObject({ tipo: "grau", indice: 6 });
  });

  it("classifica -fg como texto e -soft como superfície", () => {
    const fg = REGUA.claro.papeis.find((p) => p.token === "--color-accent-fg");
    expect(fg?.tipo).toBe("texto");
    expect(REGUA.claro.tingidas.map((t) => t.chave)).toEqual(["--color-accent-soft"]);
    // Tema único: os dois blocos usam o mesmo literal translúcido `rgba(13,27,54,0.08)`
    // — a cor cai reancorada no accent (ver `resolverSoft`), a alfa é a que sobrevive.
    // 0,08 e não 0,16 (convenção antiga): medido — em 0,16 o par accent×accent-soft
    // sobre `surface-elevated` (Oxford Blue, próxima do accent em matiz) cai a 2,87,
    // abaixo do piso 3,0.
    expect(REGUA.escuro.indices.soft).toBeNull();
    expect(REGUA.escuro.alfaDoSoft).toBeCloseTo(0.08, 6);
  });

  it("enumera o conjunto esperado de papéis e pares (guarda de vacuidade)", () => {
    // Números medidos no globals.css @ este commit. Se a folha ganhar um papel novo e
    // ninguém atualizar aqui, o teste reprova — que é o aviso certo: papel novo entra na
    // conta de contraste, não fica de fora em silêncio.
    expect(REGUA.claro.papeis.map((p) => p.token).sort()).toEqual([
      "--color-accent",
      "--color-accent-fg",
      "--color-accent-hover",
      // `--color-link`/`--color-link-hover` entraram com a superfície clara do
      // conteúdo. Eles apontam para paradas da rampa (`var(--color-accent-500)`
      // e `-400`), então a régua os extrai sozinha — e é isso que se quer: link
      // é TEXTO acionável e responde ao piso 4,5, que a accent de fundo de botão
      // não responde. A accent crua como texto dava 4,00 sobre Ink; era ela que
      // estava passando sem ninguém medir.
      "--color-link",
      "--color-link-hover",
      "--ring",
      "::selection/color",
      ":focus-visible/outline",
    ]);
    expect(REGUA.escuro.papeis).toHaveLength(8);

    // Tema único: claro agora usa o MESMO accent-soft translúcido do escuro, então as
    // duas contagens batem — 6 superfícies (3 bases + 3 composições tingidas) e 26
    // pares, em vez do 4/18 de quando o claro era opaco.
    expect(superficiesDoTema(REGUA.claro, REGUA.rampaDoProduto, 0)).toHaveLength(6);
    expect(superficiesDoTema(REGUA.escuro, REGUA.rampaDoProduto, 0)).toHaveLength(6);

    // 38 e não 26: dois papéis novos x seis superfícies = doze pares a mais.
    expect(medirPares(REGUA.claro, REGUA.rampaDoProduto, 0)).toHaveLength(38);
    expect(medirPares(REGUA.escuro, REGUA.rampaDoProduto, 0)).toHaveLength(38);
  });

  it("reproduz as razões medidas à mão no design system", () => {
    const pares = medirPares(REGUA.claro, REGUA.rampaDoProduto, 0);
    const razao = (papel: string, superficie: string) =>
      pares.find((p) => p.papel === papel && p.superficie === superficie)?.razao ?? 0;

    expect(razao("--color-accent", "--color-bg")).toBeCloseTo(4.06, 2);
    expect(razao(":focus-visible/outline", "--color-bg")).toBeCloseTo(4.06, 2);
    expect(razao(":focus-visible/outline", "--color-surface-elevated")).toBeCloseTo(3.41, 2);
  });

  it("a paleta Ink inteira, como está no CSS, cabe nos pisos", () => {
    for (const tema of [REGUA.claro, REGUA.escuro]) {
      const reprovas = medirPares(tema, REGUA.rampaDoProduto, 0).filter((p) => !p.passa);
      expect(reprovas, `${tema.nome}: ${JSON.stringify(reprovas)}`).toEqual([]);
    }
  });
});

describe("dicromacia — a régua de ângulo ordena INVERTIDO", () => {
  it("reproduz o par que derruba a régua de ângulo", () => {
    const anguloEntre = (a: string, b: string) => {
      const d = Math.abs(hexParaOklch(a).h - hexParaOklch(b).h);
      return d > 180 ? 360 - d : d;
    };
    const warning = "#b07a2b";
    const success = "#5a8a5f";

    // Oliva: ângulo GRANDE (44,7°) e separação PÉSSIMA (0,0231).
    expect(anguloEntre("#7f8c3a", warning)).toBeCloseTo(44.7, 1);
    expect(deltaESimulado("#7f8c3a", warning)).toBeCloseTo(0.0231, 4);

    // Verde-água: ângulo PEQUENO (27,2°) e separação BOA (0,1262).
    expect(anguloEntre("#1abc9c", success)).toBeCloseTo(27.2, 1);
    expect(deltaESimulado("#1abc9c", success)).toBeCloseTo(0.1262, 4);

    // A inversão, dita como asserção: quem tem mais ângulo tem menos separação real.
    expect(anguloEntre("#7f8c3a", warning)).toBeGreaterThan(anguloEntre("#1abc9c", success));
    expect(deltaESimulado("#7f8c3a", warning)).toBeLessThan(deltaESimulado("#1abc9c", success));
  });

  it("a simulação de fato colapsa o eixo vermelho-verde", () => {
    // Controle positivo da matriz. O par é construído com a MESMA lightness OKLab
    // (L=0,60, C=0,12, h=25° e h=145°): dicromacia preserva luminosidade, então um par
    // vermelho/verde de luminosidades diferentes continuaria distinguível pelo brilho e
    // o teste mediria a coisa errada — foi o que aconteceu com `#c0392b`×`#27ae60`, que
    // só cai 22% sob protanopia porque o vermelho já era mais escuro.
    const vermelho = "#bd615b";
    const verde = "#4d9351";
    const cru = deltaEOklab(vermelho, verde);
    expect(cru).toBeGreaterThan(0.2);
    for (const tipo of DICROMACIAS) {
      const simulado = deltaEOklab(simularDicromacia(vermelho, tipo), simularDicromacia(verde, tipo));
      expect(simulado, tipo).toBeLessThan(cru * 0.5);
    }
    // Sob deuteranopia o colapso é quase total — 0,0076 contra 0,2080 crus. Matriz
    // identidade (a sabotagem óbvia) devolveria 0,2080 e reprovaria aqui.
    expect(
      deltaEOklab(simularDicromacia(vermelho, "deuteranopia"), simularDicromacia(verde, "deuteranopia")),
    ).toBeLessThan(cru * 0.1);
    // E NÃO colapsa o eixo azul-amarelo, que a dicromacia vermelho-verde preserva: uma
    // matriz que zerasse tudo também passaria no teste acima.
    expect(deltaESimulado("#2563eb", "#f5c518")).toBeGreaterThan(deltaEOklab("#2563eb", "#f5c518") * 0.85);
  });

  it("usa o PIOR caso entre as dicromacias, não a média", () => {
    // `#a94a3c` × `#506d48` mede 0,0505 sob deuteranopia e 0,0434 sob protanopia. Média
    // daria 0,047 e a decisão mudaria; o piso existe para a pessoa que enxerga pior.
    const alvo = deltaESimulado("#a94a3c", "#506d48");
    const porTipo = DICROMACIAS.map((t) =>
      deltaEOklab(simularDicromacia("#a94a3c", t), simularDicromacia("#506d48", t)),
    );
    expect(alvo).toBeCloseTo(Math.min(...porTipo), 10);
    expect(Math.max(...porTipo)).toBeGreaterThan(alvo);
  });
});

describe("derivarMarca — as 16 sementes adversariais", () => {
  const resultados = FIXTURE.map((s) => ({ semente: s, marca: derivarMarca(s, REGUA) }));

  it("a fixture tem o tamanho e o controle positivo que declara", () => {
    expect(FIXTURE).toHaveLength(16);
    expect(new Set(FIXTURE).size).toBe(16);
    expect(FIXTURE).toContain("#506d48");
  });

  it("nenhum papel fica abaixo do piso, em nenhum dos dois temas", () => {
    for (const { semente, marca } of resultados) {
      for (const tema of [marca.claro, marca.escuro] as const) {
        // Guarda de vacuidade POR SEMENTE: um `pares: []` faria o filtro abaixo devolver
        // lista vazia e o teste passar sem ter medido nada.
        expect(tema.pares.length, `${semente}: nenhum par medido`).toBeGreaterThanOrEqual(18);
        const reprovas = tema.pares.filter((p) => !p.passa);
        expect(
          reprovas,
          `${semente} · grau ${tema.grauDoAccent}: ` +
            reprovas.map((r) => `${r.papel}×${r.superficie}=${r.razao.toFixed(2)}<${r.piso}`).join(", "),
        ).toEqual([]);
      }
    }
  });

  it("a caminhada de contraste de fato ANDA — e nas sementes previstas", () => {
    // Guarda contra o teste vácuo: se nada deslocasse no run inteiro, "todos os papéis
    // passam" seria uma afirmação sobre uma caminhada que nunca aconteceu.
    const deslocados = resultados.flatMap(({ semente, marca }) =>
      [marca.claro, marca.escuro]
        .filter((t) => t.deslocamento !== 0)
        .map((t) => `${semente}/${t.deslocamento}`),
    );
    expect(deslocados.length).toBeGreaterThan(0);
    // Tema único: claro e escuro têm a MESMA régua agora, então toda semente que anda
    // num tema anda IGUAL no outro — o total dobrou de propósito (13 → 20, os casos que
    // antes só precisavam andar num tema, ou já ficaram assimétricos, agora somam nos
    // dois; nem toda semente colide, por isso não é exatamente 2×13).
    expect(deslocados).toHaveLength(20);

    // O amarelo é o caso que NÃO tem escapatória física: nenhum stop de amarelo alcança
    // 3:1 contra o fundo Ink. Se ele parar de andar, a caminhada quebrou. Com os dois
    // temas iguais, ele anda IGUAL nos dois agora — não sobra mais um tema "folgado" em
    // que o hex do cliente sobrevive intacto.
    const amarelo = resultados.find((r) => r.semente === "#f5c518")!.marca;
    expect(amarelo.claro.deslocamento).toBeGreaterThan(0);
    expect(amarelo.claro.grauDoAccent).toBe(800);
    expect(amarelo.escuro.deslocamento).toBeGreaterThan(0);
    expect(amarelo.escuro.grauDoAccent).toBe(800);
    expect(amarelo.escuro.accent).not.toBe("#f5c518");
  });

  it("nunca torce o accent: ele é sempre um stop da rampa da marca", () => {
    // (c) da doutrina: o accent é a única cor que não nos pertence. Se algum caminho
    // "ajustasse" o accent para folgar de uma semântica, este teste pega.
    for (const { semente, marca } of resultados) {
      if (marca.origemDaRampa !== "semente") continue;
      const rampa = rampaDeSemente(semente);
      expect(rampa, `${semente}`).toContain(marca.claro.accent);
      expect(rampa, `${semente}`).toContain(marca.escuro.accent);
      expect(marca.marca).toBe(semente);
    }
  });

  it("emite motivo sempre que mexe em alguma coisa, e nunca vaza o hex da marca", () => {
    for (const { semente, marca } of resultados) {
      const codigos = marca.motivos.map((m) => m.codigo);
      const mexeu =
        marca.claro.deslocamento !== 0 ||
        marca.escuro.deslocamento !== 0 ||
        marca.origemDaRampa === "produto";
      if (mexeu) expect(codigos.length, semente).toBeGreaterThan(0);
      // Diagnóstico emite FORMA, nunca IDENTIDADE: este objeto vai para log, e a cor da
      // marca de uma empresa não tem por que aparecer no log de outra.
      for (const m of marca.motivos) {
        expect(m.detalhe.toLowerCase(), `${semente} · ${m.codigo}`).not.toContain(
          semente.replace("#", ""),
        );
      }
    }
  });

  it("--color-accent-fg é calculado, e muda de lado conforme o accent", () => {
    // ATENÇÃO à vacuidade aqui, e ela é real: nas 16 sementes o tema claro SEMPRE cai em
    // branco e o escuro SEMPRE em preto — não porque o valor seja fixo por tema, mas
    // porque a caminhada de contraste empurra o accent claro para longe das superfícies
    // claras e o escuro para longe das escuras. Contar dois valores distintos no run,
    // portanto, NÃO prova que o cálculo responde ao accent; prova só que os temas
    // diferem. Quem prova a responsividade é o bloco abaixo, sobre a função direta.
    expect(melhorFrenteSobre("#f5c518")).toBe("#000000"); // amarelo vivo → texto preto
    expect(melhorFrenteSobre("#0f172a")).toBe("#ffffff"); // navy → texto branco
    // O par crítico: dois stops ADJACENTES da MESMA rampa Sage que pedem frentes
    // opostas. `#506d48` (600) dá 5,80 com branco e 3,62 com preto; `#67885d` (500) dá
    // 4,00 com branco e 5,25 com preto. Um valor fixo por tema erraria um dos dois — e
    // um deslocamento de UM grau é exatamente o que a caminhada de contraste faz.
    expect(melhorFrenteSobre("#506d48")).toBe("#ffffff");
    expect(melhorFrenteSobre("#67885d")).toBe("#000000");

    for (const { semente, marca } of resultados) {
      for (const tema of [marca.claro, marca.escuro] as const) {
        expect(razaoDeContraste(tema.accentFg, tema.accent), semente).toBeGreaterThanOrEqual(
          PISOS.texto,
        );
        expect(tema.accentFg).toBe(melhorFrenteSobre(tema.accent));
      }
    }
  });

  it("--color-accent-soft é derivado, não o azul Signal cru", () => {
    // O literal `rgba(13, 27, 54, 0.08)` sobreviveria intacto a qualquer override da
    // rampa — seria um pedaço da NOSSA marca dentro da instalação do cliente.
    const roxo = derivarMarca("#7c3aed", REGUA);
    expect(roxo.escuro.accentSoft).toMatch(/^rgba\(\d+, \d+, \d+, 0\.08\)$/);
    expect(roxo.escuro.accentSoft).not.toContain("13, 27, 54");
    // Tema único: claro agora TAMBÉM é translúcido, como o escuro (globals.css declara
    // o mesmo literal `rgba(...)` nos dois blocos).
    expect(roxo.claro.accentSoft).toMatch(/^rgba\(\d+, \d+, \d+, 0\.08\)$/);
    expect(roxo.claro.accentSoft).not.toContain("13, 27, 54");
  });
});

describe("reconciliação — quem se move são as NOSSAS semânticas", () => {
  it("a Sage, agora só uma marca de CLIENTE, colide com --color-error e dispara a reconciliação", () => {
    // Com o produto na paleta Ink, `--color-success` (#82a077) NÃO é mais igual a nenhum
    // stop do accent (que agora é azul) — a Sage não colide mais consigo mesma. O
    // controle positivo passou a ser outra sobreposição real: um CLIENTE que cola a
    // Sage como marca cai, depois da caminhada de contraste, num verde (`#67885d`,
    // deslocamento -1 nos dois temas — iguais agora) próximo o bastante de
    // `--color-error` (#c87263) sob dicromacia para disparar o mecanismo.
    const sage = derivarMarca("#506d48", REGUA);
    expect(sage.claro.accent).toBe("#67885d");
    expect(sage.escuro.accent).toBe("#67885d");
    // A superficie clara tem deslocamento PROPRIO, e aqui ele e ZERO enquanto os
    // dois temas andam -1. Ou seja: as duas contas discordam, que e exatamente a
    // razao de existirem separadas. Enquanto a superficie clara herdava o offset
    // do escuro, esta marca chegava a Paper como #41573b -- escurecida por uma
    // conta feita contra Ink, sem que nada em Paper pedisse isso.
    //
    // O que faz o zero caber e o `--color-accent-hover` da superficie clara
    // apontar para accent-700 (ver o bloco no globals.css): sem ele o par
    // hover x surface-elevated dava 2,95 e empurrava TODA marca um passo,
    // inclusive a nossa.
    expect(sage.superficieClara.deslocamento).toBe(0);
    expect(sage.superficieClara.accent).toBe("#506d48"); // o hex que a pessoa escolheu
    expect(sage.claro.deslocamento).toBe(-1);
    expect(sage.escuro.deslocamento).toBe(-1);

    const movidas = sage.motivos.filter((m) => m.codigo === "semantica_deslocada");
    expect(movidas.length).toBeGreaterThan(0);
    expect(movidas).toHaveLength(3);
    // Em Paper quem colide com o verde da marca e `--color-success` (verde
    // tambem), e nao o `--color-error` que colide nos dois temas escuros: a
    // superficie muda quais das NOSSAS semanticas ficam perto demais.
    expect(movidas.map((m) => `${m.tema}/${m.alvo}`)).toEqual([
      "claro/error",
      "escuro/error",
      "superficie-clara/success",
    ]);
  });

  it("devolve sinal — e não distorção — quando não há rotação que resolva", () => {
    // O laço de retorno do invariante 7 da doutrina Sistema Vivo: a peça diz o que muda
    // no sistema quando ela não consegue resolver. Com o produto na paleta Ink nenhuma
    // das 16 sementes adversariais produz mais esse caso organicamente (a Sage não
    // colide mais consigo mesma — teste acima), então este teste chama
    // `reconciliarSemanticas` DIRETO com um par construído para não ter saída: `success`
    // começa idêntico ao accent (Δ 0) e `info` fica a 65° de distância — perto o
    // bastante para que TODA rotação de `success` dentro do orçamento de 60° também
    // colida com `info`. `info65graus` saiu de varredura (5° em 5° até 90°), não chute.
    const accent = "#3b6fd4";
    const info65graus = "#a54aa6";
    const r = reconciliarSemanticas(accent, [
      { nome: "success", hex: accent },
      { nome: "info", hex: info65graus },
    ]);
    expect(r.semSaida).toHaveLength(1);
    expect(r.semSaida[0]).toMatchObject({ nome: "success", separacao: 0 });
  });

  it("não inventa rotação impossível numa semântica sem croma", () => {
    // Girar o matiz de uma cor de croma zero não muda nada — é o caso em que a rotação
    // NÃO PODE funcionar, e o algoritmo tem de dizer isso em vez de fingir.
    const r = reconciliarSemanticas("#808080", [
      { nome: "success", hex: "#7f7f7f" },
      { nome: "warning", hex: "#b07a2b" },
    ]);
    expect(r.semSaida.map((s) => s.nome)).toEqual(["success"]);
    expect(r.movimentos).toEqual([]);
    expect(r.cores.success).toBe("#7f7f7f");
  });

  it("toda semântica movida folga do accent e continua dentro do orçamento de rotação", () => {
    let movimentosNoRun = 0;
    for (const semente of FIXTURE) {
      const marca = derivarMarca(semente, REGUA);
      for (const [tema, regua] of [
        [marca.claro, REGUA.claro],
        [marca.escuro, REGUA.escuro],
      ] as const) {
        const r = reconciliarSemanticas(tema.accent, regua.semanticas);
        movimentosNoRun += r.movimentos.length;
        for (const m of r.movimentos) {
          expect(Math.abs(m.rotacao), `${semente} ${m.nome}`).toBeLessThanOrEqual(ROTACAO_MAXIMA);
          expect(m.separacaoDepois).toBeGreaterThanOrEqual(PISO_DE_SEPARACAO_SIMULADA);
          expect(m.separacaoDepois).toBeGreaterThan(m.separacaoAntes);
          expect(m.para).not.toBe(m.de);
        }
        // O que NÃO se moveu já folgava — senão teria virado `semSaida`.
        for (const s of regua.semanticas) {
          const moveu = r.movimentos.some((m) => m.nome === s.nome);
          const semSaida = r.semSaida.some((x) => x.nome === s.nome);
          if (!moveu && !semSaida) {
            expect(deltaESimulado(s.hex, tema.accent), `${semente} ${s.nome}`).toBeGreaterThanOrEqual(
              PISO_DE_SEPARACAO_SIMULADA,
            );
          }
        }
      }
    }
    // Guarda de vacuidade do run inteiro: 4 movimentos medidos nas 16 sementes contra a
    // paleta Ink (o accent azul colide MENOS com as semânticas do que a Sage colidia).
    expect(movimentosNoRun).toBe(4);
  });
});

describe("marca acromática — o accent do produto permanece", () => {
  const CINZAS = ["#808080", "#000000", "#ffffff", "#fafafa"] as const;

  it("cinza, preto e branco não viram accent", () => {
    for (const cinza of CINZAS) {
      const marca = derivarMarca(cinza, REGUA);
      expect(hexParaOklch(cinza).C, cinza).toBeLessThan(LIMIAR_ACROMATICO);
      expect(marca.origemDaRampa, cinza).toBe("produto");
      expect(marca.rampa).toEqual(REGUA.rampaDoProduto);
      // O hex do cliente NÃO some: vai para `--color-brand` (logo, selo, e-mail).
      expect(marca.marca).toBe(cinza);
      const motivo = marca.motivos.find((m) => m.codigo === "marca_acromatica");
      expect(motivo?.alvo, cinza).toBe("--color-brand");
    }
  });

  it("o accent que permanece é cromático e separável do neutro do mesmo grau", () => {
    const marca = derivarMarca("#808080", REGUA);
    for (const [tema, regua] of [
      [marca.claro, REGUA.claro],
      [marca.escuro, REGUA.escuro],
    ] as const) {
      expect(hexParaOklch(tema.accent).C).toBeGreaterThanOrEqual(PISO_DE_CROMA);
      expect(
        separacaoDoNeutro(regua, tema.grauDoAccent, tema.accent),
      ).toBeGreaterThanOrEqual(PISO_DE_SEPARACAO_DO_NEUTRO);
    }
    // Número exato, fixado: 0,3261 nos dois temas (accent-600 × neutral-600) — tema único
    // agora, então claro e escuro medem o mesmo par. Bem acima do piso 0,05: o accent azul
    // e o neutro azul-Oxford do mesmo grau são bem mais separados do que Sage×greige eram.
    expect(separacaoDoNeutro(REGUA.claro, marca.claro.grauDoAccent, marca.claro.accent)).toBeCloseTo(0.3261, 4);
    expect(separacaoDoNeutro(REGUA.escuro, marca.escuro.grauDoAccent, marca.escuro.accent)).toBeCloseTo(0.3261, 4);

    // Controle negativo: um accent cinza reprovaria as duas guardas. Sem esta linha, os
    // pisos acima poderiam ser satisfeitos por qualquer coisa.
    expect(hexParaOklch("#5d594f").C).toBeLessThan(PISO_DE_CROMA);
    expect(deltaEOklab("#5d594f", "#5d594f")).toBe(0);
  });

  it("navy NÃO é acromática — o gatilho não decide no quarto decimal", () => {
    // As duas navies da fixture ficam em lados OPOSTOS de `PISO_DE_CROMA` por 0,0046:
    // `#0f172a` mede 0,039824 e `#1a1f36` mede 0,044430. Um gatilho ali decidiria no
    // quarto decimal se a navy mais comum do mundo corporativo pinta a interface — e a
    // resposta mudaria com um arredondamento de hex. Esta asserção fixa o straddle: é o
    // que reprova se alguém "simplificar" reusando `PISO_DE_CROMA` como gatilho.
    expect(hexParaOklch("#0f172a").C).toBeLessThan(PISO_DE_CROMA);
    expect(hexParaOklch("#1a1f36").C).toBeGreaterThan(PISO_DE_CROMA);
    expect(Math.abs(hexParaOklch("#0f172a").C - hexParaOklch("#1a1f36").C)).toBeLessThan(0.005);

    for (const navy of ["#0f172a", "#1a1f36"] as const) {
      const marca = derivarMarca(navy, REGUA);
      expect(hexParaOklch(navy).C, navy).toBeGreaterThan(LIMIAR_ACROMATICO);
      expect(marca.origemDaRampa, navy).toBe("semente");
      // Tema único: navy (muito escura) não tem mais um tema "claro" folgado onde
      // sobrevive literal — os dois temas são o mesmo fundo escuro agora, e a navy
      // precisa andar nos dois. O que continua garantido (e é o que este teste
      // realmente prova) é que o resultado nunca sai da rampa DA PRÓPRIA marca.
      expect(rampaDeSemente(navy), navy).toContain(marca.claro.accent);
    }
  });
});

describe("ramo degradado — rampas que não têm solução", () => {
  const SINTETICAS: readonly (readonly [string, Rampa])[] = [
    // L uniforme: andar na rampa não muda contraste nenhum, então nenhum deslocamento
    // pode ajudar — é o caso em que a caminhada tem de desistir e DIZER que desistiu.
    ["L uniforme", rampaChapada("#7f7f7f")],
    ["toda clara", rampaChapada("#f2f2f2")],
    ["toda escura", rampaChapada("#101010")],
  ];

  it("alcança o caminho de fallback nos dois temas, para as três rampas", () => {
    const alcancados: string[] = [];
    for (const [nome, rampa] of SINTETICAS) {
      for (const tema of [REGUA.claro, REGUA.escuro]) {
        const escolha = escolherAccent(rampa, tema);
        expect(escolha.motivo, `${nome}/${tema.nome}`).toBe("sem_deslocamento_que_satisfaz");
        expect(escolha.reprovas.length).toBeGreaterThan(0);
        expect(escolha.pares.length).toBeGreaterThan(0);
        // Degradado NÃO é lançar: `derivarMarca` roda no caminho de render do layout, e
        // um throw ali é 500 em todas as telas.
        expect(() => escolherAccent(rampa, tema)).not.toThrow();
        alcancados.push(`${nome}/${tema.nome}`);
      }
    }
    expect(alcancados).toHaveLength(6);
  });

  it("uma rampa chapada não tem contraste interno nem com deslocamento", () => {
    // Controle positivo do ramo: o par `::selection` mede stop contra stop DENTRO da
    // rampa. Numa rampa de cor única ele vale 1,00 em qualquer deslocamento — é a prova
    // de que a reprova é estrutural e não um deslocamento mal escolhido.
    const escolha = escolherAccent(rampaChapada("#7f7f7f"), REGUA.claro);
    const selecao = escolha.pares.find((p) => p.papel.includes("::selection"));
    expect(selecao?.razao).toBeCloseTo(1, 6);
    expect(selecao?.passa).toBe(false);
  });

  it("uma rampa boa NÃO cai no ramo degradado", () => {
    // Sem este controle negativo, "o ramo é alcançável" não distinguiria um algoritmo
    // que sempre degrada.
    for (const tema of [REGUA.claro, REGUA.escuro] as TemaDaRegua[]) {
      expect(escolherAccent(REGUA.rampaDoProduto, tema).motivo).toBeNull();
    }
  });
});
