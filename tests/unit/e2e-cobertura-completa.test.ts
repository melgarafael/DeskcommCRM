/**
 * TODA SPEC DE E2E OU RODA NO CI, OU ESTÁ DECLARADA COMO FORA — NUNCA SUMIDA.
 *
 * ## O defeito, medido em 2026-08-08
 *
 * `.github/workflows/e2e.yml` tinha as listas de spec digitadas dentro dos dois
 * `run:` e, mais abaixo, um passo cuja função declarada era dizer o que o job NÃO
 * cobre — escrito à mão, em prosa. As duas fontes divergiram em silêncio:
 *
 *   no disco: 39 arquivos · nas listas: 36 · o texto afirmava "32 de 33"
 *
 * As três ausentes eram justamente as novas, e uma delas era
 * `agente-papeis-operador.spec.ts` — a prova de tela do épico dos três papéis do
 * agente, apresentada no handoff daquele épico como "7/7", que **nunca rodou em
 * job nenhum**. O número era afirmação do autor, não medição do CI.
 *
 * O modo de falha é o que dói: **cobertura parcial silenciosa se lê como cobertura
 * total.** Quem olha o job verde conclui que a suíte está verde. E o passo que
 * existia para desfazer essa leitura estava, ele mesmo, desatualizado.
 *
 * ## Por que estático, e por que aqui
 *
 * A propriedade é enumerável a partir do repositório — arquivos no disco × nomes
 * nas listas — e é exatamente onde a régua do repo diz que o teste ganha do hábito
 * (`navegacao-completude`, que achou duas telas órfãs que três varreduras manuais
 * não acharam). Descobrir isto dinamicamente custaria um job de CI inteiro, que é
 * o custo que se está tentando não pagar de novo.
 *
 * Vive em `tests/unit/` de propósito: `pnpm test:unit` roda no check `verify`, que
 * é OBRIGATÓRIO na branch protection. Em `tests/invariants/` dependeria de Postgres
 * e de um check que não bloqueia merge.
 *
 * ## O que se guarda — três propriedades, três modos de falha
 *
 * 1. **Completude** (disco → listas): spec nova que ninguém pôs em lista nenhuma.
 * 2. **Vigência** (listas → disco): spec renomeada ou apagada que ficou na lista;
 *    o Playwright aceita um filtro que não casa nada e o job segue VERDE.
 * 3. **Consumo**: a lista é de fato passada ao Playwright. Sem isto, alguém
 *    acrescenta o nome à variável, o gate fica verde, e a spec continua sem rodar
 *    — a mesma cobertura fantasma, com uma camada a mais de aparência.
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const RAIZ = process.cwd();
const WORKFLOW = path.join(RAIZ, ".github", "workflows", "e2e.yml");
const DIR_SPECS = path.join(RAIZ, "tests", "e2e");

/**
 * Lê uma variável de bloco YAML (`CHAVE: >-`) e devolve os nomes.
 *
 * Parser deliberadamente estreito: casa só a forma que o arquivo usa. Um parser
 * de YAML de verdade aceitaria formas que ninguém escreveu e esconderia uma
 * reescrita do bloco — aqui, se a forma mudar, o controle positivo abaixo estoura
 * em vez de devolver lista vazia.
 */
function listaDoWorkflow(yml: string, chave: string): string[] {
  const re = new RegExp(`^\\s*${chave}:\\s*>-\\s*\\n((?:\\s{8,}\\S.*\\n)+)`, "m");
  const m = re.exec(yml);
  if (m === null) return [];
  return m[1]!
    .split(/\s+/)
    .map((s) => s.trim())
    .filter((s) => s.endsWith(".spec.ts"));
}

const yml = readFileSync(WORKFLOW, "utf8");
const parte1 = listaDoWorkflow(yml, "SPECS_PARTE_1");
const parte2 = listaDoWorkflow(yml, "SPECS_PARTE_2");
const parte3 = listaDoWorkflow(yml, "SPECS_PARTE_3");
// PARTE_4 — a parte que depende de serviço externo (WAHA + Redis + dublês de
// Resend/Nuvemshop, issue #179). Listada aqui como as outras: sem isto, a spec
// que roda SÓ ali apareceria como "sem lista" e o gate acusaria o contrário do
// que aconteceu.
const parte4 = listaDoWorkflow(yml, "SPECS_PARTE_4");
// PARTE_5 — a quarta parte COMUM (a 4 é a da instalação fresca). Nasceu em
// 19/09 porque três partes comuns já não cabiam no teto: dois cortes por
// relógio no mesmo dia, ambos sem caso vermelho.
const parte5 = listaDoWorkflow(yml, "SPECS_PARTE_5");
const foraDoCi = listaDoWorkflow(yml, "FORA_DO_CI");
const noDisco = readdirSync(DIR_SPECS)
  .filter((f) => f.endsWith(".spec.ts"))
  .sort();

describe("cobertura do e2e no CI", () => {
  it("o parser está vivo — controle positivo antes de qualquer conclusão", () => {
    // Sem isto, um regex que parou de casar devolveria listas vazias e a
    // asserção de vigência passaria por vacuidade, enquanto a de completude
    // acusaria as 39 specs de uma vez. Verde e vermelho errados pelo mesmo motivo.
    expect(noDisco.length, "nenhuma spec no disco — o diretório mudou de lugar?").toBeGreaterThan(
      30,
    );
    expect(parte1.length, "SPECS_PARTE_1 não foi lida do workflow").toBeGreaterThan(10);
    expect(parte2.length, "SPECS_PARTE_2 não foi lida do workflow").toBeGreaterThan(10);
    expect(parte3.length, "SPECS_PARTE_3 não foi lida do workflow").toBeGreaterThan(10);
    expect(parte4.length, "SPECS_PARTE_4 não foi lida do workflow").toBeGreaterThan(0);
    expect(parte5.length, "SPECS_PARTE_5 não foi lida do workflow").toBeGreaterThan(0);
    expect(foraDoCi.length, "FORA_DO_CI não foi lida do workflow").toBeGreaterThan(0);
  });

  // ⚠️ LISTA DECLARADA ≠ LISTA INVOCADA. Medido em 19/09, sabotando: tirar o `5`
  // de `parte: [1, 2, 3, 4, 5]` deixa `SPECS_PARTE_5` no arquivo, com as 14
  // specs dentro, e NINGUÉM as roda — e todos os casos acima continuavam
  // verdes, porque elas seguem "declaradas". É a cobertura parcial silenciosa
  // que este arquivo existe para impedir, entrando pela porta de trás.
  // ⚠️ A PARTE 4 É UM AMBIENTE, NÃO UMA VAGA LIVRE.
  //
  // Nela os passos de semeadura não rodam (`if: matrix.parte != 4`); em vez
  // deles sobem WAHA, o par Redis e a criação do dono como o `install.sh` faz.
  // A `vps-fresh-onboarding` existe para provar que "o único dado que existe
  // antes dela é o dono" — é a P0 da jornada que se vende.
  //
  // Medido em 19/09, e é por isso que esta cerca nasceu: a
  // `funil-arquivado-volta-pela-tela` foi parar nesta lista e PASSOU no CI —
  // por acoplamento, não por direito. Ela semeia os próprios funis e chama
  // `scripts/seed-e2e-credentials.ts` no `beforeAll`, ou seja, cria no banco da
  // instalação fresca exatamente os dados que a vizinha afirma não existirem.
  // Verde por ordem de execução é verde que morre num retry — e leva junto a
  // única prova da jornada de instalação. Nada impedia isso de entrar.
  it("a parte 4 só aceita spec de instalação fresca (lista fechada)", () => {
    const PERMITIDAS = ["vps-fresh-onboarding.spec.ts"];
    expect(
      parte4.filter((f) => !PERMITIDAS.includes(f)),
      "spec que não é de instalação fresca entrou em SPECS_PARTE_4. O ambiente dela não " +
        "semeia credenciais nem fixtures, e qualquer dado criado ali quebra a premissa que a " +
        "`vps-fresh-onboarding` prova. Ponha em SPECS_PARTE_1/2/3/5. Se a spec nova for MESMO " +
        "de instalação fresca, acrescente-a a PERMITIDAS aqui, com a razão escrita.\n",
    ).toEqual([]);
    // Controle positivo: a lista não pode estar vazia por engano de parser —
    // vazia, a asserção acima passaria sem vigiar nada.
    expect(parte4.length, "SPECS_PARTE_4 veio vazia — parser morto").toBeGreaterThan(0);
  });

  it("toda lista declarada é invocada pela matrix (e vice-versa)", () => {
    const m = /^\s*parte:\s*\[([^\]]+)\]/m.exec(yml);
    expect(m, "não achei a matrix `parte:` no workflow — o parser envelheceu").not.toBeNull();
    const naMatrix = m![1]!
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .sort();
    const declaradas = [...yml.matchAll(/^\s*SPECS_PARTE_(\d+):/gm)].map((x) => x[1]!).sort();
    expect(declaradas.length, "nenhuma SPECS_PARTE_N lida — parser morto").toBeGreaterThan(1);
    expect(
      naMatrix,
      "a matrix e as listas discordam: parte declarada que ninguém roda esconde specs; " +
        "parte na matrix sem lista faz o job morrer com `lista vazia`.",
    ).toEqual(declaradas);
  });

  it("as listas do workflow só contêm NOMES DE SPEC — palavra solta vira filtro no runner", () => {
    /**
     * O bloco vai para o shell como `playwright test $LISTA`, SEM aspas. Qualquer
     * palavra que não seja um caminho de spec vira um FILTRO do Playwright — e
     * filtro casa por substring, então uma palavra curta como `de` alcança dezenas
     * de arquivos, inclusive os declarados FORA_DO_CI.
     *
     * Medido em 2026-09-20, no PR #1359: três linhas de comentário escritas DENTRO
     * do bloco `>-` viraram texto do valor. O `#` vindo de variável NÃO comenta
     * (provado em bancada: ele chega como argumento), então o runner recebeu
     * `# Ao lado da navegacao de propósito: ...` como lista de filtros. Rodaram 70
     * arquivos em vez de 33 — com specs que exigem WAHA/Resend — e o job estourou
     * o teto de 30 min.
     *
     * ⚠️ E a cerca não pegou: `listaDoWorkflow` termina em
     * `.filter((s) => s.endsWith(".spec.ts"))`, ou seja, ela DESCARTA em silêncio
     * exatamente o lixo que quebra o comando. Este caso lê o bloco cru, sem esse
     * filtro — é a diferença entre medir a lista e medir o que o shell recebe.
     */
    const cru = (chave: string): string[] => {
      const re = new RegExp(`^\\s*${chave}:\\s*>-\\s*\\n((?:\\s{8,}\\S.*\\n)+)`, "m");
      const m = re.exec(yml);
      return m === null ? [] : m[1]!.split(/\s+/).map((t) => t.trim()).filter(Boolean);
    };
    for (const chave of ["SPECS_PARTE_1", "SPECS_PARTE_2", "SPECS_PARTE_3", "SPECS_PARTE_4", "SPECS_PARTE_5"]) {
      const tokens = cru(chave);
      expect(tokens.length, `${chave} não foi lida do workflow`).toBeGreaterThan(0);
      const intrusos = tokens.filter((t) => !t.endsWith(".spec.ts"));
      expect(
        intrusos,
        `${chave} tem palavra que não é spec: o runner receberia isso como FILTRO. Comentário vai ACIMA da chave, nunca dentro do bloco.`,
      ).toEqual([]);
    }
  });

  it("toda spec do disco está em exatamente uma lista", () => {
    const declaradas = [...parte1, ...parte2, ...parte3, ...parte4, ...parte5, ...foraDoCi];
    const semLista = noDisco.filter((f) => !declaradas.includes(f));
    expect(
      semLista,
      "Spec no disco que não roda no CI nem está declarada como fora. Ponha em " +
        "SPECS_PARTE_1/2/3/5 (se rodar sem WAHA/Redis/Resend), em SPECS_PARTE_4 (com " +
        "os serviços do job) ou em FORA_DO_CI com o " +
        "motivo escrito. Cobertura parcial silenciosa se lê como cobertura total.\n",
    ).toEqual([]);

    // Duas listas não podem reivindicar a mesma spec: rodar duas vezes dobra
    // login num job que já vive perto do teto por IP.
    const duplicadas = declaradas.filter((f, i) => declaradas.indexOf(f) !== i);
    expect(duplicadas, "spec declarada em mais de uma lista").toEqual([]);
  });

  it("nenhuma lista nomeia spec que não existe mais", () => {
    // O sentido inverso, e ele é pior: `playwright test naoexiste.spec.ts` não
    // acha nada e o job termina VERDE. Uma renomeação silenciosamente desliga a
    // cobertura daquele arquivo.
    const fantasmas = [...parte1, ...parte2, ...parte3, ...parte4, ...foraDoCi].filter(
      (f) => !noDisco.includes(f),
    );
    expect(fantasmas, "lista do CI aponta para spec inexistente — renomeada ou apagada").toEqual(
      [],
    );
  });

  /**
   * AQUI HAVIA UM CASO QUE COBRAVA O NÚMERO ESCRITO NO CLAUDE.md — e ele saiu
   * porque o número saiu de lá, o que é a solução MELHOR.
   *
   * Convergência independente, na mesma tarde: eu vi a contagem apodrecida
   * ("48 das 49" com 50 de 51 no repo), corrigi o número e escrevi um gate para
   * prendê-lo. Em paralelo, o time tratou o mesmo apodrecimento pela raiz —
   * apagou o número do CLAUDE.md e deixou no lugar o comando que o produz.
   *
   * A deles vence, e não por gentileza: é o que o DoD 16 daquele arquivo manda
   * fazer ("onde a afirmação puder virar comando, troque em vez de corrigir: um
   * número corrigido envelhece de novo; um `rode isto para saber` não envelhece
   * nunca"). Um gate que prende um número congela a manutenção dele para sempre;
   * tirar o número dissolve a classe inteira do problema.
   *
   * Não sobrou buraco: sem número no texto, não há o que divergir do workflow.
   * As três pontas que importam — disco→listas, listas→disco e listas→Playwright
   * — seguem cobradas pelos casos vizinhos.
   */
  it("as listas são de fato passadas ao Playwright", () => {
    // A terceira ponta. Declarar não é executar: sem o consumo, acrescentar o nome
    // à variável deixa este gate verde e a spec continua fora do run.
    //
    // As partes passaram a rodar em PARALELO (matrix), e o comando deixou de
    // citar a variável direto: ele escolhe a lista pela `matrix.parte`. A
    // propriedade que este caso guarda não mudou, então ele cobra a CADEIA
    // inteira em vez de uma linha literal — as três variáveis chegam a `LISTA`,
    // e é `LISTA` que vai ao Playwright. Cobrar só o `--workers=1 $LISTA`
    // deixaria passar um workflow onde `LISTA` nunca é atribuída.
    // Enumerar as partes À MÃO aqui repetiria o defeito que este bloco existe
    // para impedir. As partes são DESCOBERTAS no próprio workflow: quem
    // acrescentar uma quarta não precisa lembrar de nada — e se esquecer de
    // ligá-la, é aqui que descobre.
    const partesDeclaradas = [...yml.matchAll(/^ {6}(SPECS_PARTE_\d+):/gm)].map((m) => m[1]!);
    expect(
      partesDeclaradas.length,
      "nenhuma SPECS_PARTE_N no workflow — o parser mudou?",
    ).toBeGreaterThan(1);
    for (const parte of partesDeclaradas)
      expect(yml, `${parte} não alimenta a variável que roda`).toMatch(
        new RegExp(`LISTA="\\$${parte}"`),
      );
    expect(yml, "a lista escolhida não é passada ao Playwright").toMatch(
      /playwright test --workers=1 \$LISTA/,
    );
    // E A CONTAGEM DO SUMMARY TAMBÉM SOMA TODAS AS PARTES.
    //
    // O passo de cobertura do job agregador faz `RODOU + FORA == disco` e
    // reprova quando não bate. Ele é uma SEGUNDA implementação da mesma regra
    // que este arquivo guarda — e as duas divergiram: a parte 3 entrou nas
    // listas, no `case` e neste teste, e ficou de fora daquela soma. O CI
    // acusou `rodou=72 fora=3 disco=100`, faltando exatamente as 25 da parte 3.
    // Guardar só a régua e deixar a irmã solta é como ter um gate e meio.
    const somaDoSummary = /RODOU=\$\(\s*\{([^}]*)\}/.exec(yml)?.[1] ?? "";
    expect(somaDoSummary, "não achei a soma `RODOU=$( { ... }` no workflow").not.toBe("");
    for (const parte of partesDeclaradas)
      expect(
        somaDoSummary,
        `${parte} não entra na contagem de cobertura do job agregador — o summary vai acusar ` +
          "divergência entre listas e disco, ou pior, deixar de acusar uma spec que não roda",
      ).toContain(parte);

    // E FORA_DO_CI nunca é passada a um run — ela existe para NÃO rodar.
    expect(yml).not.toMatch(/playwright test[^\n]*\$FORA_DO_CI/);
    expect(yml).not.toMatch(/LISTA="\$FORA_DO_CI"/);
  });
});
