/**
 * O MANIFEST APONTA PARA COISAS QUE EXISTEM.
 *
 * ## O defeito que fez este arquivo existir
 *
 * No merge do PR #1135 (`149cc9b5d`), a linha da `0277_pais_da_organizacao`
 * entrou na `main` afirmando:
 *
 *     Gate: `tests/unit/pais-da-organizacao.test.ts`
 *
 * Esse arquivo nunca existiu. O gate real chama-se
 * `tests/unit/pais-da-organizacao-governa-documento-e-lei.test.ts`. A mesma
 * linha citava `PAISES_OFERECIDOS`, um símbolo que também nunca existiu — o
 * real é a função `paisesOferecidos()`, e o nome em CAIXA_ALTA era o irmão
 * `PERFIS_DO_PAIS` contaminando a prosa.
 *
 * Nada acusou, e não por descuido de quem revisou: `manifest-x-migrations`
 * — a catraca que já existia ao lado — lê do MANIFEST **só a segunda coluna**
 * (`NNNN_slug`), para casar linha com arquivo de migration. A prosa da terceira
 * coluna nenhum gate lia. O registro ficava **verde e errado ao mesmo tempo**,
 * que é a pior das combinações: quem fosse procurar o gate da migration não o
 * acharia, e concluiria que a mudança entrou sem guarda nenhuma.
 *
 * Ao medir esta classe para escrever o arquivo, o mesmo defeito apareceu em
 * mais DOIS registros, de PRs sem relação entre si — ou seja, não era um
 * escorregão isolado:
 *
 *   - `0140` citava `lib/ai/dispatcher/budget.ts`; o leitor real do contador é
 *     `lib/ai/budget/check.ts` (`lib/ai/dispatcher/` existe, mas nunca teve
 *     `budget.ts`);
 *   - `0243` citava `tests/invariants/trava-de-definer-tem-prazo.test.ts`; a
 *     varredura real é `tests/invariants/chamada-de-api-tem-prazo-de-trava.test.ts`,
 *     o nome embaralhado do próprio slug da migration.
 *
 * Três ponteiros podres em 120 citações de caminho, plantados em momentos
 * diferentes. É classe, não acidente.
 *
 * ## O que se guarda aqui — e o que NÃO se guarda
 *
 * Guarda-se **caminho**, que resolve sem ambiguidade: o arquivo existe no disco
 * ou não existe.
 *
 * NÃO se guarda **símbolo**, e a omissão é deliberada — medida, não preguiça.
 * Varrendo os 21 identificadores em CAIXA_ALTA citados no MANIFEST, três não
 * resolviam para declaração nenhuma, e só UM era defeito:
 *
 *   - `PAISES_OFERECIDOS` — o defeito;
 *   - `APP_COUNTRY` — **contrafactual**: a linha cita o `.env` que o projeto
 *     RECUSOU ("responderia por processo, e o processo serve todas"). Exigir
 *     que resolva seria exigir que o desenho rejeitado exista;
 *   - `TEMPLATE_REQUIRED` — vocabulário **de terceiro**: o código de erro que a
 *     API do intermediário devolve. Não tem como morar neste repo.
 *
 * Os três são, na forma, idênticos: token em CAIXA_ALTA que não resolve. O que
 * separa o defeito dos outros dois é a INTENÇÃO de quem escreveu, e intenção
 * não se lê por regex. Um gate de símbolo precisaria de uma lista de exceções
 * cujas entradas são indistinguíveis do defeito — isto é, não verificaria a
 * classe, verificaria se alguém lembrou de atualizar a lista. Seria um segundo
 * MANIFEST para manter em dia, com exatamente o apodrecimento do primeiro.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const RAIZ = process.cwd();
const MANIFEST = join(RAIZ, "supabase", "migrations", "MANIFEST.md");

/** Extensões que denunciam um arquivo do repo (e não uma tabela ou um slug). */
const EXTENSOES = [".ts", ".tsx", ".sql", ".md", ".sh", ".yml", ".yaml", ".json"];

/**
 * O MANIFEST.md (histórico) MAIS as linhas `-- manifest:` das migrations que se
 * descrevem no próprio arquivo — as duas metades do mesmo registro.
 */
function manifesto(): string {
  const dir = join(RAIZ, "supabase", "migrations");
  const cabecalhos = readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .flatMap((f) => readFileSync(join(dir, f), "utf8").match(/^-- manifest:.*$/m) ?? []);
  return [readFileSync(MANIFEST, "utf8"), ...cabecalhos].join("\n");
}

function tokensEmCrase(texto: string): string[] {
  return [...texto.matchAll(/`([^`\n]+)`/g)].map((m) => m[1]!);
}

/**
 * Um token só é COBRADO quando é caminho a partir da raiz do repo.
 *
 * O primeiro segmento tem de ser um diretório que existe na raiz. A regra não é
 * estética: o MANIFEST cita, de propósito, caminhos RELATIVOS a uma pasta que a
 * própria frase acabou de nomear (`admin/users/route.ts`, `close/route.ts`,
 * `meta/ingest.ts`, `zernio/credentials.ts`). Esses não resolvem da raiz e
 * nunca resolveriam — cobrá-los encheria o gate de vermelho legítimo, que é o
 * jeito mais rápido de um gate ser desligado. Derivar o conjunto do disco, em
 * vez de uma lista fixa de pastas, faz a regra acompanhar o repo sozinha.
 */
function ehCaminhoDaRaiz(token: string): boolean {
  if (!EXTENSOES.some((e) => token.endsWith(e))) return false;
  // Glob é padrão, não caminho: `docs/specs/0X-spec-*.md` descreve um conjunto.
  if (/[*?]/.test(token)) return false;
  const primeiro = token.split("/")[0];
  if (primeiro === undefined || primeiro === token) return false;
  const alvo = join(RAIZ, primeiro);
  return existsSync(alvo) && statSync(alvo).isDirectory();
}

function caminhosCitados(): string[] {
  return [...new Set(tokensEmCrase(manifesto()).filter(ehCaminhoDaRaiz))].sort();
}

describe("MANIFEST × os caminhos que ele cita", () => {
  it("o MANIFEST não vem vazio nem ilegível (guarda de vacuidade)", () => {
    // Sem isto, um MANIFEST movido, renomeado ou com a formatação trocada faria
    // a asserção seguinte passar por AUSÊNCIA DE DADO — o instrumento cego
    // devolvendo verde, que é o modo de falha que este arquivo inteiro combate.
    // 111 caminhos resolviam quando o gate nasceu; o piso fica bem abaixo para
    // não virar manutenção a cada linha nova.
    expect(caminhosCitados().length).toBeGreaterThan(80);
  });

  it("todo caminho citado no MANIFEST existe no disco", () => {
    const quebrados = caminhosCitados().filter((p) => !existsSync(join(RAIZ, p)));
    expect(
      quebrados,
      "o MANIFEST aponta para arquivo que não existe — renomearam o arquivo e a prosa ficou para trás?",
    ).toEqual([]);
  });

  /**
   * Caso SEPARADO do de cima, e não um detalhe dele.
   *
   * "Gate:" é um campo com contrato: ali está o arquivo que IMPEDE a regressão
   * daquela migration. Um caminho podre no meio de um parágrafo custa uma busca;
   * um `Gate:` podre faz a próxima pessoa concluir que a mudança entrou sem
   * guarda — e reescrever a guarda que já existe, ou pior, não reescrever. É o
   * campo que quebrou no #1135, e um vermelho com o nome dele diz o que fazer.
   */
  it("todo `Gate:` do MANIFEST aponta para um arquivo de teste que existe", () => {
    const citados = [...manifesto().matchAll(/Gate:\s*`([^`\n]+)`/g)].map((m) => m[1]!);
    expect(citados.length, "nenhum `Gate:` encontrado — o formato do campo mudou?").toBeGreaterThan(
      0,
    );
    const quebrados = citados.filter((p) => !existsSync(join(RAIZ, p)));
    expect(
      quebrados,
      "`Gate:` aponta para teste que não existe — a migration parece desguardada para quem ler",
    ).toEqual([]);
  });
});
