import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  cobrarFrases,
  descrever,
  lerMapaDeMotivos,
  varrerMotivosDeParada,
  type DeclaracaoDeOrigem,
} from "./helpers/motivos-de-parada";

/**
 * TODO MOTIVO QUE A AÇÃO PODE EMITIR TEM FRASE NA TELA.
 *
 * ─── O defeito que originou esta guarda (issue #1090) ───────────────────────
 *
 * A aba Atividade traduz o `detail.reason` de cada ação por um mapa escrito à
 * mão (`MOTIVO_DA_PARADA`, em `app/app/webhooks/_components/ActivityTab.tsx`).
 * Mapa e código moram em arquivos diferentes, e nada ligava os dois: o dia em
 * que `assign_owner` passou a emitir `membro_indeterminado` (PR #1010), o mapa
 * não soube, e quem opera a automação passou a ler `membro_indeterminado` — o
 * CÓDIGO — no lugar de uma frase. Nada falhou: não havia teste para falhar.
 *
 * ─── Por que este desenho ──────────────────────────────────────────────────
 *
 * A guarda não lista motivos: ela VARRE os arquivos que os emitem e cobra o
 * mapa, chave a chave. Motivo novo entra no código → reprova aqui, no mesmo
 * commit, com arquivo e linha de quem o emitiu. É a diferença entre "vigiar a
 * lista de hoje" (que envelhece no primeiro PR) e "vigiar o código que emite".
 *
 * O que ela cobra:
 *
 *   - `detail.reason` literal (o canal principal) → precisa de frase no mapa;
 *   - `error` literal com cara de código (`user_not_in_org`) → idem: é o que o
 *     ramo de falha da tela imprime quando não há detalhe;
 *   - motivo DINÂMICO (`guarda.reason`, `acesso.motivo`, …) → precisa de uma
 *     `ORIGENS` abaixo dizendo de onde ele vem, com `porque` escrito. Quem não
 *     está declarado reprova, e declaração que o código não usa mais também —
 *     a lista só encolhe.
 *
 * O que ela NÃO cobra, e é de propósito:
 *
 *   - mensagem crua de erro (`error.message`, `result.message`, `String(err)`):
 *     por contrato é texto de gente, não código, e é isso que a tela deve
 *     mostrar. A fronteira está escrita no helper;
 *   - resultado que traz `detail.explicacao`: quem monta o desfecho já escreveu
 *     a frase (`lib/automation/desfecho-do-envio.ts`).
 *
 * ─── O que ela NÃO prova ───────────────────────────────────────────────────
 *
 * Ela compara CHAVES, não o texto renderizado: um mapa com chave e frase vazia
 * passaria — por isso o `it` de frase vazia abaixo. E ela não entra em
 * `lib/ai`/`lib/agent-engine` por conta própria: o que sai de lá chega ao mapa
 * pela origem declarada, um caso por vez, com o motivo escrito.
 */

const RAIZ = join(__dirname, "..", "..");
const TELA = "app/app/webhooks/_components/ActivityTab.tsx";
const RAIZ_DAS_FIXTURES = "tests/fixtures/catraca-do-motivo-de-parada";

/** Onde nascem os motivos de parada de verdade. */
const AREAS_QUE_EMITEM = ["lib/automation"];

const COMO_CONSERTAR =
  "Conserto: uma linha no mapa MOTIVO_DA_PARADA em " +
  `${TELA}, no formato motivo: "frase em português", e a mesma frase em ` +
  'lib/i18n/dicionario.ts como "frase em português": { es: "frase en español" }. ' +
  "Se o motivo não deveria chegar à tela (identificador de wire), tire-o do `detail.reason`. " +
  "Confira com: pnpm test:unit tests/unit/motivo-de-parada-tem-frase.test.ts";

/**
 * Motivos que chegam à tela sem passar por um literal neste diretório, um a um,
 * com o `porque` escrito. Cada `produtor` é varrido: os códigos que ele pode
 * devolver entram na cobrança como se estivessem aqui.
 */
const ORIGENS: DeclaracaoDeOrigem[] = [
  {
    arquivo: "lib/automation/actions/send-ai-message.ts",
    expressao: "guarda.reason",
    porque:
      "o veredito do guarda-do-contato é devolvido como `reason` do resultado; os códigos possíveis são varridos no produtor declarado ao lado",
    produtor: { arquivo: "lib/automation/guarda-do-contato.ts" },
  },
  {
    arquivo: "lib/automation/actions/send-whatsapp.ts",
    expressao: "guarda.reason",
    porque:
      "mesma guarda compartilhada da ação de IA: o código do bloqueio chega pelo `reason` do resultado, e o produtor é o mesmo arquivo",
    produtor: { arquivo: "lib/automation/guarda-do-contato.ts" },
  },
  {
    arquivo: "lib/automation/actions/send-ai-message.ts",
    expressao: "acesso.motivo",
    porque:
      "o pré-go-live do canal devolve `motivo` quando o número não pode ser testado; os códigos possíveis vêm do produtor declarado ao lado",
    produtor: { arquivo: "lib/ai/elegibilidade/consulta-pre-go-live.ts" },
  },
  {
    arquivo: "lib/automation/actions/send-ai-message.ts",
    expressao: "gerado.reason",
    porque:
      "o texto gerado pelo agente devolve `reason` quando não há versão publicada ou o modelo não devolveu texto; o resultado o usa nos dois canais (detalhe e erro)",
    produtor: { arquivo: "lib/agent-engine/agent/abordagem-de-formulario.ts" },
  },
  {
    arquivo: "lib/automation/actions/create-task.ts",
    expressao: "resultado.codigo",
    porque:
      "a recusa da tarefa (sem alvo, sem dono, título vazio, falha de gravação) chega à tela pelo `reason` do resultado; os códigos possíveis são quatro e estão escritos no tipo ResultadoDaTarefa",
    produtor: { arquivo: "lib/tarefas/criar-tarefa.ts" },
  },
  {
    arquivo: "lib/automation/actions/apply-task-plan.ts",
    expressao: "resultado.codigo",
    porque:
      "a recusa do PLANO de tarefas (#1752 — plano inexistente, sem alvo, sem dono, título vazio, falha de gravação) chega à tela pelo `reason` do resultado; os códigos possíveis estão escritos no tipo CodigoDaAplicacao",
    produtor: { arquivo: "lib/tarefas/plano.ts" },
  },
  {
    arquivo: "lib/automation/actions/ai-decide.ts",
    expressao: "decisao.motivo",
    porque:
      "a resposta da IA que não virou escolha (JSON vazio, sem JSON, escolha ausente ou fora do conjunto) chega aos dois canais pelo `reason` da decisão; os códigos possíveis são escritos no tipo MotivoDaDecisao, no produtor declarado ao lado",
    produtor: { arquivo: "lib/automation/decider.ts" },
  },
];

describe("o mapa de frases e o código que emite os motivos não podem divergir", () => {
  /**
   * Uma varredura só para o `describe` inteiro: ela lê e parseia dezenas de
   * arquivos, e repetir por `it()` seria caro sem cobrar nada a mais.
   */
  const mapa = lerMapaDeMotivos(RAIZ, TELA);
  const varredura = varrerMotivosDeParada({ raizDoProjeto: RAIZ, raizes: AREAS_QUE_EMITEM });
  const cobranca = cobrarFrases(varredura, mapa, ORIGENS, RAIZ);

  const motivosDoMapa = [...mapa.keys()];

  it("a varredura enxerga de verdade — o verde abaixo não é vacuidade", () => {
    expect(varredura.arquivosVarridos, "nenhum arquivo varrido: o caminho das ações mudou?").toBeGreaterThan(
      10,
    );
    expect(
      varredura.resultados,
      "nenhum resultado de ação encontrado: a regra deixou de casar com o produto",
    ).toBeGreaterThan(30);
    expect(mapa.size, "o mapa MOTIVO_DA_PARADA saiu da tela").toBeGreaterThan(5);
    // O caso da #1090: se ele deixar de ser emitido, esta guarda perde o dente.
    expect(
      varredura.literais.map((o) => o.motivo),
      "a ação assign_owner deixou de emitir membro_indeterminado",
    ).toContain("membro_indeterminado");
  });

  it("nenhum motivo emitido pelas ações chega à tela sem frase no mapa", () => {
    const semFrase = descrever(cobranca.faltando);
    expect(
      cobranca.faltando.length,
      `${cobranca.faltando.length} motivo(s) sem frase: quem opera lê o CÓDIGO cru na aba Atividade.\n` +
        `${semFrase}\n${COMO_CONSERTAR}`,
    ).toBe(0);
  });

  it("nenhuma origem dinâmica de motivo sem declaração em ORIGENS", () => {
    const semDeclaracao = cobranca.dinamicasSemDeclaracao.map(
      (d) => `${d.arquivo}:${d.linha} → ${d.expressao} (canal ${d.canal})`,
    );
    expect(
      semDeclaracao,
      `${semDeclaracao.length} motivo(s) que a guarda não sabe cobrar: declare a origem em ORIGENS, ` +
        `neste arquivo, com o \`porque\` escrito e o produtor varrido.\n  ${semDeclaracao.join("\n  ")}`,
    ).toEqual([]);
  });

  it("declaração que o código não usa mais é vermelho — a lista só encolhe", () => {
    expect(cobranca.declaracoesQuebradas).toEqual([]);
  });

  it("nenhuma frase do mapa está vazia (chave presente não basta)", () => {
    const vazias = motivosDoMapa.filter((motivo) => (mapa.get(motivo) ?? "").trim().length < 10);
    expect(
      vazias,
      `frase vazia ou curta demais para ${vazias.length} motivo(s) do mapa: a tela mostraria nada.`,
    ).toEqual([]);
  });
});

describe("dente da catraca: a fixture prova os dois lados", () => {
  const mapa = lerMapaDeMotivos(RAIZ, TELA);

  it("fixture VERDE passa: motivo com frase no mapa e desfecho que traz a própria frase", () => {
    const varredura = varrerMotivosDeParada({
      raizDoProjeto: RAIZ,
      raizes: [`${RAIZ_DAS_FIXTURES}/verde`],
    });
    expect(
      varredura.arquivosVarridos,
      "a fixture verde não foi varrida: o caminho mudou?",
    ).toBe(1);
    expect(
      varredura.resultados,
      "a fixture verde não produziu resultado de ação: a regra sob teste não foi exercitada",
    ).toBe(2);
    expect(cobrarFrases(varredura, mapa, [], RAIZ).faltando).toEqual([]);
  });

  it("fixture VERMELHA reprova no motivo novo sem frase, com arquivo:linha", () => {
    const varredura = varrerMotivosDeParada({
      raizDoProjeto: RAIZ,
      raizes: [`${RAIZ_DAS_FIXTURES}/vermelha`],
    });
    const faltando = cobrarFrases(varredura, mapa, [], RAIZ).faltando;
    expect(faltando.map((o) => o.motivo).sort()).toEqual([
      "motivo_novo_sem_frase",
      "outro_motivo_sem_frase",
    ]);
    for (const ocorrencia of faltando) {
      expect(ocorrencia.arquivo).toBe(`${RAIZ_DAS_FIXTURES}/vermelha/acao.ts`);
      expect(ocorrencia.linha, "a linha do motivo tem de apontar para o arquivo da fixture").toBeGreaterThan(
        0,
      );
    }
    // A mensagem de falha é parte do gate: ela diz ONDE consertar e COMO conferir.
    expect(COMO_CONSERTAR).toContain(TELA);
    expect(COMO_CONSERTAR).toContain("lib/i18n/dicionario.ts");
    expect(COMO_CONSERTAR).toContain("pnpm test:unit");
  });
});
