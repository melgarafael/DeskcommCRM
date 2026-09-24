import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * QUEM AGENDA "PARA AGORA" TEM DE USAR O RELÓGIO DO BANCO.
 *
 * ═══ O DEFEITO QUE ESTA GUARDA EXISTE PARA IMPEDIR ═══
 *
 * `next_eval_at` era gravado com o relógio do PROCESSO (`new Date()` em Node) e
 * o claim compara com `now()` do POSTGRES. Medido: o banco fica 17–34 ms atrás.
 * O "agora" do processo ainda é FUTURO para o claim, o tick seguinte não
 * reclama, e o enrollment espera o tick DEPOIS — até 60 s, com o cron de minuto
 * em minuto. Em `reactivity.ts` isso é um minuto de silêncio depois que o lead
 * respondeu.
 *
 * ═══ POR QUE ESTA GUARDA TEM DOIS LADOS ═══
 *
 * O lado COMPORTAMENTAL (o arquivo irmão, contra Postgres real) prova que os
 * produtores de hoje gravam o instante certo. Ele cobre INSTÂNCIAS: os
 * produtores que existem. O quarto produtor, escrito daqui a um mês, não está
 * na lista dele e ele não sabe que nasceu — que foi exatamente o que aconteceu
 * quando `gatilho-etapa.ts` nasceu, no mesmo dia em que este defeito estava
 * sendo consertado, já com ele dentro.
 *
 * O lado ESTÁTICO (este arquivo) fecha a CLASSE: todo módulo que escreve
 * `next_eval_at` precisa estar declarado abaixo, dizendo se agenda para AGORA
 * (e então deve usar o relógio do banco) ou para o FUTURO (e então o relógio do
 * processo é inofensivo — 30 ms de desvio num intervalo de minutos não muda
 * nada, e reprovar isso seria falso positivo em código correto, do tipo que a
 * equipe desliga em uma semana).
 *
 * ⚠️ ISTO NÃO IMPEDE O ERRO — TORNA IMPOSSÍVEL COMETÊ-LO EM SILÊNCIO. É o mesmo
 * padrão de `tests/unit/navegacao-completude.test.ts`, que reprova tela sem
 * porta e aceita allowlist com justificativa escrita. Módulo novo que escreva
 * `next_eval_at` derruba este teste e obriga quem o escreveu a se declarar.
 *
 * ⚠️ POR QUE A LISTA É DE ESCRITORES, E NÃO DE PADRÕES SUSPEITOS. A primeira
 * versão desta guarda procurava a EXPRESSÃO do defeito (`next_eval_at:
 * clock()`), e ela achou 9 ocorrências e PERDEU 2 que eu sabia existirem — as
 * de `gatilho-etapa.ts` e `silence-sweep.ts`, onde o valor passa por uma
 * variável intermediária (`const agoraIso = clock()...`). Uma guarda assim dá a
 * sensação de classe fechada cobrindo 80%, e isso é pior que declarar cobertura
 * parcial: a próxima pessoa confia numa rede que tem buraco. Enumerar QUEM
 * escreve não tem falso-negativo por sintaxe.
 */

const DIR = join(process.cwd(), "lib", "followup");

/**
 * Todo módulo de `lib/followup` que escreve `next_eval_at`, e o que ele agenda.
 *
 * `agenda` = 'agora'  → precisa do relógio do BANCO (default `now()` no insert,
 *                       ou `fn_agora()` no update). Ver migration 0147.
 * `agenda` = 'futuro' → relógio do processo é aceitável: o desvio é
 *                       irrelevante diante do intervalo.
 * `agenda` = 'nenhum' → menciona a coluna sem agendar (leitura, tradução).
 */
const ESCRITORES: Record<string, { agenda: "agora" | "futuro" | "nenhum"; nota: string }> = {
  "enroll.ts": {
    agenda: "agora",
    nota: "o enrollment nasce vencido — o insert omite next_eval_at e o default now() do banco decide (0147).",
  },
  "gatilho-etapa.ts": {
    agenda: "agora",
    nota: "o enrollment nasce vencido — o insert omite a coluna e o default now() do banco decide (0147).",
  },
  "gatilho-lead.ts": {
    agenda: "agora",
    nota: "o enrollment nasce vencido — o insert omite a coluna e o default now() do banco decide (0147). A menção no tipo é o campo opcional, igual ao gatilho de etapa.",
  },
  "gatilho-retorno.ts": {
    agenda: "agora",
    nota: "o enrollment nasce vencido — o insert omite a coluna e o default now() do banco decide (0147).",
  },
  "silence-sweep.ts": {
    agenda: "agora",
    nota: "mesmo caso do gatilho de etapa: nasce vencido, insert omite a coluna.",
  },
  "gatilho-caso.ts": {
    agenda: "nenhum",
    nota:
      "O INSERT omite a coluna (default now() do banco, igual ao gatilho de etapa). A única " +
      "menção é `next_eval_at: null` no cancelamento por caso fechado — desagendar não é agendar, " +
      "e `null` não tem relógio para escolher errado.",
  },
  "atendimento.ts": {
    agenda: "nenhum",
    nota:
      "O roteiro de atendimento (0394) nasce 'coletando' com `next_eval_at` NULO de propósito: " +
      "ele é conduzido pelo turno do agente e não tem relógio (o CHECK `relogio_coerente` o põe " +
      "no grupo sem relógio). Omitir a coluna daria o default now() — nulo é não agendar.",
  },
  "aplicar-inbound.ts": {
    agenda: "nenhum",
    nota:
      "NÃO escreve: a única menção é `.lte('next_eval_at', agora)`, um FILTRO para pegar os " +
      "enrollments já vencidos. O `agora` é o relógio do processo, e aqui isso é aceitável de " +
      "propósito — num filtro, relógio adiantado pega um enrollment alguns segundos cedo e " +
      "atrasado o deixa para o tique seguinte; nenhum dos dois grava data errada, que é o que " +
      "a 0147 existe para impedir.",
  },
  "reactivity.ts": {
    agenda: "agora",
    nota: "'acorde agora' quando o lead responde. É UPDATE, então default não alcança: usa fn_agora().",
  },
  "turn-bridge.ts": {
    agenda: "agora",
    nota:
      "PENDENTE (dono: DevVivo). Três escritas de 'avance agora' com o relógio do processo " +
      "(linhas ~120, ~136, ~163). Mesmo defeito, ainda não consertado — declarado aqui para ficar " +
      "visível em vez de escondido.",
  },
  "node-handlers.ts": {
    agenda: "agora",
    nota:
      "PENDENTE (dono: DevVivo/Arquiteto). Cinco `advance` com next_eval_at = clock() (~254, ~262, " +
      "~290, ~297, ~313). O mesmo arquivo TAMBÉM agenda para o futuro (wait/recheck), e essas são " +
      "legítimas — por isso a classificação é do módulo, e a nota diz onde está a dívida.",
  },
  "engine.ts": {
    agenda: "futuro",
    nota: "backoff de retry e grace do classify — intervalos de minutos, o desvio é irrelevante.",
  },
  "intervencao.ts": {
    agenda: "futuro",
    nota: "retomada de pausa manual: agenda o restante do adiamento, sempre no futuro.",
  },
  "eventos-legiveis.ts": {
    agenda: "nenhum",
    nota: "traduz o campo para a timeline do dossiê; não escreve.",
  },
};

function modulosQueMencionam(): string[] {
  return readdirSync(DIR)
    .filter((f) => f.endsWith(".ts") && !f.includes(".test."))
    .filter((f) => readFileSync(join(DIR, f), "utf8").includes("next_eval_at"))
    .sort();
}

describe("agendamento de follow-up — todo escritor de next_eval_at está declarado", () => {
  it("nenhum módulo escreve next_eval_at sem se declarar (módulo novo derruba este teste)", () => {
    const naoDeclarados = modulosQueMencionam().filter((f) => !(f in ESCRITORES));
    expect(
      naoDeclarados,
      "Módulo novo mexendo em next_eval_at. Declare-o em ESCRITORES dizendo se agenda para AGORA " +
        "(e então use o relógio do BANCO — default now() no insert ou fn_agora() no update, migration 0147) " +
        "ou para o FUTURO (e então o relógio do processo serve). Ver o cabeçalho deste arquivo.",
    ).toEqual([]);
  });

  it("a declaração não envelhece: módulo que saiu da pasta não fica listado", () => {
    const presentes = new Set(modulosQueMencionam());
    const fantasmas = Object.keys(ESCRITORES).filter((f) => !presentes.has(f));
    expect(
      fantasmas,
      "Declarado em ESCRITORES mas não mexe mais em next_eval_at — remova a entrada, senão a lista " +
        "vira arquivo morto e a próxima pessoa confia num inventário que não corresponde ao código.",
    ).toEqual([]);
  });

  it("a dívida conhecida está NOMEADA, não escondida — quem agenda 'agora' e ainda não usa o banco", () => {
    // Este caso não reprova a dívida: ele a CONGELA. Enquanto `turn-bridge.ts` e
    // `node-handlers.ts` estiverem com o relógio do processo, a nota deles tem
    // de dizer PENDENTE e quem é o dono. Consertar sem tirar o rótulo derruba
    // aqui — que é o lembrete de fechar o registro junto com o código.
    const pendentes = Object.entries(ESCRITORES)
      .filter(([, v]) => v.agenda === "agora" && v.nota.includes("PENDENTE"))
      .map(([f]) => f)
      .sort();
    expect(pendentes).toEqual(["node-handlers.ts", "turn-bridge.ts"]);
  });
});
