import { describe, expect, it } from "vitest";

import {
  BEFORE_SEND_CHAIN_VERSION,
  BEFORE_SEND_GATES,
} from "@/lib/agent-engine/guardrails/before-send";

/**
 * A trava de forma da cadeia `before_send` — o guarda que o cabeçalho do próprio
 * módulo já descrevia como existente.
 *
 * Ele afirma: *"mudar a ordem sem bumpar a versão quebra o CI — deixá-la mutável
 * em disco seria um footgun"*. **Não quebrava.** Medido em 2026-07-28:
 * `grep -rl "BEFORE_SEND_CHAIN_VERSION" --include="*.ts" .` devolvia apenas o
 * arquivo de definição. Nem a constante nem `BEFORE_SEND_GATES` eram referenciadas
 * por teste nenhum — a ordem que o cabeçalho chama de "invariante de segurança
 * (regra dura nº 2)" não era verificada por nada.
 *
 * Comentário é afirmação de terceiro, não evidência. Este arquivo é a frase virando
 * mecanismo.
 *
 * ⚠️ Ao MUDAR a cadeia de propósito (acrescentar gate, reordenar), este teste deve
 * vermelhar primeiro — é o sinal de que a mudança foi vista, não presumida. Atualize
 * `ORDEM_ESPERADA` e a versão **no mesmo commit** da mudança, nunca antes.
 */
const ORDEM_ESPERADA = [
  "stop",
  "lgpd",
  "pacing",
  "messaging_window",
  "spinning",
  "promise",
  "semantic_promise",
  "case_promise",
  "internal_vocabulary",
  "agenda_stall",
  "academia_grade_stall",
  "disclosure",
] as const;

describe("forma da cadeia before_send", () => {
  it("a ordem é exatamente esta — mudá-la é mudar comportamento de segurança", () => {
    expect(BEFORE_SEND_GATES.map((g) => g.name)).toEqual([...ORDEM_ESPERADA]);
  });

  it("stop é SEMPRE o primeiro — opt-out não se avalia depois de gastar janela", () => {
    // Regra dura nº 2 do módulo. Um stop avaliado em terceiro lugar deixaria
    // gates anteriores consumirem cap/janela de um contato que pediu para sair.
    expect(BEFORE_SEND_GATES[0]!.name).toBe("stop");
  });

  it("os dois gates de 'posso falar agora?' ficam lado a lado", () => {
    // pacing (auto-restrição: o canal me BANE) e messaging_window
    // (hetero-restrição: a plataforma me PROÍBE) são irmãos com física
    // invertida. Separá-los na cadeia esconderia o parentesco de quem lê.
    const nomes = BEFORE_SEND_GATES.map((g) => g.name);
    expect(nomes.indexOf("messaging_window")).toBe(nomes.indexOf("pacing") + 1);
  });

  it("lgpd vem antes de qualquer gate que gaste recurso", () => {
    const nomes = BEFORE_SEND_GATES.map((g) => g.name);
    expect(nomes.indexOf("lgpd")).toBeLessThan(nomes.indexOf("pacing"));
  });

  it("a versão acompanha a lista: mudou a cadeia, bumpa a versão", () => {
    // O par (tamanho, versão) é o que amarra os dois. Acrescentar um gate sem
    // bumpar deixa o trace de auditoria mentindo sobre qual cadeia rodou — e o
    // trace é justamente a prova que as Fases 0–2 usam para dizer "não regrediu".
    expect(BEFORE_SEND_GATES).toHaveLength(12);
    expect(BEFORE_SEND_CHAIN_VERSION).toBe(8);
  });

  it("internal_vocabulary roda ANTES do disclosure — inspeciona o texto do modelo, não o emendado", () => {
    // O disclosureGate pode EMENDAR o corpo (`amendBody`, modo inject). Se o gate de
    // vocabulário rodasse depois, ele julgaria um texto que o runtime costurou com o
    // template do tenant — e devolveria ao modelo a culpa por uma frase que não é dele.
    const nomes = BEFORE_SEND_GATES.map((g) => g.name);
    expect(nomes.indexOf("internal_vocabulary")).toBeLessThan(nomes.indexOf("disclosure"));
    expect(nomes.indexOf("internal_vocabulary")).toBe(nomes.indexOf("case_promise") + 1);
  });

  it("agenda_stall roda ANTES do disclosure e DEPOIS do internal_vocabulary — mesma razão: texto do modelo, não o emendado", () => {
    const nomes = BEFORE_SEND_GATES.map((g) => g.name);
    expect(nomes.indexOf("agenda_stall")).toBeLessThan(nomes.indexOf("disclosure"));
    expect(nomes.indexOf("agenda_stall")).toBe(nomes.indexOf("internal_vocabulary") + 1);
  });

  it("academia_grade_stall roda depois da agenda e antes do disclosure", () => {
    const nomes = BEFORE_SEND_GATES.map((g) => g.name);
    expect(nomes.indexOf("academia_grade_stall")).toBe(nomes.indexOf("agenda_stall") + 1);
    expect(nomes.indexOf("academia_grade_stall")).toBeLessThan(nomes.indexOf("disclosure"));
  });

  it("nenhum gate repetido — nome duplicado quebraria a leitura do trace", () => {
    const nomes = BEFORE_SEND_GATES.map((g) => g.name);
    expect(new Set(nomes).size).toBe(nomes.length);
  });
});
