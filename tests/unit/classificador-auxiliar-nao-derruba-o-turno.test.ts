/**
 * FALHA DO CLASSIFICADOR AUXILIAR NÃO DEIXA O CLIENTE SEM RESPOSTA.
 *
 * ## O defeito que isto prende
 *
 * `classifyStage` e `classifyJailbreak` são os dois auxiliares que rodam ANTES
 * de o agente responder, e os dois são ADVISÓRIOS: um sugere o estágio do funil
 * (o modelo do agente é quem confirma, via `update_lead_state`), o outro só
 * FLAGRA a mensagem no trace — nunca vetou um inbound sozinho.
 *
 * Mesmo assim, a exceção de `runModelCall` subia dos dois. Como eles rodam no
 * `Promise.all` que abre `executarTurnoDoAgente`, qualquer falha deles matava o
 * turno inteiro: provedor fora do ar, modelo do ponto auxiliar apagado do painel
 * de provedores, chave da empresa revogada. O modelo do agente estava de pé e o
 * lead não recebia nada — e o caminho é o dominante, porque o ponto auxiliar
 * aponta para um modelo BARATO, normalmente diferente do modelo do agente, e o
 * classificador de estágio roda em TODO turno.
 *
 * ## As DUAS metades, e por que as duas estão aqui
 *
 * Degradar e propagar são propriedades opostas sobre o mesmo `catch`, e um teste
 * que só cobrisse a primeira ficaria verde com um `catch` que engole TUDO — o que
 * quebraria a escolta de orçamento (`comHandoffSeOrcamentoAcabar`), que existe
 * justamente porque os auxiliares são os primeiros a estourar o teto e é ela quem
 * passa a conversa para uma pessoa. Então cada classificador tem os dois casos:
 * falha comum → degrada; `LlmBudgetExceededError` → sobe.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";

import { classifyStage } from "../../lib/agent-engine/agent/stage-classifier";
import { classifyJailbreak } from "../../lib/agent-engine/guardrails/jailbreak/classifier";
import {
  LlmBudgetExceededError,
  LlmModelNotEnabledError,
  runModelCall,
} from "../../lib/agent-engine/edge/llm/run-model-call";
import type * as SeamDeModelo from "../../lib/agent-engine/edge/llm/run-model-call";
import type { Logger, LogFields } from "../../lib/agent-engine/obs/logger";
import type { LeadContext } from "../../lib/agent-engine/edge/crm/get-lead-context";

// `importOriginal` de propósito: as CLASSES de erro precisam ser as reais, senão
// o `instanceof` do código sob teste compararia contra outro módulo e o caso de
// orçamento passaria por acidente.
vi.mock("../../lib/agent-engine/edge/llm/run-model-call", async (importOriginal) => {
  const real =
    await importOriginal<typeof SeamDeModelo>();
  return { ...real, runModelCall: vi.fn() };
});

const chamada = vi.mocked(runModelCall);

function logSpy(): { log: Logger; warns: Array<{ msg: string; fields?: LogFields }> } {
  const warns: Array<{ msg: string; fields?: LogFields }> = [];
  return {
    warns,
    log: {
      info: () => {},
      warn: (msg: string, fields?: LogFields) => warns.push({ msg, ...(fields ? { fields } : {}) }),
      error: () => {},
    },
  };
}

const db = {} as never;
const cfg = {} as never;
const ids = { tenantId: "org-1", leadId: "contact-1", jobId: "job-1" };
const contexto = { messages: [] } as unknown as LeadContext;

beforeEach(() => {
  chamada.mockReset();
});

describe("classificador de estágio — advisório de verdade", () => {
  it("falha do fornecedor degrada para null (sem sugestão) em vez de subir", async () => {
    chamada.mockRejectedValue(new LlmModelNotEnabledError("modelo-que-sumiu-do-painel"));
    const { log, warns } = logSpy();

    const sugestao = await classifyStage(
      db,
      cfg,
      ids,
      { context: contexto, currentStage: "new" },
      { log },
    );

    expect(sugestao).toBeNull();
    expect(warns.map((w) => w.msg)).toContain(
      "stage-classifier falhou — turno segue sem sugestão de estágio",
    );
  });

  it("estouro de orçamento SOBE — a escolta do turno é quem faz a passagem", async () => {
    chamada.mockRejectedValue(new LlmBudgetExceededError());
    const { log } = logSpy();

    await expect(
      classifyStage(db, cfg, ids, { context: contexto, currentStage: "new" }, { log }),
    ).rejects.toBeInstanceOf(LlmBudgetExceededError);
  });
});

describe("classificador anti-jailbreak — advisório de verdade", () => {
  it("falha do fornecedor degrada para o veredito limpo em vez de subir", async () => {
    chamada.mockRejectedValue(new Error("upstream 503"));
    const { log, warns } = logSpy();

    const veredito = await classifyJailbreak(db, cfg, ids, { message: "quanto custa?" }, { log });

    // `falhou`: o `none` é o degrade, não um veredito — quem soma outro sinal
    // ao dele (o Jev) precisa da diferença.
    expect(veredito).toEqual({ flag: false, level: "none", reason: null, falhou: true });
    expect(warns.map((w) => w.msg)).toContain(
      "jailbreak: classificador falhou — turno segue sem sinal",
    );
  });

  it("estouro de orçamento SOBE — a escolta do turno é quem faz a passagem", async () => {
    chamada.mockRejectedValue(new LlmBudgetExceededError());
    const { log } = logSpy();

    await expect(
      classifyJailbreak(db, cfg, ids, { message: "quanto custa?" }, { log }),
    ).rejects.toBeInstanceOf(LlmBudgetExceededError);
  });
});

describe("o warn do degrade não carrega PII", () => {
  it("a mensagem do lead nunca entra nos campos do log do jailbreak", async () => {
    chamada.mockRejectedValue(new Error("upstream 503"));
    const { log, warns } = logSpy();
    const segredoDoLead = "meu cpf é 123.456.789-00 e moro na rua tal";

    await classifyJailbreak(db, cfg, ids, { message: segredoDoLead }, { log });

    expect(JSON.stringify(warns)).not.toContain(segredoDoLead);
  });
});
