import { describe, expect, it } from "vitest";

import { blocosDeAgendaResidentes } from "@/lib/agent-engine/agent/inbound-turn";

/**
 * O ENSINO da agenda que cada agente recebe — e a cadeia de dois passos que
 * faltava (#1019).
 *
 * Medido no relato: com "Ver o que a empresa atende", "Ver horários livres na
 * agenda" e "Marcar consulta ou sessão" ligados, o agente chamou
 * `crm_list_event_types` 4 vezes COM o slug disponível na resposta e nenhuma vez
 * `crm_find_free_slots` na sequência (as três primeiras chamadas da amostra
 * eram de um tipo que ainda não existia, e ficaram de fora da conta). O bloco
 * residente nomeava `crm_find_free_slots` em toda frase e `crm_list_event_types`
 * em nenhuma: os dois passos da cadeia só apareciam na `description` da própria
 * ferramenta.
 *
 * A régua que este arquivo guarda: **o bloco da CADEIA é condicional**, porque
 * ele nomeia duas ferramentas e o agente precisa ter as duas — nomear uma
 * ferramenta ausente faz o modelo tentar chamá-la (é por isso que o bloco de
 * "só consulta" existe separado do de marcar).
 */
const LIST = "crm_list_event_types";
const FIND = "crm_find_free_slots";
const BOOK = "crm_book_appointment";

describe("blocos de agenda residentes", () => {
  it("⭐ o agente do relato (listar + horários + marcar) recebe a CADEIA, nomeando os dois passos", () => {
    const blocos = blocosDeAgendaResidentes([LIST, FIND, BOOK]);
    const cadeia = blocos.find((b) => b.includes(LIST));
    expect(cadeia, "nenhum bloco nomeia crm_list_event_types — a cadeia não é ensinada").toBeDefined();
    // O passo do meio é o que o modelo precisa enxergar: o slug vem da lista e
    // vai para a consulta, no MESMO turno.
    expect(cadeia).toContain(FIND);
    expect(cadeia).toContain("slug");
    expect(cadeia).toContain("MESMO TURNO");
  });

  it("quem só consulta (listar + horários, sem marcar) também recebe a cadeia", () => {
    const blocos = blocosDeAgendaResidentes([LIST, FIND]);
    expect(blocos).toHaveLength(2);
    expect(blocos.some((b) => b.includes(LIST))).toBe(true);
  });

  it("sem `crm_list_event_types` não há cadeia — o primeiro passo não existe para ele", () => {
    for (const ids of [[FIND], [FIND, BOOK], [BOOK]]) {
      const blocos = blocosDeAgendaResidentes(ids);
      expect(blocos.some((b) => b.includes(LIST)), `ids=${ids.join(",")}`).toBe(false);
    }
  });

  it("com a lista mas SEM quem consome o slug, a cadeia também não entra", () => {
    // Não há segundo passo: ensinar a cadeia a quem não tem `crm_find_free_slots`
    // é o defeito que a divisão dos blocos existe para evitar. (O bloco de
    // MARCAR, que ele recebe por ter `crm_book_appointment`, menciona a
    // ferramenta de horários — mas quem ENSINA o encadeamento é o bloco da
    // cadeia, e é ele que não entra.)
    expect(blocosDeAgendaResidentes([LIST])).toEqual([]);
    expect(blocosDeAgendaResidentes([LIST, BOOK]).some((b) => b.includes(LIST))).toBe(false);
  });

  it("agente sem agenda nenhuma não recebe bloco de agenda", () => {
    expect(blocosDeAgendaResidentes(["crm_list_pipelines", "search_knowledge"])).toEqual([]);
    expect(blocosDeAgendaResidentes([])).toEqual([]);
  });

  it("o bloco da cadeia só nomeia ferramentas que o agente tem", () => {
    const cadeia = blocosDeAgendaResidentes([LIST, FIND, BOOK]).find((b) => b.includes(LIST));
    if (cadeia === undefined) throw new Error("inalcançável");
    const nomeadas = [...cadeia.matchAll(/crm_[a-z_]+/g)].map((m) => m[0]);
    expect(new Set(nomeadas)).toEqual(new Set([LIST, FIND]));
  });

  it("nenhum bloco devolvido é vazio (guarda de vacuidade)", () => {
    for (const ids of [[LIST, FIND, BOOK], [LIST, FIND], [FIND], [BOOK]]) {
      for (const bloco of blocosDeAgendaResidentes(ids)) {
        expect(bloco.trim().length, `ids=${ids.join(",")}`).toBeGreaterThan(0);
      }
    }
  });
});


it.each([['crm_cancel_appointment'],['crm_reschedule_appointment'],['crm_list_appointments'],[BOOK,FIND]])
('o agente recebe limite individual antes de comunicar a agenda: %j',(...ids)=>{
 const text=blocosDeAgendaResidentes(ids).join('\n');
 expect(text).toContain('não um inventário de toda a agenda');
 expect(text).toContain('não comprova a ausência');
 expect(text).toContain('não sustenta afirmações sobre os');
 expect(text).toContain('Não altere nem');
});
