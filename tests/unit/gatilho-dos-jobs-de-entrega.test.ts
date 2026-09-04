/**
 * NENHUM JOB PODE SER DESLIGADO POR UMA CONDIÇÃO — E PASSAR VERDE.
 *
 * ## O buraco medido (issue #459)
 *
 * `if:` na altura do job não faz o job FALHAR: faz ele NÃO RODAR. E job que não
 * roda vira `skipped`, que a branch protection do GitHub lê como check
 * satisfeito. Então uma linha só —
 *
 *     -    if: github.event_name == 'push'
 *     +    if: github.event_name == 'push' && false
 *
 * — desliga a cadeia inteira de release e sai VERDE nos cinco checks
 * obrigatórios. Foi o que apareceu triando o PR #458: um contribuidor de fork
 * tinha (com razão, no fork dele) desligado os jobs de release, e a adaptação
 * pegou carona no PR de volta. Mergeado, a sequência seria: merge verde na
 * `main` → `cortar-tag` pulado → nenhuma tag, nenhuma imagem, `stable` parado →
 * NINGUÉM vê erro em lugar nenhum → a descoberta é um cliente rodando
 * `update.sh` e não recebendo nada.
 *
 * ## Por que o teste que já existia não pegava
 *
 * `tests/unit/tag-so-nasce-da-main.test.ts` já tinha uma asserção sobre a
 * condição do `cortar-tag`, e ela passa com o sabotado:
 *
 *     $ node -e "console.log(/if:\s*github\.event_name == 'push'/
 *                 .test(\"    if: github.event_name == 'push' && false\"))"
 *     true
 *
 * `toMatch` é BUSCA, não igualdade — qualquer sufixo colado passa. Medido no
 * HEAD c5b45b24 com `&& false` nos três jobs: aquele arquivo saiu 10/10 verde.
 * Por isso aqui a comparação é `toBe` contra a expressão INTEIRA.
 *
 * ## O mapa cobre a pasta toda, não uma lista de suspeitos
 *
 * Todo job de `.github/workflows` declara seu gatilho em `GATILHO_ESPERADO` —
 * inclusive os que não têm `if:` nenhum, que é a maioria e é o estado seguro.
 * Job novo que não esteja aqui reprova, e job que sai daqui reprova também.
 * Uma lista de suspeitos protegeria os jobs de hoje e nenhum dos de amanhã;
 * o `skipped`-lido-como-sucesso vale para QUALQUER check obrigatório, não só
 * para os dois do `release.yml`.
 *
 * ## Não há parser YAML nas dependências
 *
 * `yaml`/`js-yaml` não estão em `dependencies` nem em `devDependencies`
 * (js-yaml só existe como transitiva do eslint, e depender de transitiva é
 * dívida) — a mesma constatação de `tests/unit/workflows-tem-permissions.test.ts`.
 * Então: recorte por indentação + CONTROLE POSITIVO. Sem o controle, um regex
 * que parou de casar devolve lista vazia e o gate fica verde vigiando nada.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const DIR = join(process.cwd(), ".github/workflows");

/**
 * O gatilho de cada job, e o que se perde quando ele não roda.
 *
 * `condicao: null` significa SEM `if:` na altura do job — o estado seguro, e o
 * que a maioria destes jobs precisa ser. Entrada nova aqui é decisão
 * consciente: o teste reprova até alguém escrevê-la, e escrever uma condição
 * que desliga um job de entrega fica visível em code review.
 */
const GATILHO_ESPERADO: Record<string, { condicao: string | null; efeito: string }> = {
  // --- a cadeia que leva o conserto até a VPS ---------------------------------
  "release.yml::abrir-pr-de-release": {
    condicao: "github.event_name == 'workflow_dispatch'",
    efeito:
      "Este job é quem monta o PR de release a partir dos fragmentos de `.changes/`. " +
      "Desligá-lo faz nenhuma versão ser fechada — sem erro em lugar nenhum.",
  },
  "release.yml::cortar-tag": {
    condicao: "github.event_name == 'push'",
    efeito:
      "Este job é quem CRIA E EMPURRA a tag `vX.Y.Z`, que é o gatilho da atualização " +
      "do parque instalado inteiro. Desligá-lo faz a release parar em silêncio: nenhuma " +
      "tag nasce, nenhuma imagem sai, `stable` congela, e a descoberta é um cliente " +
      "rodando `update.sh` e não recebendo nada.",
  },
  "publish-image.yml::a-tag-veio-da-main": {
    condicao: null,
    efeito:
      "Esta é a trava de procedência: nenhuma tag publica sem estar contida na `main`. " +
      "Ela é SEM `if:` de propósito — pulada, ela deixaria `build-and-push` pulado junto " +
      "e o `imagens-ok` leria `skipped` como reprovação.",
  },
  "publish-image.yml::build-and-push": {
    condicao: null,
    efeito:
      "Este job PUBLICA as três imagens no GHCR — é o artefato que o self-hoster instala. " +
      "Desligá-lo faz a tag existir sem imagem por trás dela.",
  },
  "publish-image.yml::imagem-do-app-sobe": {
    condicao: null,
    efeito:
      "Este job prova que a imagem do app BOOTA, não só que ela constrói. Desligá-lo " +
      "devolve o defeito que derrubou a produção: imagem publicada que morre no " +
      "`docker compose up` da VPS.",
  },
  // A promoção do canal `stable`, que o PR #498 tirou de dentro da matriz: lá,
  // cada uma das três imagens movia o canal sozinha ao terminar, e um `stable`
  // podia apontar para um app novo com worker velho. Desligá-lo aqui não deixa
  // rastro nenhum: o job vira `skipped`, as três imagens publicam, a tag sai, e
  // o canal simplesmente NÃO ANDA — quem instala pelo default do compose fica na
  // versão anterior sem que nada tenha ficado vermelho.
  "publish-image.yml::promover-stable": {
    condicao:
      "github.event_name == 'push' && github.ref_type == 'tag' && startsWith(github.ref_name, 'v')",
    efeito:
      "As três condições barram um caminho medido cada uma. Sem `push`, um dispatch numa " +
      "release ANTIGA faria `stable` REGREDIR, e todo self-hoster no default do compose " +
      "sofreria downgrade silencioso no próximo `up -d` — app velho sobre banco já migrado. " +
      "Sem `tag`, um dispatch numa branch moveria o canal. Sem o `v`, uma tag de teste o move.",
  },

  "publish-image.yml::imagens-ok": {
    condicao: "always()",
    efeito:
      "Este é o check obrigatório `imagens-ok`, a fachada que a branch protection exige. " +
      "Ele precisa de `always()` para poder LER `skipped` dos `needs` e reprovar — e " +
      "desligá-lo (`always() && false`) o torna `skipped` ele mesmo, que a branch " +
      "protection lê como satisfeito.",
  },

  // --- os outros checks obrigatórios ------------------------------------------
  // Mesmo mecanismo, mesmo desfecho: `skipped` conta como check satisfeito.
  // Desligar qualquer um destes faz o PR entrar sem ter sido testado.
  "ci.yml::verify": {
    condicao: null,
    efeito: "Este é o check obrigatório `verify` (typecheck + lint + test:unit).",
  },
  "ci.yml::invariants": {
    condicao: null,
    efeito:
      "Este é o check obrigatório `invariants` (`pnpm test:db`) — o único que exercita o " +
      "`baseline.sql` que o self-hoster aplica, e o isolamento RLS entre organizações.",
  },
  "e2e.yml::e2e-parte": {
    condicao: null,
    efeito: "São as partes da matriz Playwright; sem elas o `e2e` fica sem nada para ler.",
  },
  "e2e.yml::e2e": {
    condicao: "always()",
    efeito:
      "Este é o check obrigatório `e2e`, a fachada da matriz. Precisa de `always()` para " +
      "ler o resultado das partes e reprovar `skipped`.",
  },
  "perf.yml::build-and-size": {
    condicao: null,
    efeito: "Este é o check obrigatório `build-and-size` (`pnpm build` em Node 22).",
  },

  // --- e o que legitimamente tem interruptor -----------------------------------
  "relogio.yml::tick": {
    condicao: "vars.RELOGIO_LIGADO == '1' || github.event_name == 'workflow_dispatch'",
    efeito:
      "Este é o relógio que bate o cron. A condição aqui é um interruptor DELIBERADO " +
      "(`vars.RELOGIO_LIGADO`), não uma adaptação de fork — mas ela fica no mapa para " +
      "que trocar a variável por outra coisa continue passando por revisão.",
  },
};

interface JobLido {
  arquivo: string;
  nome: string;
  linha: number;
  /** A expressão do `if:` na altura do job, normalizada — ou `null` se não há. */
  condicao: string | null;
}

/**
 * Os jobs de todo workflow, com a condição de disparo de cada um.
 *
 * Recorte por indentação: dentro de `jobs:`, um job é `  nome:` (dois espaços) e
 * o `if:` DELE é o de quatro espaços. `if:` de step vive a oito, e nenhuma outra
 * chave de job chega a quatro espaços com esse nome.
 */
function lerJobs(): JobLido[] {
  const achados: JobLido[] = [];

  for (const arquivo of readdirSync(DIR).filter((f) => /\.ya?ml$/.test(f)).sort()) {
    const brutas = readFileSync(join(DIR, arquivo), "utf8").split("\n");
    // Comentário não conta em NENHUMA direção: um `#` falando de `if:` não pode
    // satisfazer o mapa, e um `#` na coluna 0 no meio de `jobs:` não pode
    // encerrar a varredura. Zerar a linha preserva a numeração.
    const linhas = brutas.map((l) => (l.trimStart().startsWith("#") ? "" : l));

    const iJobs = linhas.findIndex((l) => /^jobs:\s*$/.test(l));
    if (iJobs === -1) continue;

    for (let i = iJobs + 1; i < linhas.length; i++) {
      const l = linhas[i]!;
      if (/^\S/.test(l)) break; // saiu do bloco `jobs:`
      const m = l.match(/^ {2}([A-Za-z0-9_-]+):\s*$/);
      if (!m) continue;

      let fim = linhas.length;
      for (let j = i + 1; j < linhas.length; j++) {
        if (/^\S/.test(linhas[j]!) || /^ {2}[A-Za-z0-9_-]+:\s*$/.test(linhas[j]!)) {
          fim = j;
          break;
        }
      }

      const corpo = linhas.slice(i + 1, fim);
      const k = corpo.findIndex((x) => /^ {4}if:/.test(x));
      let condicao: string | null = null;
      if (k !== -1) {
        // `if:` pode ser escalar de bloco (`>-`, `|`) com a expressão nas linhas
        // seguintes. Recolher a continuação mantém o valor inteiro visível na
        // comparação — e faz a forma dobrada divergir do mapa em vez de casar
        // com o prefixo dela.
        const partes = [corpo[k]!.replace(/^ {4}if:/, "")];
        for (let j = k + 1; j < corpo.length && /^ {6,}\S/.test(corpo[j]!); j++) {
          partes.push(corpo[j]!);
        }
        condicao = partes.join(" ").trim().replace(/\s+/g, " ");
      }

      achados.push({ arquivo, nome: m[1]!, linha: i + 1, condicao });
    }
  }

  return achados;
}

const jobs = lerJobs();
const chave = (j: JobLido) => `${j.arquivo}::${j.nome}`;
const legivel = (c: string | null) => (c === null ? "SEM `if:` de job" : `if: ${c}`);

describe("nenhum job pode ser desligado por uma condição — `skipped` conta como verde", () => {
  it("o instrumento está vivo: enxerga os jobs, e enxerga condição onde ela existe", () => {
    // Controle positivo. Sem ele, um recorte que parou de casar devolve lista
    // vazia, o mapa vira "todo elemento de nada", e o gate fica verde vigiando
    // nada — o modo de falha mais comum desta classe de teste.
    expect(jobs.length, "jobs lidos em .github/workflows").toBeGreaterThanOrEqual(10);
    expect(
      jobs.filter((j) => j.condicao !== null).map(chave).sort(),
      "o recorte de `if:` está cego — nenhuma condição foi lida, e o mapa passaria por vacuidade",
    ).not.toEqual([]);
    // E o inverso: se TUDO virasse condição, a comparação também seria inútil.
    expect(jobs.filter((j) => j.condicao === null).length).toBeGreaterThan(0);
  });

  it("todo job declara seu gatilho neste mapa — nenhum entra nem sai sem passar por aqui", () => {
    expect(
      jobs.map(chave).sort(),
      [
        "Um job apareceu ou sumiu em .github/workflows.",
        "Job novo: acrescente-o a GATILHO_ESPERADO com a condição dele (quase sempre",
        "`condicao: null`, que é o estado seguro) e uma frase dizendo o que se perde",
        "quando ele não roda. Job removido: tire a entrada.",
      ].join("\n"),
    ).toEqual(Object.keys(GATILHO_ESPERADO).sort());
  });

  it.each(Object.keys(GATILHO_ESPERADO).sort())(
    "%s dispara exatamente pela condição declarada — nada colado, nada negado",
    (nome) => {
      const esperado = GATILHO_ESPERADO[nome]!;
      const lido = jobs.find((j) => chave(j) === nome);
      expect(lido, `o job "${nome}" sumiu dos workflows. ${esperado.efeito}`).toBeDefined();

      expect(
        lido!.condicao,
        [
          `A condição de disparo de "${nome}" mudou.`,
          "",
          esperado.efeito,
          "",
          `  esperado: ${legivel(esperado.condicao)}`,
          `  lido:     ${legivel(lido!.condicao)}   (${lido!.arquivo}:${lido!.linha})`,
          "",
          "Um job com condição falsa não FALHA — ele não RODA, e `skipped` é lido como",
          "check satisfeito pela branch protection. O verde não significa nada aqui.",
          "",
          "Se a mudança é deliberada, atualize GATILHO_ESPERADO neste arquivo, com a razão.",
          "Se você está adaptando o repo para rodar num fork, faça isso NO fork — e não",
          "deixe a adaptação pegar carona no PR de volta (foi o caso do PR #458).",
        ].join("\n"),
      ).toBe(esperado.condicao);
    },
  );
});
