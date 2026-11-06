/**
 * REMARCAR não pode competir com MARCAR NA DESCRIÇÃO das ferramentas.
 *
 * O defeito medido (rig de aceite, teste 10 do salão, 2026-10-26, job
 * 6615eeb0): a cliente pediu para mudar uma manicure de 29/10 para
 * "sexta dia 30/10 às 9h" — dia E hora na mesma frase — e o modelo chamou
 * `crm_find_and_book_appointment`, criando uma SEGUNDA consulta enquanto a
 * original ficou intacta (duplicata na agenda).
 *
 * A causa não foi o prompt: o bloco REMARCAR do v15 já mandava "passo 1:
 * crm_list_appointments sem `dia`… passo 3: crm_reschedule_appointment". O
 * conflito estava na FERRAMENTA, que o modelo lê no momento da escolha:
 *
 *  - `crm_find_and_book_appointment` dizia "é o caminho preferido" para
 *    "cliente JÁ disse dia E hora" — exatamente o caso — e não tinha nenhuma
 *    ressalva de remarcação;
 *  - `crm_reschedule_appointment` pedia `appointment_id` sem dizer de onde ele
 *    vem (a irmã `crm_confirm_appointment` diz: "vindo de crm_list_appointments"),
 *    então o caminho certo parecia ter uma peça faltando — e o modelo nem tentou.
 *
 * Este gate cobre as duas descrições: quem lê a de marcar precisa ser mandado
 * de volta para a de remarcar, e quem lê a de remarcar precisa saber como achar
 * o id (a pergunta que o id não sobrevive entre turnos torna obrigatória —
 * causa raiz provada na v13 do harness).
 */
import { describe, expect, it } from "vitest";

import {
  crmBookAppointment,
  crmFindAndBookAppointment,
  crmFindFreeSlots,
  crmListAppointments,
  crmRescheduleAppointment,
} from "@/lib/mcp/tools/agendamento";

describe("a descrição de marcar empurra quem deve remarcar para a ferramenta certa", () => {
  it("⭐ find_and_book não se declara caminho preferido sem mandar remarcar de volta", () => {
    const d = crmFindAndBookAppointment.description;
    // A frase que o modelo obedeceu no teste 10 ("é o caminho preferido") só é
    // aceita AO LADO da ressalva: sem ela, a ferramenta vence o prompt.
    if (d.includes("caminho preferido")) {
      expect(d).toMatch(/remarc/i);
      expect(d).toContain("crm_reschedule_appointment");
    }
    // De qualquer forma, a ressalva precisa existir — mesmo sem a frase acima.
    expect(d).toMatch(/remarc/i);
    expect(d).toContain("crm_reschedule_appointment");
  });

  it("⭐ find_and_book diz para NÃO usar quando já existe compromisso marcado", () => {
    // O gatilho é a EXISTÊNCIA do compromisso, não a forma da frase: a cliente
    // pode dizer "muda minha manicure pra sexta" sem repetir dia e hora.
    expect(crmFindAndBookAppointment.description).toMatch(
      /j[áa].*compromisso.*(marcado|existe)|compromisso j[áa] marcado/i,
    );
  });

  it("reschedule diz de onde vem o appointment_id — e o id não sobrevive sozinho", () => {
    const d = crmRescheduleAppointment.description;
    expect(d).toContain("crm_list_appointments");
    // Sem `dia`: o dia chutado devolve lista vazia (medido nos turnos 1 e 2 do
    // teste 10 — 34 bytes — enquanto o compromisso estava noutro dia).
    const id = (crmRescheduleAppointment.inputSchema as { appointment_id: { description?: string } })
      .appointment_id;
    expect(id.description ?? "").toContain("crm_list_appointments");
    expect(id.description ?? "").toContain("sem `dia`");
  });

  // ── Rodada 2 (26/10, tarde): a remarcação AGORA é roteada certa, mas MORRE ──
  // no meio. Dois pontos medidos com o fixture já corrigido:
  it("⭐ find_free_slots ensina a RECEITA da remarcação no momento em que é chamada", () => {
    // Job 6b379150 (turno 2 do teste 10): no pedido de remarcacao o modelo
    // chamou find_free_slots (passo 2) SEM o passo 1 e ofereceu "Tenho sexta
    // dia 30/10 às 09h disponível. Quer confirmar esse horário?" — exatamente a
    // pegadinha que o próprio prompt v15 avisa ("fecha com PERGUNTA DE AÇÃO,
    // nunca com 'confirma?'"), porque a descrição mandava "use ANTES de oferecer
    // horário" sem ramo de remarcação. A descrição é lida NA HORA da escolha;
    // o prompt mora 30 mil tokens atrás.
    const d = crmFindFreeSlots.description;
    expect(d).toMatch(/remarc/i);
    expect(d).toContain("crm_list_appointments");
    expect(d).toContain("crm_reschedule_appointment");
    // A pergunta de ação é o contrato com o turno do aceite: sem ela, o "pode
    // confirmar as 9h" da cliente não mapeia em "mover agora".
    expect(d).toContain("posso aplicar");
    // E o aceite tem que MOVER nesta resposta, não oferecer de novo.
    expect(d).toMatch(/mesma resposta/i);
  });

  it("⭐ list_appointments diz que na remarcação a lista NÃO é o fim do turno", () => {
    // Job 4504bb25 (turno 3, na correção): o modelo localizou o compromisso
    // (passo 1) e PAROU — mandou a oferta de novo em vez de mover, e a agenda
    // ficou no dia antigo. Parar-depois-da-lista é o ponto exato em que o
    // turno morre; o "se a agenda não mudou, avise" da correção deu licença.
    const d = crmListAppointments.description;
    expect(d).toMatch(/remarc/i);
    expect(d).toContain("crm_find_free_slots");
    expect(d).toContain("crm_reschedule_appointment");
    // Mover ANTES de falar com a cliente: a ordem é o que falta.
    expect(d).toMatch(/antes de (falar com|responder ao) cliente|s[óo] ent[ãa]o responda/i);
  });

  // ── Rodada 3 (27/10): a duplicata VOLTOU pela irmã sem aviso ──────────────
  it("⭐ book_appointment (o caminho do horário ESCOLHIDO) também manda remarcar de volta", () => {
    // Medido no teste 10, rodada 3 (27/10 18:51:28): a cliente pediu
    // "passar pra sexta dia 30/10 as 9h" e o modelo chamou
    // crm_list_event_types → crm_find_free_slots → **crm_book_appointment**,
    // criando a consulta 30/10 12:00Z AO LADO da original 30/10 10:00Z.
    // A causa é a MESMA do fix anterior, por outra porta: find_and_book já
    // carregava o aviso "NÃO é para REMARCAR", mas book_appointment dizia só
    // "use quando o cliente ESCOLHEU um horário" — que é exatamente o caso da
    // remarcação — e não apontava ferramenta nenhuma. O modelo leu a descrição
    // NA HORA da escolha; o prompt e a receita moram tokens atrás.
    const d = crmBookAppointment.description;
    expect(d).toMatch(/remarc/i);
    expect(d).toContain("crm_reschedule_appointment");
    // O gatilho é a EXISTÊNCIA do compromisso (mesma régua do irmão), não a
    // forma da frase: "muda minha manicure pra sexta" não repete dia e hora.
    expect(d).toMatch(/j[áa].*compromisso.*(marcado|existe)|compromisso j[áa] marcado/i);
    // E o id não atravessa mensagens: sem localizar de novo não há o que mover.
    expect(d).toContain("crm_list_appointments");
  });
});
