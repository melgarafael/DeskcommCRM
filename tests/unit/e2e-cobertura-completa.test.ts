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
  // CRLF primeiro, senão o parser devolve lista VAZIA em qualquer checkout
  // Windows (git converte o workflow para `\r\n` por default). Em JS, `.` não
  // casa `\r` — ele é terminador de linha —, então `\S.*\n` para antes do `\r`
  // e a alternativa `\n` nunca chega. As três listas voltam vazias, e o efeito é
  // o pior possível: o controle positivo estoura e a asserção de completude acusa
  // TODAS as specs de uma vez, num repositório onde nada está errado. Um gate que
  // acende sem defeito é um gate que se aprende a ignorar.
  const conteudo = yml.replace(/\r\n/g, "\n");
  const re = new RegExp(`^\\s*${chave}:\\s*>-\\s*\\n((?:\\s{8,}\\S.*\\n)+)`, "m");
  const m = re.exec(conteudo);
  if (m === null) return [];
  return m[1]!
    .split(/\s+/)
    .map((s) => s.trim())
    .filter((s) => s.endsWith(".spec.ts"));
}

const yml = readFileSync(WORKFLOW, "utf8");
const parte1 = listaDoWorkflow(yml, "SPECS_PARTE_1");
const parte2 = listaDoWorkflow(yml, "SPECS_PARTE_2");
const foraDoCi = listaDoWorkflow(yml, "FORA_DO_CI");
const noDisco = readdirSync(DIR_SPECS)
  .filter((f) => f.endsWith(".spec.ts"))
  .sort();

describe("cobertura do e2e no CI", () => {
  it("o parser está vivo — controle positivo antes de qualquer conclusão", () => {
    // Sem isto, um regex que parou de casar devolveria três listas vazias e a
    // asserção de vigência passaria por vacuidade, enquanto a de completude
    // acusaria as 39 specs de uma vez. Verde e vermelho errados pelo mesmo motivo.
    expect(noDisco.length, "nenhuma spec no disco — o diretório mudou de lugar?").toBeGreaterThan(
      30,
    );
    expect(parte1.length, "SPECS_PARTE_1 não foi lida do workflow").toBeGreaterThan(10);
    expect(parte2.length, "SPECS_PARTE_2 não foi lida do workflow").toBeGreaterThan(10);
    expect(foraDoCi.length, "FORA_DO_CI não foi lida do workflow").toBeGreaterThan(0);
  });

  it("toda spec do disco está em exatamente uma lista", () => {
    const declaradas = [...parte1, ...parte2, ...foraDoCi];
    const semLista = noDisco.filter((f) => !declaradas.includes(f));
    expect(
      semLista,
      "Spec no disco que não roda no CI nem está declarada como fora. Ponha em " +
        "SPECS_PARTE_1/2 (se rodar sem WAHA/Redis/Resend) ou em FORA_DO_CI com o " +
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
    const fantasmas = [...parte1, ...parte2, ...foraDoCi].filter((f) => !noDisco.includes(f));
    expect(fantasmas, "lista do CI aponta para spec inexistente — renomeada ou apagada").toEqual(
      [],
    );
  });

  it("as listas são de fato passadas ao Playwright", () => {
    // A terceira ponta. Declarar não é executar: sem o consumo, acrescentar o nome
    // à variável deixa este gate verde e a spec continua fora do run.
    expect(yml).toMatch(/playwright test --workers=1 \$SPECS_PARTE_1/);
    expect(yml).toMatch(/playwright test --workers=1 \$SPECS_PARTE_2/);
    // E FORA_DO_CI nunca é passada a um run — ela existe para NÃO rodar.
    expect(yml).not.toMatch(/playwright test[^\n]*\$FORA_DO_CI/);
  });
});
