import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * FIAÇÃO — Parte 1A do fechamento da grade semanal.
 *
 * Prova que o prompt da academia-grade instrui explicitamente o modelo a usar
 * request_human_handoff para exceções (feriado, data específica), e que o gate
 * academiaGradeStallGate está ligado na cadeia de before-send para barrar
 * respostas que afirmem horário sem consulta.
 *
 * Mesmo padrão de handoff-fernando-fiacao.test.ts: leitura estática do fonte,
 * não execução do turno. A fiação é a garantia de que o comportamento existe
 * antes de qualquer teste de integração.
 */
const FONTE_PROMPT = fs.readFileSync(
  path.join(process.cwd(), "lib/agent-engine/agent/academia-grade-prompt.ts"),
  "utf8",
);
const FONTE_GATE = fs.readFileSync(
  path.join(process.cwd(), "lib/agent-engine/guardrails/before-send.ts"),
  "utf8",
);

describe("fiação — academia-grade instrui handoff para exceções", () => {
  it("prompt menciona request_human_handoff para data específica ou feriado", () => {
    expect(FONTE_PROMPT).toMatch(/request_human_handoff/);
    expect(FONTE_PROMPT).toMatch(/feriado/);
    expect(FONTE_PROMPT).toMatch(/data espec[ií]fica/);
  });

  it("prompt instrui handoff IMEDIATO sem perguntar ao lead se pode encaminhar", () => {
    expect(FONTE_PROMPT).toMatch(/IMEDIATAMENTE/i);
    expect(FONTE_PROMPT).toMatch(/[Nn][Ã£]O\s+pergunte/i);
  });

  it("prompt instrui AVISAR o lead sobre a transferência antes de chamar request_human_handoff", () => {
    expect(FONTE_PROMPT).toMatch(/AVISE/i);
    expect(FONTE_PROMPT).toMatch(/passando|chamar uma pessoa|alguém do time/i);
  });

  it("prompt proíbe jargão técnico no aviso de handoff (preservar contexto, escalar, transferir conversa)", () => {
    expect(FONTE_PROMPT).toMatch(/[Nn][Ãã]O use termos t[eé]cnicos/i);
    expect(FONTE_PROMPT).toMatch(/preservar contexto/i);
  });

  it("prompt instrui chamar crm_find_academia_classes ANTES de perguntar período (manhã/tarde/noite)", () => {
    expect(FONTE_PROMPT).toMatch(/crm_find_academia_classes/);
    expect(FONTE_PROMPT).toMatch(/NESTE TURNO/i);
    expect(FONTE_PROMPT).toMatch(/manh[aã]|tarde|noite/i);
  });

  it("prompt proíbe inventar horário e manda consultar crm_find_academia_classes", () => {
    expect(FONTE_PROMPT).toMatch(/crm_find_academia_classes/);
    expect(FONTE_PROMPT).toMatch(/[Nn]ão invente/);
  });
});

describe("fiação — academiaGradeStallGate está na cadeia de before-send", () => {
  it("gate academia_grade_stall existe e verifica toolCalledThisTurn", () => {
    expect(FONTE_GATE).toMatch(/name:\s*['"]academia_grade_stall['"]/);
    expect(FONTE_GATE).toMatch(/toolCalledThisTurn/);
  });

  it("gate barra afirmação de horário de aula sem consulta (ACADEMIA_GRADE_HOUR_PATTERN)", () => {
    expect(FONTE_GATE).toMatch(/ACADEMIA_GRADE_HOUR_PATTERN/);
  });

  it("gate barra afirmação de funcionamento/horário sem consulta (ACADEMIA_GRADE_OPENING_PATTERN)", () => {
    expect(FONTE_GATE).toMatch(/ACADEMIA_GRADE_OPENING_PATTERN/);
    expect(FONTE_GATE).toMatch(/\b(abre|fecha|aberto|fechado|funciona|funcionamento|horario|expediente)\b/);
  });

  it("gate permite handoff quando explica limite de data específica ou feriado", () => {
    // O reason do gate deve mencionar encaminhamento para atendimento humano
    expect(FONTE_GATE).toMatch(/atendimento humano/);
  });
});