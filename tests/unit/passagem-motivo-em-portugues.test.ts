import { readFileSync, readdirSync } from "node:fs";
import { join, relative, win32 } from "node:path";

import { describe, expect, it } from "vitest";

import { DICIONARIO } from "@/lib/i18n/dicionario";
import {
  FRASE_DO_MOTIVO,
  FRASE_DO_MOTIVO_DO_AVISO,
  MOTIVOS_DA_PASSAGEM,
  MOTIVOS_DO_AVISO,
} from "@/lib/escalacao/passagem";

/**
 * O MOTIVO DA PASSAGEM CHEGA À TELA EM PORTUGUÊS — O CÓDIGO DO BANCO NÃO.
 *
 * ═══ O defeito que este arquivo fecha ANTES de ele existir ═══
 *
 * `requested_human`, `low_sentiment`, `critical_stage` são vocabulário de
 * CONSTRAINT: existem para o banco recusar lixo, e não para uma pessoa ler.
 * Medido antes desta entrega, sobre o repositório inteiro:
 *
 *     $ grep -rnE "requested_human|low_sentiment|suspected_optout" app components hooks
 *     (zero linhas)
 *
 * Zero não é "está resolvido" — é "ninguém traduzia, porque ninguém mostrava".
 * A onda que desenha o cartão da passagem vai mostrar, e o caminho mais curto
 * para ela é `{passagem.motivo_codigo}` dentro de um `<span>`. Esta catraca
 * existe para que esse caminho fique VERMELHO no CI, e não para que alguém se
 * lembre da regra.
 *
 * ═══ Por que a cobertura é cobrada pelo COMPILADOR, e o resto aqui ═══
 *
 * `satisfies Record<MotivoDaPassagem, string>` faz o `typecheck` reprovar a
 * entrada que faltar — é o gate mais barato e o mais cedo. O que o compilador
 * NÃO enxerga, e por isso é medido aqui:
 *
 *   · o espanhol (o dicionário é um `Record<string, …>`, então uma chave
 *     ausente é indistinguível de uma chave qualquer);
 *   · o código cru que vaze para `app/` ou `components/`;
 *   · a frase vazia, que satisfaz o tipo e não diz nada a ninguém.
 */

const RAIZ = join(__dirname, "..", "..");

/**
 * O caminho que a varredura entrega AO COMPARAR, sempre com `/`.
 *
 * `relative` devolve o caminho no dialeto do SO: no Linux é
 * `components/connections/ChannelAiAccess.tsx`, no Windows é
 * `components\connections\ChannelAiAccess.tsx`. Os literais de
 * `USO_COMO_CHAVE` são escritos com `/`, então o par cru só casa por acaso no
 * Linux — na Windows `liberados.has(par)` dá falso, o uso legítimo é acusado
 * como vazamento e este arquivo reprova por um motivo que não existe. É a
 * COMPARAÇÃO que se normaliza; a allowlist continua escrita do jeito que a
 * leitora do repo escreve caminho.
 */
function separadorPosix(relativo: string): string {
  return relativo.replaceAll("\\", "/");
}

/**
 * Onde o código APARECE legitimamente, e por quê.
 *
 * Medido ao escrever este arquivo, não previsto: `pre_go_live` já era
 * vocabulário vivo de OUTRA coluna — `channel_ai_access.mode`, o modo de teste
 * do canal — e a tela o usa como CHAVE de comparação, exibindo `t("IA em modo
 * de teste")`. É o mesmo conceito nas duas pontas (o número em aquecimento não
 * manda mensagem, e é por isso que o cliente não foi avisado), então o literal
 * compartilhado é acerto, não colisão.
 *
 * A lista é por PAR arquivo→código, e um caso abaixo cobra que toda entrada
 * ainda seja verdadeira: allowlist que sobrevive ao arquivo que a motivou é
 * allowlist que cresce sozinha.
 */
const USO_COMO_CHAVE: Array<{ arquivo: string; codigo: string; razao: string }> = [
  {
    arquivo: "components/connections/ChannelAiAccess.tsx",
    codigo: "pre_go_live",
    razao:
      "`channel_ai_access.mode` — comparação, não exibição: a tela mostra t(\"IA em modo de teste\")",
  },
  // `orcamento_de_ia` é o caso OPOSTO ao de `pre_go_live` acima: lá o literal é
  // o MESMO conceito nas duas pontas; aqui é colisão de verdade. Na passagem ele
  // é o MOTIVO ("o limite de gasto com IA foi atingido"). No comportamento da
  // instalação (bb11d0584, "installation behaviour gets a screen") ele é o NOME
  // de um campo de configuração que vale `on | avisar | off`. Nenhum dos dois
  // arquivos abaixo exibe motivo de passagem — os dois usam o literal como CHAVE
  // de formulário. O guarda casava a string, não o papel; ele reprovou a main na
  // árvore mesclada do #1180 sem que nenhum dos dois lados tivesse errado.
  {
    arquivo: "app/actions/settings/updateComportamento.ts",
    codigo: "orcamento_de_ia",
    razao:
      "chave do schema Zod do comportamento da instalação (`z.enum([\"on\",\"avisar\",\"off\"])`) — outro conceito, não o motivo da passagem",
  },
  {
    arquivo: "app/admin/(protected)/sistema/_form.tsx",
    codigo: "orcamento_de_ia",
    razao:
      "chave do campo no formulário de comportamento da instalação (`trocar(\"orcamento_de_ia\", …)`) — outro conceito, não o motivo da passagem",
  },
];

/** Os arquivos de tela, onde um código cru vira texto no rosto de quem opera. */
function arquivosDeTela(): string[] {
  const achados: string[] = [];
  const visitar = (dir: string): void => {
    for (const entrada of readdirSync(dir, { withFileTypes: true })) {
      const caminho = join(dir, entrada.name);
      if (entrada.isDirectory()) {
        if (entrada.name === "node_modules" || entrada.name === "api") continue;
        visitar(caminho);
        continue;
      }
      if (/\.tsx?$/.test(entrada.name) && !/\.test\.tsx?$/.test(entrada.name)) achados.push(caminho);
    }
  };
  for (const pasta of ["app", "components", "hooks"]) visitar(join(RAIZ, pasta));
  return achados;
}

describe("o motivo da passagem tem frase em português", () => {
  it("CONTROLE DE VACUIDADE: os dois vocabulários não estão vazios", () => {
    // Uma tupla esvaziada faria todos os `for` abaixo passarem sem medir nada —
    // o verde vácuo que este repo já pagou várias vezes.
    expect(MOTIVOS_DA_PASSAGEM.length).toBeGreaterThanOrEqual(9);
    expect(MOTIVOS_DO_AVISO.length).toBeGreaterThanOrEqual(6);
  });

  it("todo motivo tem frase, e nenhuma frase é vazia nem o próprio código", () => {
    for (const motivo of MOTIVOS_DA_PASSAGEM) {
      const frase = FRASE_DO_MOTIVO[motivo];
      expect(frase, `motivo sem frase: ${motivo}`).toBeTruthy();
      expect(frase.trim().length, `frase vazia para ${motivo}`).toBeGreaterThan(10);
      // "requested_human" como frase satisfaria o tipo e não traduziria nada.
      expect(frase).not.toContain(motivo);
      expect(frase).not.toMatch(/_/u);
    }
  });

  it("todo motivo de AVISO tem frase — é o que a tela diz quando o cliente não foi avisado", () => {
    // O vocabulário do aviso é fechado no CHECK justamente para a tela poder
    // traduzir. Um `aviso_motivo_codigo` sem frase vira "na_fila_canal_fora" na
    // linha que explica a uma pessoa por que o cliente está no escuro.
    for (const motivo of MOTIVOS_DO_AVISO) {
      const frase = FRASE_DO_MOTIVO_DO_AVISO[motivo];
      expect(frase, `motivo de aviso sem frase: ${motivo}`).toBeTruthy();
      expect(frase).not.toContain(motivo);
      expect(frase).not.toMatch(/_/u);
    }
  });

  it("toda frase tem par em espanhol — a chave É o texto em português", () => {
    // `tests/unit/i18n-espanhol-cobre-a-tela.test.ts` só cobra chave que JÁ é
    // usada por uma tela. O cartão nasce na onda seguinte; sem este caso, as
    // frases entrariam sem espanhol e o gate de lá só acusaria depois, no PR da
    // tela — longe de quem escreveu a frase.
    const semEspanhol = [
      ...Object.values(FRASE_DO_MOTIVO),
      ...Object.values(FRASE_DO_MOTIVO_DO_AVISO),
    ].filter((frase) => DICIONARIO[frase]?.es === undefined);
    expect(
      semEspanhol,
      "estas frases da passagem não têm entrada `es` em lib/i18n/dicionario.ts",
    ).toEqual([]);
  });

  it("CONTROLE DE PLATAFORMA: o par arquivo→código é o mesmo no Windows e no Linux", () => {
    // O mesmo controle do outro arquivo da issue, pelo motivo do mesmo defeito:
    // `relative` devolve o caminho no dialeto do SO, e o par é comparado com
    // literais escritos com `/`. A comparação acontece em `liberados.has(par)`, e
    // um par que não casa vira FALSO VAZAMENTO — o caso reprova acusando código
    // cru em tela onde o uso é legítimo. `win32.relative` monta o formato do
    // Windows aqui, no CI do Linux, para que isso seja medido e não suposto.
    const raizWindows = "C:\\deskcomm";
    const raizLinux = "/srv/deskcomm";
    const esperado = "components/connections/ChannelAiAccess.tsx";

    const parWindows = separadorPosix(
      win32.relative(raizWindows, win32.join(raizWindows, "components", "connections", "ChannelAiAccess.tsx")),
    );
    const parLinux = separadorPosix(
      relative(raizLinux, join(raizLinux, "components", "connections", "ChannelAiAccess.tsx")),
    );

    const liberados = new Set(USO_COMO_CHAVE.map((u) => `${u.arquivo} → ${u.codigo}`));
    expect(parWindows, "o par do Windows precisa casar com o literal da allowlist").toBe(esperado);
    expect(parLinux, "o par do Linux não pode ter mudado de forma").toBe(esperado);
    expect(
      liberados.has(`${parWindows} → pre_go_live`),
      "o uso legítimo tem de ser liberado com o par do Windows",
    ).toBe(true);
    expect(
      liberados.has(`${parLinux} → pre_go_live`),
      "o uso legítimo tem de ser liberado com o par do Linux",
    ).toBe(true);
    // NEGATIVO: sem normalizar, o par do Windows não entraria na allowlist e o
    // caso acima acusaria vazamento falso.
    expect(
      win32.relative(raizWindows, win32.join(raizWindows, "components", "connections", "ChannelAiAccess.tsx")),
      "controle negativo: se isto casasse, a normalização seria inútil e o defeito voltaria",
    ).not.toBe(esperado);
  });

  it("nenhum código cru do vocabulário aparece em `app/`, `components/` ou `hooks/`", () => {
    const arquivos = arquivosDeTela();
    // Sem esta guarda, um erro de caminho devolveria lista vazia e o caso
    // passaria afirmando que nada vaza sobre zero arquivo lido.
    expect(arquivos.length, "a varredura não leu arquivo nenhum de tela").toBeGreaterThan(100);

    const codigos = [...MOTIVOS_DA_PASSAGEM, ...MOTIVOS_DO_AVISO];
    const liberados = new Set(USO_COMO_CHAVE.map((u) => `${u.arquivo} → ${u.codigo}`));
    const vazamentos: string[] = [];
    for (const arquivo of arquivos) {
      const fonte = readFileSync(arquivo, "utf8");
      for (const codigo of codigos) {
        // Fronteira de palavra: `caso_escalado` não pode casar dentro de
        // `caso_escalado_em`, e `sem_telefone` não pode casar num nome de
        // variável que contenha o trecho.
        if (!new RegExp(`\\b${codigo}\\b`, "u").test(fonte)) continue;
        const par = `${separadorPosix(relative(RAIZ, arquivo))} → ${codigo}`;
        if (!liberados.has(par)) vazamentos.push(par);
      }
    }
    expect(
      vazamentos,
      "Código de vocabulário do banco dentro de uma tela. Ele existe para a " +
        "constraint recusar lixo, não para alguém ler: use `t(FRASE_DO_MOTIVO[codigo])`. " +
        "Se a tela precisa do código como CHAVE (data-testid, filtro), escreva o porquê " +
        "ao lado e traga o caso para cá.",
    ).toEqual([]);
  });

  it("a allowlist não sobrevive ao arquivo que a motivou", () => {
    // Allowlist que continua verde depois de o uso sumir é allowlist que só
    // cresce: a próxima pessoa acrescenta a dela, ninguém tira a velha, e um dia
    // o gate libera um vazamento de verdade porque o par já estava escrito.
    const mortas = USO_COMO_CHAVE.filter((u) => {
      let fonte: string;
      try {
        fonte = readFileSync(join(RAIZ, u.arquivo), "utf8");
      } catch {
        return true;
      }
      return !new RegExp(`\\b${u.codigo}\\b`, "u").test(fonte);
    }).map((u) => `${u.arquivo} → ${u.codigo}`);
    expect(mortas, "entrada de USO_COMO_CHAVE que não corresponde mais a nada — apague").toEqual([]);
  });
});
