import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

/**
 * Gate contra a classe de defeito mais silenciosa da documentação: a afirmação
 * que envelheceu sem ninguém voltar.
 *
 * Ela tem duas formas, e as duas foram medidas neste repo em 2026-08-14:
 *
 * 1. **Ponteiro para o vazio.** `CLAUDE.md` e `AGENTS.md` mandavam procurar o job
 *    `imagens-ok` em `.github/workflows/imagens.yml` — arquivo que nunca existiu;
 *    o job vive em `publish-image.yml`. Um path citado em documento de autoridade
 *    se lê como prova, e quem o segue conclui que a coisa não existe.
 *
 * 2. **Nota de pendência que sobreviveu à pendência.** O mesmo parágrafo da
 *    doutrina de packaging mentiu DUAS vezes sobre o mesmo fato, em sentidos
 *    opostos: primeiro afirmou no presente que `imagens-ok` era obrigatório
 *    quando não era; depois, corrigido para "ainda não está", continuou dizendo
 *    isso depois da ativação — que aconteceu no mesmo dia. Ninguém volta para
 *    trocar um "ainda não" por um "já": nota de pendência é dívida com data de
 *    vencimento e sem cobrador.
 *
 * Escopo deliberado: só os documentos de AUTORIDADE — aqueles que alguém lê para
 * decidir. `docs/stories/`, `docs/handoffs/` e `docs/specs/` ficam de fora de
 * propósito: são planejamento e histórico, cheios de paths que descrevem o que
 * seria construído, e incluí-los faria o gate nascer com 384 violações e ser
 * desligado na primeira semana. Dívida congelada, defeito novo reprovado.
 */

const RAIZ = path.resolve(__dirname, "../..");

/** Documentos que alguém lê para DECIDIR. Ampliar esta lista é sempre bem-vindo. */
const AUTORIDADE = [
  "CLAUDE.md",
  "AGENTS.md",
  "CONTRIBUTING.md",
  "ARCHITECTURE.md",
  "README.md",
  "SECURITY.md",
  "docs/index.md",
  "docs/current-state.md",
  "docs/harness-audit.md",
  "docs/threat-model.md",
  "docs/DEPLOY-CHECKLIST.md",
  "docs/SETUP.md",
  "docs/apostila-contribuidor.md",
  "docs/doctrine",
  "docs/runbooks",
  "docs/adr",
  "docs/saas",
  "triagem",
  // Skills embutidas: alguém as lê para AGIR (instalar, contribuir). A fonte é
  // `.agents/skills`; o espelho `.claude/skills` é byte-idêntico (gate próprio).
  ".agents/skills",
];

/**
 * Um único ponteiro morto conhecido, e ele é HONESTO: o runbook cita o script e,
 * na mesma frase, declara que ele ainda não existe. Congelado com justificativa
 * em vez de silenciado — se um dia o script nascer, esta entrada sai.
 */
const PONTEIROS_MORTOS_ACEITOS = new Set([
  "docs/runbooks/ai-credentials-rotation.md::scripts/rotate-ai-cred-aes-key.ts",
]);

/**
 * Nomes ilustrativos: `lib/foo/bar.ts` não é ponteiro, é exemplo.
 *
 * O segmento tem que terminar ali — `(?=\/|\.|$)`. Sem essa âncora, a alternativa
 * `bar` casava o começo de `barra-do-navegador`, e `lib/branding/barra-do-navegador.ts`
 * (arquivo REAL, existe hoje) ficava invisível ao gate: se alguém o renomeasse, o
 * documento continuaria apontando para o vazio com o gate verde. Uma isenção
 * larga demais é pior que isenção nenhuma, porque parece cobertura.
 *
 * `...`, `<` e `NNNN` seguem sem âncora de propósito: são marcas de reticência e de
 * placeholder de template (`<timestamp>`, `NNNN_slug.sql`), não nomes de segmento.
 */
const EH_PLACEHOLDER =
  /(^|\/)(?:(?:foo|bar|baz|exemplo|caminho|nome-da-nota)(?=\/|\.|$)|NNNN|\.\.\.|<)/;

const LINK_RELATIVO = /\[[^\]]*\]\((?!https?:|#|mailto:)([^)#\s]+)/g;
const PATH_EM_CRASE =
  /`((?:app|lib|components|workers|scripts|tests|supabase|hooks|docs|hostgator-setup-kit|triagem|\.github|\.agents|\.claude|\.codex|\.cursor|\.opencode)\/[A-Za-z0-9_./[\]-]+\.(?:ts|tsx|sql|sh|yml|yaml|json|md|mdc|toml|mjs))`/g;

/**
 * O ALVO, e não só o caminho.
 *
 * As duas conferências acima olham o ARQUIVO e param ali. Medido nesta árvore em
 * 2026-11-16: 450 links relativos, 75 deles com `#slug`, 34 referências
 * `caminho/arquivo.ext:NNN` — e NENHUMA das 34 chegava a ser olhada, porque
 * `PATH_EM_CRASE` exige o fechamento da crase logo depois da extensão e `:163`
 * cai fora do padrão. Nos links, `LINK_RELATIVO` captura `([^)#\s]+)`, então
 * `docs/runbooks/x.md#5-quando-...` era conferido como `docs/runbooks/x.md`: a
 * âncora sumia antes de alguém perguntar por ela.
 *
 * O preço dessa cegueira está em duas issues abertas: o `README.md` apontava para
 * `#5-quando-o-compute-nano-...` quando a seção é a **6** (#4759) e o runbook de
 * custo citava `:163` para o cron `data-retention`, que mora na `:175` (#4760).
 * Este gate passava verde nos dois. Uma cerca que não olha o alvo é pior que
 * cerca nenhuma: dá sensação de cobertura.
 */
const LINK_COM_ANCORA = /\[[^\]]*\]\((?!https?:|mailto:)([^)\s]*#[^)\s]+)\)/g;
const REFERENCIA_DE_LINHA =
  /`([A-Za-z0-9_][A-Za-z0-9_./[\]-]*\.(?:ts|tsx|sql|sh|yml|yaml|json|md|mjs|toml)):(\d+)(?:-(\d+))?`/g;

/**
 * O que já estava torto quando o gate aprendeu a olhar o alvo — dívida congelada,
 * defeito NOVO reprovado.
 *
 * Mesmo idioma de `HOSTS_DECLARADOS` e `FORA_DA_LISTA`: cada entrada é um fato
 * medido, com o motivo escrito. Não há asserção de "entrada obsoleta" de
 * propósito: as duas primeiras linhas abaixo estão sendo consertadas em PR
 * separado (#4789 e #4790), e uma lista que exige a dívida viva reprovaria
 * exatamente o PR que a paga. Quando o documento for corrigido, a entrada fica
 * inerte — ela só é consultada quando a violação aparece.
 *
 * Medição que produziu esta lista (2026-11-16): 75 âncoras conferidas (1 torta),
 * 34 referências de linha conferidas (4 tortas, 2 delas defeito real e 2 em que a
 * citação está certa e o rótulo da frase é que nomeia outra coisa).
 */
const ANCORAS_QUE_ENVELHECERAM: Record<string, string> = {
  "README.md::docs/runbooks/custo-e-cota-do-supabase.md#5-quando-o-compute-nano-do-plano-grátis-não-basta":
    "envelheceu em data medida: a seção do compute Nano é a 6 desde que o runbook " +
    "ganhou a §5 de log ingestion; o link ficou na 5 e cai no topo do arquivo. É o " +
    "defeito do #4759, com conserto no PR #4789.",
};

const LINHAS_QUE_ENVELHECERAM: Record<string, string> = {
  "docs/runbooks/custo-e-cota-do-supabase.md::docker/scheduler/entrypoint.sh:163":
    "envelheceu em data medida: o cron `data-retention` mora na :175 — a lista CRONS " +
    "cresceu e a citação ficou para trás. É o defeito do #4760, com conserto no PR #4790.",
  "docs/runbooks/custo-e-cota-do-supabase.md::docker/scheduler/entrypoint.sh:167":
    "envelheceu em data medida: o cron `media-retention` mora na :179, pelo mesmo " +
    "motivo do :163 acima. Defeito do #4760, conserto no PR #4790.",
  "docs/runbooks/custo-e-cota-do-supabase.md::lib/messaging/media/types.ts:7":
    "a citação está CERTA (`MAX_MEDIA_BYTES` é o limite de 50 MB); quem não casa é o " +
    "rótulo `whatsapp-media`, que a frase usa para nomear o bucket e não o que a linha " +
    "contém. A conferência de rótulo não distingue os dois casos — congelado em data medida.",
  "docs/runbooks/custo-e-cota-do-supabase.md::supabase/migrations/20260926200200_0432_poda_de_midia.sql:35":
    "idem: a linha traz `media_retention_days`, e o rótulo da frase é o nome do job " +
    "`media-retention`. Citação certa, rótulo vizinho — congelado em data medida.",
};

/**
 * Slug de cabeçalho na régua do GitHub, calibrada contra os 75 links com `#` que
 * este repo já tinha: minúsculas, pontuação e símbolo fora (emoji inclusive),
 * `-` e `_` ficam, e CADA espaço vira um hífen — não a corrida de espaços. Com
 * `\s+ → "-"` o cabeçalho `## 1. Supabase — banco + auth + storage` viraria
 * `1-supabase-banco-auth-storage` e o link real `#1-supabase--banco--auth--storage`
 * reprovaria como falso positivo. Com a troca por espaço, 74 dos 75 casam: o único
 * que não casa é o defeito do #4759.
 */
function slugDeCabecalho(titulo: string): string {
  return titulo
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\p{M}\s_-]/gu, "")
    .replace(/ /g, "-");
}

const cabecalhosPorArquivo = new Map<string, Set<string>>();

/** Slugs dos cabeçalhos do arquivo, na ordem — `#x` repetido vira `#x-1`, como no GitHub. */
function cabecalhosDe(abs: string): Set<string> {
  const pronto = cabecalhosPorArquivo.get(abs);
  if (pronto) return pronto;

  const slugs = new Set<string>();
  const vistos = new Map<string, number>();
  let emCerca = false;

  for (const linha of fs.readFileSync(abs, "utf8").split("\n")) {
    if (/^\s*(```|~~~)/.test(linha)) {
      emCerca = !emCerca;
      continue;
    }
    if (emCerca) continue; // `#` dentro de bloco de código não é cabeçalho
    const m = /^#{1,6}\s+(.+?)\s*#*\s*$/.exec(linha);
    if (!m?.[1]) continue;
    const base = slugDeCabecalho(m[1]);
    const repetido = vistos.get(base) ?? 0;
    vistos.set(base, repetido + 1);
    slugs.add(repetido === 0 ? base : `${base}-${repetido}`);
  }

  cabecalhosPorArquivo.set(abs, slugs);
  return slugs;
}

const linhasPorArquivo = new Map<string, string[]>();

function linhasDe(abs: string): string[] {
  const pronto = linhasPorArquivo.get(abs);
  if (pronto) return pronto;
  const linhas = fs.readFileSync(abs, "utf8").split("\n");
  linhasPorArquivo.set(abs, linhas);
  return linhas;
}

/**
 * Onde mora o arquivo citado. Caminho é relativo à RAIZ (é como os documentos
 * deste repo escrevem: `docs/SETUP.md:136` visto de dentro de `docs/runbooks/`).
 * Nome solto — `vitest.config.ts:12` — se resolve por `git ls-files`: o documento
 * cita o arquivo pelo nome, e afirmar que ele existe em algum lugar é o que a
 * frase faz. Inventar um caminho que o texto não deu seria fingir rigor.
 */
function arquivoCitado(alvo: string): string | null {
  const naRaiz = path.join(RAIZ, alvo);
  if (fs.existsSync(naRaiz)) return naRaiz;
  if (alvo.includes("/")) return null;
  const achados = execFileSync("git", ["ls-files", `*${alvo}`], {
    cwd: RAIZ,
    encoding: "utf8",
  })
    .split("\n")
    .filter(Boolean);
  const primeiro = achados[0];
  return primeiro ? path.join(RAIZ, primeiro) : null;
}

/**
 * Rótulos que a frase dá ao ponteiro: `o cron \`data-retention\` roda às 04h40
 * (\`docker/scheduler/entrypoint.sh:163\`)`. Conta só o que vem ANTES da
 * referência e na mesma frase — 240 caracteres, cortados no último ponto ou na
 * última célula de tabela. É a ordem em que se escreve quando a linha é oferecida
 * como prova do símbolo, e é o que pega o defeito do #4760.
 */
function rotulosDaFrase(texto: string, indice: number): string[] {
  const antes = texto.slice(Math.max(0, indice - 240), indice);
  const corte = Math.max(
    antes.lastIndexOf(". "),
    antes.lastIndexOf(" | "),
    antes.lastIndexOf("\n\n"),
  );
  return [...antes.slice(corte + 1).matchAll(/`([^`\s]+)`/g)].flatMap(([, rotulo]) =>
    rotulo && /^[A-Za-z][\w-]{3,}$/.test(rotulo) ? [rotulo] : [],
  );
}

function decodificar(alvo: string): string {
  try {
    return decodeURIComponent(alvo);
  } catch {
    return alvo; // `%` solto não é codificação; o alvo vale como está
  }
}

function markdownsRastreados(): string[] {
  const saida = execFileSync("git", ["ls-files", "*.md"], { cwd: RAIZ, encoding: "utf8" });
  return saida.split("\n").filter(Boolean);
}

function ehAutoridade(arquivo: string): boolean {
  return AUTORIDADE.some((a) => arquivo === a || arquivo.startsWith(`${a}/`));
}

describe("documentação — o que ela aponta existe", () => {
  const docs = markdownsRastreados().filter(ehAutoridade);

  it("a lista de documentos de autoridade não está vazia", () => {
    // Sem esta asserção o teste passaria com um glob quebrado, varrendo zero
    // arquivos e devolvendo verde — o modo de falha mais barato de todos.
    expect(docs.length, "nenhum documento de autoridade encontrado").toBeGreaterThan(20);
    expect(docs, "CLAUDE.md saiu do escopo").toContain("CLAUDE.md");
    expect(docs.some((d) => d.startsWith("docs/doctrine/"))).toBe(true);
  });

  it("nenhum link relativo aponta para arquivo que não existe", () => {
    const mortos: string[] = [];

    for (const doc of docs) {
      const base = path.dirname(path.join(RAIZ, doc));
      const texto = fs.readFileSync(path.join(RAIZ, doc), "utf8");

      for (const [, alvo] of texto.matchAll(LINK_RELATIVO)) {
        if (!alvo || EH_PLACEHOLDER.test(alvo)) continue;
        // Markdown permite `%20`/`%C3%A3` no alvo (é assim que se linka um nome com
        // espaço ou acento sem os `<>`); o disco não conhece a forma codificada.
        // Sem decodificar, um link VÁLIDO para arquivo existente reprovava como morto.
        if (fs.existsSync(path.resolve(base, decodificar(alvo)))) continue;
        if (PONTEIROS_MORTOS_ACEITOS.has(`${doc}::${alvo}`)) continue;
        mortos.push(`${doc} → ${alvo}`);
      }
    }

    expect(mortos, `link(s) para arquivo inexistente:\n${mortos.join("\n")}`).toEqual([]);
  });

  it("nenhum path citado em crase aponta para arquivo que não existe", () => {
    const mortos: string[] = [];

    for (const doc of docs) {
      const texto = fs.readFileSync(path.join(RAIZ, doc), "utf8");

      for (const [, alvo] of texto.matchAll(PATH_EM_CRASE)) {
        if (!alvo || EH_PLACEHOLDER.test(alvo)) continue;
        if (fs.existsSync(path.join(RAIZ, alvo))) continue;
        if (PONTEIROS_MORTOS_ACEITOS.has(`${doc}::${alvo}`)) continue;
        mortos.push(`${doc} → ${alvo}`);
      }
    }

    expect(mortos, `path(s) citados que não existem:\n${mortos.join("\n")}`).toEqual([]);
  });

  it("nenhuma nota de pendência sobre gates já ativados sobreviveu", () => {
    // Frases LITERAIS que este repo já carregou depois de a pendência ser
    // resolvida. Não é lista de palavras proibidas: é o registro de uma dívida
    // que apodreceu — cada entrada aqui foi um texto real que enganou alguém.
    const FRASES_MORTAS = [
      "assim que o check entrar na branch protection",
      "imagem quebrada ainda não bloqueia merge",
      "`imagens-ok` ainda não está",
      "imagens-ok` ainda não é obrigatório",
    ];

    const violacoes: string[] = [];

    /**
     * A isenção olha o que vem ANTES da frase, não a linha inteira.
     *
     * A primeira versão filtrava a linha toda com `!l.includes("dizia")`, e isso
     * abria um buraco medido: `Nota: o \`imagens-ok\` ainda não é obrigatório, ao
     * contrário do que a doc dizia.` passava verde — afirmação FALSA e EM VIGOR,
     * isenta porque a palavra aparecia depois dela. Em prosa pt-br, "dizia" é
     * palavra comum; vetar a linha por contê-la é vetar quase qualquer parágrafo.
     *
     * A distinção que sobrevive é posicional: quem CITA o erro passado põe a marca
     * antes ("o arquivo dizia \`…\`"); quem AFIRMA põe a frase primeiro. 60
     * caracteres cobrem a introdução típica sem alcançar a oração seguinte.
     */
    const CITA = /(já disse|dizia|dizendo|afirmava|carregou|carregava|["“«])[^"“«]{0,60}$/;

    for (const doc of docs) {
      const linhas = fs.readFileSync(path.join(RAIZ, doc), "utf8").split("\n");

      for (const linha of linhas) {
        if (linha.trimStart().startsWith(">")) continue; // bloco de nota
        for (const frase of FRASES_MORTAS) {
          const i = linha.indexOf(frase);
          if (i === -1) continue;
          if (CITA.test(linha.slice(0, i))) continue;
          violacoes.push(`${doc}: "${frase}"`);
        }
      }
    }

    expect(
      violacoes,
      `nota de pendência sobrevivente — o gate citado JÁ está ativo:\n${violacoes.join("\n")}\n` +
        `confira a régua real: gh api repos/melgarafael/DeskcommCRM/branches/main/protection --jq '.required_status_checks.contexts'`,
    ).toEqual([]);
  });
});

/**
 * A segunda metade do mesmo gate: o ponteiro não basta apontar para um arquivo —
 * ele tem de apontar para DENTRO dele. Sem isto o título do arquivo promete o que
 * o gate não faz, e os dois defeitos abaixo passam verdes, como passaram:
 * `README.md` → `#5-...` numa seção 6 (#4759) e `entrypoint.sh:163` num cron que
 * mora na `:175` (#4760).
 */
describe("documentação — o ponteiro acerta o alvo dentro do arquivo", () => {
  const docs = markdownsRastreados().filter(ehAutoridade);

  it("a conferência de alvo não está varrendo zero", () => {
    // Mesmo modo de falha barato da primeira cerca: um regex quebrado devolve
    // verde varrendo nada. Estes pisos são a medição de 2026-11-16 (75 e 34):
    // se caírem muito, alguém quebrou a captura, não a documentação.
    let ancoras = 0;
    let referencias = 0;
    for (const doc of docs) {
      const texto = fs.readFileSync(path.join(RAIZ, doc), "utf8");
      ancoras += [...texto.matchAll(LINK_COM_ANCORA)].length;
      referencias += [...texto.matchAll(REFERENCIA_DE_LINHA)].length;
    }
    expect(ancoras, "nenhum link com âncora capturado — o padrão quebrou").toBeGreaterThan(50);
    expect(
      referencias,
      "nenhuma referência `arquivo:linha` capturada — o padrão quebrou",
    ).toBeGreaterThan(25);
  });

  it("nenhum link com âncora aponta para cabeçalho que não existe", () => {
    const tortas: string[] = [];

    for (const doc of docs) {
      const absDoc = path.join(RAIZ, doc);
      const texto = fs.readFileSync(absDoc, "utf8");

      for (const [inteiro, destinoBruto] of texto.matchAll(LINK_COM_ANCORA)) {
        if (!destinoBruto) continue;
        const i = destinoBruto.indexOf("#");
        const arquivo = destinoBruto.slice(0, i);
        const fragmento = decodificar(destinoBruto.slice(i + 1));
        if (!fragmento) continue;

        let alvo: string;
        if (arquivo === "") {
          alvo = absDoc; // âncora no próprio documento
        } else {
          // Âncora em `.md` do repo. Em outro tipo (imagem, diagrama, PDF) o
          // `#` não é cabeçalho — o gate não tem régua para conferir e não finge
          // que tem.
          if (!arquivo.endsWith(".md")) continue;
          alvo = path.resolve(path.dirname(absDoc), decodificar(arquivo));
          if (!fs.existsSync(alvo)) continue; // o teste de link morto acima já acusa
        }

        if (cabecalhosDe(alvo).has(fragmento)) continue;
        const chave = `${doc}::${destinoBruto}`;
        if (ANCORAS_QUE_ENVELHECERAM[chave]) continue;
        tortas.push(`${doc} → ${inteiro}`);
      }
    }

    expect(
      tortas,
      "link com âncora que não existe no documento de destino — o leitor cai no topo " +
        "do arquivo e conclui que a seção não existe:\n" +
        tortas.join("\n") +
        "\nSe o cabeçalho mudou de nome, conserte o link; se é dívida antiga e medida, " +
        "declare em ANCORAS_QUE_ENVELHECERAM com o motivo.",
    ).toEqual([]);
  });

  it("nenhuma referência `arquivo:linha` aponta para linha que não existe", () => {
    const tortas: string[] = [];

    for (const doc of docs) {
      const absDoc = path.join(RAIZ, doc);
      const texto = fs.readFileSync(absDoc, "utf8");

      for (const m of texto.matchAll(REFERENCIA_DE_LINHA)) {
        const [bruto, alvo, inicio, fim] = m;
        if (!alvo || !inicio) continue;
        const abs = arquivoCitado(alvo);
        const chave = `${doc}::${alvo}:${inicio}`;
        if (!abs) {
          if (LINHAS_QUE_ENVELHECERAM[chave]) continue;
          tortas.push(`${doc} → ${bruto} (arquivo não existe)`);
          continue;
        }

        const linhas = linhasDe(abs);
        const ultima = Number(fim ?? inicio);
        if (Number(inicio) < 1 || ultima > linhas.length) {
          if (LINHAS_QUE_ENVELHECERAM[chave]) continue;
          tortas.push(`${doc} → ${bruto} (o arquivo tem ${linhas.length} linhas)`);
          continue;
        }

        /**
         * Rótulo: quando a frase nomeia o símbolo e o símbolo aparece UMA vez no
         * arquivo, o ponteiro tem de cair naquela linha — é o caso do cron que
         * andou (#4760). Quando o nome se repete (variável de ambiente, nome de
         * bucket), a frase pode legitimamente citar o lugar que USA o símbolo, e
         * exigir o nome na linha congelaria frases verdadeiras como erro; aí a
         * conferência para na existência da linha. Medido: dos 34 ponteiros, 6
         * têm rótulo localizável — os outros 28 ficam na existência.
         */
        const unicos = rotulosDaFrase(texto, m.index ?? 0).filter(
          (rotulo) => linhas.filter((l) => l.includes(rotulo)).length === 1,
        );
        if (unicos.length === 0) continue;
        // Faixa (`:39-41`) vale pelo trecho inteiro: o símbolo pode estar em
        // qualquer linha que a citação cobre.
        const janela = linhas.slice(Number(inicio) - 1, ultima);
        if (unicos.some((rotulo) => janela.some((l) => l.includes(rotulo)))) continue;
        if (LINHAS_QUE_ENVELHECERAM[chave]) continue;
        tortas.push(
          `${doc} → ${bruto} (a linha ${inicio} não contém ${unicos.join("|")}, ` +
            `que aparece só em outra linha de ${alvo})`,
        );
      }
    }

    expect(
      tortas,
      "referência `arquivo:linha` que não fecha — a linha citada não existe ou não é a " +
        "do símbolo que a frase nomeia:\n" +
        tortas.join("\n") +
        "\nSe o código andou, atualize o número; se é dívida antiga e medida, declare em " +
        "LINHAS_QUE_ENVELHECERAM com o motivo.",
    ).toEqual([]);
  });
});
