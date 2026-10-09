/**
 * O CHIP DA ETIQUETA SOB A RÉGUA — o piso de TEXTO recalculado tom a tom, a
 * frente BRANCA em verde-água e vermelho, e o caminho ÚNICO de render
 * (issue #2373: "fundo escuro e texto preto, quase ilegíveis").
 *
 * ─── Por que este arquivo, já existindo `tags-cor-de-etiqueta.test.ts` ───────
 *
 * O irmão mede a PALETA contra a régua chamando a régua na mão
 * (`melhorFrenteSobre(tom)`). Medir a régua não prova o CHIP: sabotar o chip
 * (frente `#ffffff` fixa, texto herdando `text-text-muted`) deixa o irmão
 * inteiro verde e a tela continua ilegível — é o defeito que a issue descreve,
 * e ele vive no caminho de render, não na função. Aqui a frente sai de
 * `estiloDoChip` e cada tom reprova COM O PRÓPRIO NOME na mensagem.
 *
 * ─── Por que só símbolos que já existiam na `main` ──────────────────────────
 *
 * Este arquivo roda na `main` de hoje sem nenhum patch (nada importa
 * `escolheAFrente`, que é do PR). É de propósito: é o que permite a prova que
 * a issue pede — rodar ESTE arquivo contra a `main` e ver o teste de frente
 * branca VERMELHO, com os dois tons nomeados. Se o teste só existisse no patch,
 * ele provaria que o patch se sustenta, não que o defeito é real.
 *
 * Três coisas que só este arquivo segura:
 *
 *  1. **Verde-água e vermelho com TEXTO BRANCO.** O WCAG 2 escolhe preto nesses
 *     tons (6,835 e 5,433) e é exatamente essa escolha que a autora da issue vê
 *     como "quase ilegível"; o mantainer mediu o mesmo par no APCA (rascunho do
 *     WCAG 3, |Lc|), que favorece o branco (62 e 70 contra 47 e 39) — medida
 *     dele, implementação própria 0.0.98G. Como o branco só passa de 4,5 num
 *     tom mais escuro, os dois tons foram escurecidos na paleta.
 *  2. **O piso vale para QUALQUER cor gravada**, não só para a paleta:
 *     `organizations.settings.tags` é JSON editável à mão e a borda aceita
 *     qualquer `#rrggbb` de propósito. Quem tem cor fora da paleta — inclusive a
 *     da captura da issue, medida pixel a pixel — precisa do mesmo piso.
 *  3. **O caminho único de render**, por CASO ESTRUTURAL e não por lista fixa:
 *     nenhum uso do chip pode passar `style=` ou classe de cor, e
 *     `estiloDoChip` só pode ser importado pelo próprio chip. Uma tela nova que
 *     use o chip é aceita automaticamente; uma que pinte cor sozinha reprova.
 *
 * Os tons saem com nome lido do `NOME_DO_TOM` do painel (texto, não import:
 * teste de lib não importa `@/app`), para que a falha diga "Âmbar" e não só
 * `#ffb224`.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  PISO_DE_SEPARACAO_SIMULADA,
  PISOS,
  deltaESimulado,
  melhorFrenteSobre,
  razaoDeContraste,
} from "@/lib/branding/contraste";
import { deltaEOklab } from "@/lib/branding/rampa";
import { PALETA_DE_ETIQUETAS, estiloDoChip } from "@/lib/tags/cor-da-etiqueta";

const raiz = process.cwd();
/** O piso a olho nu, o dobro do de dicromacia — a mesma proporção do design system. */
const PISO_A_OLHO_NU = 0.1;

/**
 * Os cinco tons da captura da #2373, medidos no PNG (`user-attachments/
 * 4e3cf3b5…`). São os tons da paleta da v1.73.0 vistos sob outro perfil de cor
 * (o cinza `#6f6f6f` sai idêntico; a única forma de pôr cor pela tela é a
 * fileira dos 8 tons), e não cor gravada fora dela. Ficam na amostra porque o
 * piso vale para qualquer hex, inclusive esses vizinhos.
 */
const CORES_DA_CAPTURA_DA_ISSUE = ["#4b60d8", "#6f6f6f", "#1aa494", "#fcb540", "#e35537"];

/** `NOME_DO_TOM` lido como TEXTO do painel — teste de lib não importa `@/app`. */
function nomesDosTons(): Record<string, string> {
  const painel = readFileSync(join(raiz, "app/app/settings/tags/_painel.tsx"), "utf8");
  const bloco = painel.slice(painel.indexOf("const NOME_DO_TOM"));
  const mapa = bloco.slice(0, bloco.indexOf("};"));
  const saida: Record<string, string> = {};
  for (const m of mapa.matchAll(/"(#[0-9a-f]{6})":\s*"([^"]+)"/g)) saida[m[1]!] = m[2]!;
  return saida;
}

function arquivosDe(pasta: string, extensao: string): string[] {
  const saida: string[] = [];
  for (const entrada of readdirSync(pasta, { withFileTypes: true })) {
    if (entrada.name === "node_modules") continue;
    const caminho = join(pasta, entrada.name);
    if (entrada.isDirectory()) saida.push(...arquivosDe(caminho, extensao));
    else if (entrada.name.endsWith(extensao)) saida.push(caminho);
  }
  return saida;
}

/** Todo `.tsx` da UI, com o caminho relativo à raiz do repo. */
function arquivosDaUi(): string[] {
  return [...arquivosDe(join(raiz, "app"), ".tsx"), ...arquivosDe(join(raiz, "components"), ".tsx")].map(
    (c) => c.slice(raiz.length + 1),
  );
}

/** Varredura determinística de sRGB em passo 32 (9³ = 729 cores). */
function varreduraDeSrgb(): string[] {
  const passos = [0, 32, 64, 96, 128, 160, 192, 224, 255];
  const hex = (n: number) => n.toString(16).padStart(2, "0");
  const saida: string[] = [];
  for (const r of passos) for (const g of passos) for (const b of passos) saida.push(`#${hex(r)}${hex(g)}${hex(b)}`);
  return saida;
}

/** Verde-água e Vermelho: os dois tons da reprodução da issue. */
function tonsDaReproducao(nomes: Record<string, string>): string[] {
  return PALETA_DE_ETIQUETAS.filter(
    (tom) => /^verde/i.test(nomes[tom] ?? "") || /^vermelh/i.test(nomes[tom] ?? ""),
  );
}

describe("a frente do texto do chip (issue #2373)", () => {
  it("⭐ VERDE-ÁGUA E VERMELHO SÃO TEXTO BRANCO — o defeito da #2373", () => {
    // O WCAG 2 escolhe preto nesses dois tons (é o que aparece na captura) e é
    // essa escolha que a autora da issue lê como "quase ilegível"; o mantainer
    // mediu os mesmos pares no APCA (0.0.98G, medida dele) e o branco vence
    // (62 e 70 contra 47 e 39). Este teste é VERMELHO na `main` de hoje, porque
    // lá o branco fica a 3,072 e 3,866 — abaixo do piso de 4,5 — e por isso os
    // dois tons foram ESCURECIDOS na paleta até o branco passar.
    const nomes = nomesDosTons();
    const alvos = tonsDaReproducao(nomes);
    expect(
      alvos.length,
      "paleta sem tom verde/vermelho — a reprodução da issue não existe mais",
    ).toBeGreaterThanOrEqual(2);

    const fora: string[] = [];
    for (const tom of alvos) {
      const nome = nomes[tom] ?? tom;
      const frente = estiloDoChip(tom)?.color;
      const razao = razaoDeContraste(frente ?? "#000000", tom);
      if (frente !== "#ffffff") {
        fora.push(`${nome} (${tom}): chip saiu com frente ${frente ?? "ausente"}, esperado #ffffff`);
      }
      if (razao < PISOS.texto) {
        fora.push(`${nome} (${tom}): frente ${frente ?? "ausente"} dá contraste ${razao.toFixed(3)}, abaixo do piso ${PISOS.texto}`);
      }
    }
    expect(fora, `${fora.length} reproduções do defeito: ${fora.join(" | ")}`).toEqual([]);
  });

  it("⭐ cada tom tem NOME, e a frente do chip sai da régua com contraste >= 4,5", () => {
    const nomes = nomesDosTons();
    // Nome ausente = círculo mudo na fileira E falha sem nome na mensagem.
    expect(Object.keys(nomes).sort(), "NOME_DO_TOM saiu da paleta").toEqual([...PALETA_DE_ETIQUETAS].sort());

    // Acumula em vez de parar na primeira reprovação: a sabotagem precisa
    // contar TODOS os tons ruins de uma vez, pelo nome, não só o primeiro.
    const forasDoPiso: string[] = [];
    for (const tom of PALETA_DE_ETIQUETAS) {
      const nome = nomes[tom] ?? tom;
      const estilo = estiloDoChip(tom);
      const frente = estilo?.color;
      if (frente !== melhorFrenteSobre(tom)) {
        forasDoPiso.push(`${nome} (${tom}): frente ${frente ?? "ausente"} não é a da régua (${melhorFrenteSobre(tom)})`);
        continue;
      }
      const razao = razaoDeContraste(frente, tom);
      if (razao < PISOS.texto) {
        forasDoPiso.push(`${nome} (${tom}): frente ${frente} dá contraste ${razao.toFixed(3)}, abaixo do piso ${PISOS.texto}`);
      }
    }
    expect(forasDoPiso, `tons fora do piso (${forasDoPiso.length}): ${forasDoPiso.join(" | ")}`).toEqual([]);
  });

  it("⭐ verde e vermelha passam obrigatoriamente — os dois tons da reprodução", () => {
    const nomes = nomesDosTons();
    const daReproducao = tonsDaReproducao(nomes);
    expect(daReproducao.length, "paleta sem tom verde/vermelho — a reprodução da issue não existe mais").toBeGreaterThanOrEqual(2);

    const fora: string[] = [];
    for (const tom of daReproducao) {
      const nome = nomes[tom]!;
      const frente = estiloDoChip(tom)!.color!;
      const razao = razaoDeContraste(frente, tom);
      if (razao < PISOS.texto) {
        fora.push(`${nome} (${tom}): frente ${frente} dá contraste ${razao.toFixed(3)}, abaixo do piso ${PISOS.texto}`);
      }
    }
    expect(fora, `verde/vermelha fora do piso (${fora.length}): ${fora.join(" | ")}`).toEqual([]);
  });

  it("⭐ etiqueta gravada com o tom ANTIGO (#12a594/#e54d2e) também sai com frente #ffffff", () => {
    // A cor é gravada como hex em `settings.tags[].cor`, não como nome do tom:
    // quem pintou antes desta troca continua com o hex antigo no banco. Sem o
    // alias de leitura, essa etiqueta seguiria com texto preto — o chip da
    // própria autora da #2373 — até alguém escolher a cor de novo.
    const fora: string[] = [];
    for (const [antigo, novo] of [["#12a594", "#00655a"], ["#E54D2E", "#cf3716"]] as const) {
      const estilo = estiloDoChip(antigo);
      if (estilo?.backgroundColor !== novo || estilo.color !== "#ffffff") {
        fora.push(`${antigo}: fundo ${String(estilo?.backgroundColor)}, frente ${String(estilo?.color)} (esperado ${novo} + #ffffff)`);
      }
    }
    expect(fora, `etiquetas antigas sem o tom novo (${fora.length}): ${fora.join(" | ")}`).toEqual([]);
  });

  it("⭐ QUALQUER cor gravada também passa — o piso não é privilégio da paleta", () => {
    // A paleta é só a fileira da tela: o que está em `settings.tags` pode ser
    // qualquer hex, e é exatamente o caso da captura da issue. A amostra passa
    // pelo CHIP (não pela régua na mão) — sabotar o chip tem que reprovar aqui.
    const amostras = [...CORES_DA_CAPTURA_DA_ISSUE, ...varreduraDeSrgb()];
    const fora: string[] = [];
    let pior = Infinity;
    let piorCor = "";
    for (const cor of amostras) {
      const frente = estiloDoChip(cor)?.color;
      if (!frente) {
        fora.push(`${cor}: o chip não pintou frente`);
        continue;
      }
      const razao = razaoDeContraste(frente, cor);
      if (razao < pior) {
        pior = razao;
        piorCor = cor;
      }
      if (razao < PISOS.texto) fora.push(`${cor}: frente ${frente} dá contraste ${razao.toFixed(3)}`);
    }
    expect(
      fora,
      `${fora.length} de ${amostras.length} cores gravadas fora do piso (pior: ${piorCor} a ${pior.toFixed(3)}): ${fora.slice(0, 8).join(" | ")}`,
    ).toEqual([]);
    // O piso teórico de `max(branco, preto)`: 4,582671 em L (WCAG) = 0,17912.
    expect(pior, "o piso caiu abaixo do mínimo teórico — a régua deixou de escolher o melhor par").toBeGreaterThanOrEqual(4.58);
  });

  it("⭐ o pior par da paleta continua separável — recalculado, a olho nu E sob dicromacia", () => {
    let piorNormal = Infinity;
    let piorDicromacia = Infinity;
    let parNormal: [string, string] = ["", ""];
    let parDicromacia: [string, string] = ["", ""];
    for (let i = 0; i < PALETA_DE_ETIQUETAS.length; i++) {
      for (let j = i + 1; j < PALETA_DE_ETIQUETAS.length; j++) {
        const a = PALETA_DE_ETIQUETAS[i]!;
        const b = PALETA_DE_ETIQUETAS[j]!;
        const normal = deltaEOklab(a, b);
        const dicromacia = deltaESimulado(a, b);
        if (normal < piorNormal) {
          piorNormal = normal;
          parNormal = [a, b];
        }
        if (dicromacia < piorDicromacia) {
          piorDicromacia = dicromacia;
          parDicromacia = [a, b];
        }
      }
    }
    expect(
      piorNormal,
      `pior par a olho nu: ${parNormal[0]} × ${parNormal[1]} = ${piorNormal.toFixed(4)} (< ${PISO_A_OLHO_NU})`,
    ).toBeGreaterThanOrEqual(PISO_A_OLHO_NU);
    expect(
      piorDicromacia,
      `pior par sob dicromacia: ${parDicromacia[0]} × ${parDicromacia[1]} = ${piorDicromacia.toFixed(4)} (< ${PISO_DE_SEPARACAO_SIMULADA})`,
    ).toBeGreaterThanOrEqual(PISO_DE_SEPARACAO_SIMULADA);
  });
});

describe("o caminho único de render do chip", () => {
  // CASO ESTRUTURAL, não lista fixa: o levantamento de hoje (oito arquivos,
  // dez usos) fica no PR como documentação, mas um ponto novo de render é
  // aceito sem mexer no teste — o que reprova é pintar fora da régua, não
  // existir. Lista fixa aqui transformaria tela nova em ruído vermelho.
  it("nenhum uso do chip passa `style=` ou classe de cor — a frente vem da régua", () => {
    let usos = 0;
    for (const arquivo of arquivosDaUi()) {
      const texto = readFileSync(join(raiz, arquivo), "utf8");
      if (!texto.includes("<ChipDeEtiqueta")) continue;
      // `<ChipDeEtiqueta ... >` com estilo próprio sobrescreveria a frente que a
      // régua calculou — é o defeito da #2373 pela porta dos fundos.
      for (const uso of texto.match(/<ChipDeEtiqueta[^>]*>/g) ?? []) {
        usos += 1;
        expect(uso, `${arquivo} passou estilo ao chip: a frente vem da régua, não de quem o usa`).not.toContain(
          "style=",
        );
        expect(uso, `${arquivo} apagou a frente com uma classe de cor`).not.toMatch(
          /\btext-(black|white|foreground|muted)/,
        );
      }
    }
    // Varredura vazia seria um teste verde que não mede nada.
    expect(usos, "nenhum uso de <ChipDeEtiqueta> encontrado — a varredura parou de funcionar").toBeGreaterThan(0);
  });

  it("`estiloDoChip` é importado só pelo chip — ninguém mais pinta cor de etiqueta", () => {
    const importadores: string[] = [];
    for (const arquivo of arquivosDaUi()) {
      const texto = readFileSync(join(raiz, arquivo), "utf8");
      if (texto.includes("estiloDoChip")) importadores.push(arquivo);
    }
    expect(importadores.sort()).toEqual(["components/tags/ChipDeEtiqueta.tsx"]);
  });
});
