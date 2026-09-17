import { beforeEach, describe, expect, it, vi } from "vitest";

import type { SupabaseClient } from "@supabase/supabase-js";

import type * as AgendaConsulta from "@/lib/agenda/consulta";
import type { ResultadoDaConsulta } from "@/lib/agenda/consulta";
import type { McpContext } from "@/lib/mcp/types";

/**
 * `crm_find_and_book_appointment` — o COMPORTAMENTO da ferramenta conjunta (issue #831).
 *
 * ## O sintoma que este arquivo prende
 *
 * O cliente diz "quinta às 14h", o modelo chama `crm_find_free_slots`, recebe a lista,
 * responde "confirmei o horário" e encerra o turno — **ninguém marcou nada**. Consultar e
 * marcar são a MESMA decisão quando o cliente já disse dia E hora; separá-las em duas
 * idas ao modelo cria a chance (e a prática) de parar no meio.
 *
 * ## O que é da TOOL e o que é da COLETA
 *
 * A coleta (`horariosLivresDaOrg`) tem teste próprio, de outro dono. Aqui a fronteira é
 * deliberada — este arquivo mede o que a ferramenta acrescenta por cima dela:
 *  1. NADA é marcado sem estar livre; o instante marcado vem do SLOT, não do texto do modelo;
 *  2. o dia é respeitado (slot de outro dia não serve para a hora pedida);
 *  3. recusa (da consulta ou da marcação) volta como RESPOSTA, nunca como exceção;
 *  4. quem "consegue gravar agenda" é decidido por UMA regra (`temFerramentaDeMarcacao`),
 *     que precisa reconhecer a ferramenta conjunta — senão o agente ganha a ferramenta e
 *     recebe o bloco residente de quem só consulta;
 *  5. o bloco residente da Agenda nunca nomeia ferramenta que o agente não tem.
 */
vi.mock("@/app/api/v1/agenda/agendamentos/_handler", () => ({
  marcarAgendamentoHandler: vi.fn(),
  alterarAgendamentoHandler: vi.fn(),
  cancelarAgendamentoHandler: vi.fn(),
}));

vi.mock("@/lib/agenda/consulta", async (original) => {
  const real = await original<typeof AgendaConsulta>();
  return { ...real, horariosLivresDaOrg: vi.fn(), listaAgendamentos: vi.fn(), idDoTipoPorSlug: vi.fn() };
});

const { horariosLivresDaOrg, idDoTipoPorSlug } = await import("@/lib/agenda/consulta");
const { crmFindAndBookAppointment } = await import("@/lib/mcp/tools/agendamento");
const handlers = await import("@/app/api/v1/agenda/agendamentos/_handler");
const { temFerramentaDeMarcacao } = await import("@/lib/agent-engine/agent/inbound-turn");
const { ApiError } = await import("@/lib/api/types");

// O dublê do client existe só para satisfazer o contrato: a coleta está mockada, então
// nada aqui toca banco.
const ctx: McpContext = {
  organizationId: "org-1",
  role: "agent",
  actor: { type: "ai_agent", id: "ag-1", role: "ai_operator" },
  apiTokenId: "tok-1",
  requestId: "req-1",
  supabase: {} as unknown as SupabaseClient,
};

const CONTATO = "11111111-1111-4111-8111-111111111111";

// ⚠️ O fuso da REGRA é `America/Sao_Paulo`, e os instantes estão DESLOCADOS do rótulo
// de propósito: 17:00Z é o rótulo "14:00" local, 18:00Z é "15:00".
//
// Com `UTC` — como este fixture nascia — o instante do slot e a construção ingênua
// `${dia}T${horario}:00.000Z` dão o MESMO valor, e a asserção de `starts_at` deixa de
// distinguir "marcou o que a agenda confirmou" de "marcou a hora que o modelo digitou",
// que é a promessa nº 1 desta ferramenta e a regressão mais cara que ela pode ter.
// Medido: com o fixture em UTC, trocar `achado.inicio.toISOString()` pela construção
// ingênua deixava ZERO caso vermelho; com o fixture deslocado, deixa este arquivo
// vermelho no primeiro caso.
const SUCESSO: ResultadoDaConsulta = {
  ok: true,
  slots: [
    { inicio: new Date("2026-09-01T17:00:00Z"), fim: new Date("2026-09-01T17:30:00Z") },
    { inicio: new Date("2026-09-01T18:00:00Z"), fim: new Date("2026-09-01T18:30:00Z") },
  ],
  fusoDaRegra: "America/Sao_Paulo",
  publicouHorarios: true,
  fusoSuposto: false,
  fontesDefasadas: [],
  agendaExternaNuncaLida: false,
  googleCoberturaParcial: false,
};

const COMPROMISSO = { id: "apt-1", status: "confirmed", meeting_state: "ready" };
const HORA_14 = /14[:h]00/;

describe("crm_find_and_book_appointment", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(horariosLivresDaOrg).mockResolvedValue(SUCESSO);
    vi.mocked(idDoTipoPorSlug).mockResolvedValue({ id: "tipo-1" } as never);
    vi.mocked(handlers.marcarAgendamentoHandler).mockResolvedValue(COMPROMISSO as never);
  });

  it("horário livre: marca na MESMA chamada, com o instante que a agenda confirmou", async () => {
    const r = (await crmFindAndBookAppointment.handler(
      { event_type_slug: "consulta", dia: "2026-09-01", horario: "14:00", contact_id: CONTATO },
      ctx,
    )) as Record<string, unknown>;

    expect(r.marcado).toBe(true);
    expect(handlers.marcarAgendamentoHandler).toHaveBeenCalledTimes(1);

    // A marcação sai pela MESMA porta de `crm_book_appointment` (com o mesmo guard de
    // organização) e com o instante que veio do slot.
    const [, meta, corpo] = vi.mocked(handlers.marcarAgendamentoHandler).mock.calls[0]!;
    expect((meta as { organization_id: string }).organization_id).toBe("org-1");
    expect((corpo as { starts_at: string }).starts_at).toBe("2026-09-01T17:00:00.000Z");
    expect((corpo as { contact_id: string }).contact_id).toBe(CONTATO);

    // E o retorno diz QUAL horário esta chamada usou — o modelo não precisa deduzir.
    expect(r.inicio).toBe("2026-09-01T17:00:00.000Z");
    expect(String(r.quando)).toMatch(HORA_14);
  });

  it("horário pedido fora da lista: NADA é marcado e a resposta traz os horários do dia", async () => {
    const r = (await crmFindAndBookAppointment.handler(
      { event_type_slug: "consulta", dia: "2026-09-01", horario: "16:00", contact_id: CONTATO },
      ctx,
    )) as Record<string, unknown>;

    expect(handlers.marcarAgendamentoHandler).not.toHaveBeenCalled();
    expect(r.marcado).toBe(false);
    expect(r.motivo).toBe("horario_indisponivel");

    // A lista que a agenda REALMENTE tem naquele dia — é o que o modelo oferece ao
    // cliente no mesmo turno, em vez de pedir outro dia no escuro.
    const horarios = r.horarios as Array<{ inicio: string; quando: string }>;
    expect(horarios.length).toBeGreaterThan(0);
    expect(horarios.some((h) => HORA_14.test(h.quando))).toBe(true);
  });

  it("o DIA é respeitado: slot de outro dia não serve para a hora pedida", async () => {
    const r = (await crmFindAndBookAppointment.handler(
      { event_type_slug: "consulta", dia: "2026-09-02", horario: "14:00", contact_id: CONTATO },
      ctx,
    )) as Record<string, unknown>;

    // Mesmo existindo um 14:00 na agenda, ele é do dia 01 — marcar ali seria marcar um
    // dia que o cliente não pediu.
    expect(handlers.marcarAgendamentoHandler).not.toHaveBeenCalled();
    expect(r.marcado).toBe(false);
  });

  it("consulta recusada por negócio não derruba o turno: volta como resposta ao modelo", async () => {
    vi.mocked(horariosLivresDaOrg).mockResolvedValue({
      ok: false,
      codigo: "tipo_desconhecido",
      motivoParaCliente: "não existe atendimento com esse nome",
    } as never);

    const r = (await crmFindAndBookAppointment.handler(
      { event_type_slug: "consulta", dia: "2026-09-01", horario: "14:00", contact_id: CONTATO },
      ctx,
    )) as Record<string, unknown>;

    expect(r.marcado).toBe(false);
    expect(r.motivo).toBe("tipo_desconhecido");
    expect(handlers.marcarAgendamentoHandler).not.toHaveBeenCalled();
  });

  it("marcação recusada depois do horário livre volta como resposta, com o dia junto", async () => {
    // A recusa de NEGÓCIO da marcação chega como `ApiError` (é assim que o handler
    // recusa horário tomado na última hora). Numa ferramenta MCP exceção subiria pela
    // ponte e o assistente EMUDECERIA no meio da conversa de agendamento.
    vi.mocked(handlers.marcarAgendamentoHandler).mockRejectedValue(
      new ApiError(409, "agenda_horario_indisponivel", undefined, "req-1", "slot tomado"),
    );

    const r = (await crmFindAndBookAppointment.handler(
      { event_type_slug: "consulta", dia: "2026-09-01", horario: "14:00", contact_id: CONTATO },
      ctx,
    )) as Record<string, unknown>;

    expect(r.marcado).toBe(false);
    expect(r.motivo).toBe("agenda_horario_indisponivel");
    // O turno continua e o modelo recebe também o que estava livre: é o material para
    // não encerrar a conversa com o cliente na mão. E SEM o 14:00 que acabou de ser
    // recusado — oferecê-lo de volta é o começo de um laço.
    const horarios = r.horarios as Array<{ inicio: string; quando: string }>;
    expect(horarios.length).toBeGreaterThan(0);
    expect(horarios.some((h) => HORA_14.test(h.quando))).toBe(false);
    expect(horarios.some((h) => /15[:h]00/.test(h.quando))).toBe(true);

    // E a instrução NÃO manda consultar de novo: a lista do dia já veio nesta
    // resposta. O texto herdado da marcação avulsa mandava chamar
    // `crm_find_free_slots` outra vez — o laço que esta ferramenta veio desfazer.
    expect(String(r.mensagem)).not.toContain("crm_find_free_slots");
    expect(String(r.mensagem)).toContain("desta mesma resposta");
  });

  it("recusa de OUTRA natureza mantém o ensino dela — não vira 'ofereça um horário da lista'", async () => {
    // O ensino de cada código diz o que FAZER. Tipo de atendimento desativado pede
    // outra pergunta ao cliente; reescrever por "esse horário ficou indisponível,
    // ofereça outro" mandaria oferecer horário de um atendimento que não se marca.
    vi.mocked(handlers.marcarAgendamentoHandler).mockRejectedValue(
      new ApiError(422, "agenda_tipo_desativado", undefined, "req-1", "tipo desativado"),
    );

    const r = (await crmFindAndBookAppointment.handler(
      { event_type_slug: "consulta", dia: "2026-09-01", horario: "14:00", contact_id: CONTATO },
      ctx,
    )) as Record<string, unknown>;

    expect(r.marcado).toBe(false);
    expect(r.motivo).toBe("agenda_tipo_desativado");
    expect(String(r.mensagem)).toContain("Pergunte que outro atendimento serve");
    expect(String(r.mensagem)).not.toContain("acabou de ficar indisponível");
  });

  it("o horário recusado era o ÚNICO do dia: o ensino manda consultar outro dia", async () => {
    // Sem opção nesta resposta, "ofereça uma das opções desta mesma resposta" aponta
    // para uma lista vazia — e o modelo encerraria o turno sem ter o que oferecer.
    vi.mocked(horariosLivresDaOrg).mockResolvedValue({
      ...SUCESSO,
      slots: [{ inicio: new Date("2026-09-01T17:00:00Z"), fim: new Date("2026-09-01T17:30:00Z") }],
    });
    vi.mocked(handlers.marcarAgendamentoHandler).mockRejectedValue(
      new ApiError(409, "agenda_horario_indisponivel", undefined, "req-1", "slot tomado"),
    );

    const r = (await crmFindAndBookAppointment.handler(
      { event_type_slug: "consulta", dia: "2026-09-01", horario: "14:00", contact_id: CONTATO },
      ctx,
    )) as Record<string, unknown>;

    expect(r.marcado).toBe(false);
    expect(r.horarios).toEqual([]);
    expect(String(r.mensagem)).toContain("crm_find_free_slots");
    expect(String(r.mensagem)).not.toContain("desta mesma resposta");
  });
  it("agenda externa NUNCA sincronizada: o sinal chega ao modelo, e a marcação sai com ressalva", async () => {
    // O campo existe em `ResultadoDaConsulta` desde sempre e chegava SÓ à rota
    // REST: as duas tools publicavam `fontes_defasadas` e engoliam este, que é o
    // mais grave. "Nunca sincronizou" significa que a lista de ocupados pode
    // estar vazia por ninguém ter perguntado — e agora o "livre" vira gravação na
    // mesma chamada, sem uma segunda decisão do modelo no meio.
    vi.mocked(horariosLivresDaOrg).mockResolvedValue({ ...SUCESSO, agendaExternaNuncaLida: true });
    // Compromisso que ainda aguarda aprovação: a marcação JÁ produz mensagem
    // própria, e é sobre ela que a ressalva precisa ACRESCENTAR — sobrescrever
    // perderia o aviso de que ninguém confirmou ainda.
    vi.mocked(handlers.marcarAgendamentoHandler).mockResolvedValue({
      ...COMPROMISSO,
      status: "pending",
    } as never);

    const r = (await crmFindAndBookAppointment.handler(
      { event_type_slug: "consulta", dia: "2026-09-01", horario: "14:00", contact_id: CONTATO },
      ctx,
    )) as Record<string, unknown>;

    expect(r.marcado).toBe(true);
    expect(r.agenda_externa_nunca_lida).toBe(true);
    expect(String(r.mensagem)).toContain("O horário ficou RESERVADO");
    expect(String(r.mensagem)).toContain("nunca foi sincronizada");
    expect(String(r.mensagem)).toContain("não afirme que está confirmado");
  });

  it("agenda externa nunca lida SEM aviso da marcação: a ressalva vira a mensagem inteira", async () => {
    vi.mocked(horariosLivresDaOrg).mockResolvedValue({ ...SUCESSO, agendaExternaNuncaLida: true });

    const r = (await crmFindAndBookAppointment.handler(
      { event_type_slug: "consulta", dia: "2026-09-01", horario: "14:00", contact_id: CONTATO },
      ctx,
    )) as Record<string, unknown>;

    // Compromisso confirmado não produz `mensagem` nenhuma (ver `crmBookAppointment`):
    // a ressalva não pode depender de haver texto anterior para se pendurar.
    expect(String(r.mensagem)).toContain("nunca foi sincronizada");
    expect(String(r.mensagem).startsWith(" ")).toBe(false);
  });

  it("agenda saudável: nenhuma ressalva é inventada", async () => {
    const r = (await crmFindAndBookAppointment.handler(
      { event_type_slug: "consulta", dia: "2026-09-01", horario: "14:00", contact_id: CONTATO },
      ctx,
    )) as Record<string, unknown>;

    expect(r.agenda_externa_nunca_lida).toBe(false);
    expect(String(r.mensagem ?? "")).not.toContain("nunca foi sincronizada");
  });

  it("a recusa também publica o sinal: a lista de horários vem da mesma consulta", async () => {
    vi.mocked(horariosLivresDaOrg).mockResolvedValue({ ...SUCESSO, agendaExternaNuncaLida: true });
    const r = (await crmFindAndBookAppointment.handler(
      { event_type_slug: "consulta", dia: "2026-09-01", horario: "09:00", contact_id: CONTATO },
      ctx,
    )) as Record<string, unknown>;

    expect(r.marcado).toBe(false);
    expect(r.agenda_externa_nunca_lida).toBe(true);
  });

});

describe("temFerramentaDeMarcacao (#831)", () => {
  it("reconhece a ferramenta CONJUNTA como 'consegue gravar agenda'", () => {
    // Livro único da regra: é ela que escolhe o bloco residente da Agenda. Se a
    // ferramenta conjunta não estiver aqui, o agente ganha a ferramenta mas o bloco
    // de quem marca não é montado — e ela fica sem ensino.
    expect(temFerramentaDeMarcacao(["crm_find_and_book_appointment"])).toBe(true);
    expect(temFerramentaDeMarcacao(["crm_book_appointment"])).toBe(true);
    // Consultar NÃO é marcar.
    expect(temFerramentaDeMarcacao(["crm_find_free_slots"])).toBe(false);
  });

  it("REMARCAR sozinho não é marcar — o portão não alarga além do que a #831 pede", () => {
    // `crm_reschedule_appointment` grava na agenda, mas só MOVE um compromisso
    // que já existe. Com ela dentro, o agente que tem SÓ a remarcação (e que
    // antes recebia o bloco de só-consulta) passava a receber o bloco de quem
    // marca, que nomeia ferramentas de marcar que ele não tem —
    // e o docstring do bloco irmão diz, com todas as letras, que ensinar uma
    // ferramenta ausente faz o modelo tentar chamá-la.
    expect(temFerramentaDeMarcacao(["crm_reschedule_appointment"])).toBe(false);
    expect(temFerramentaDeMarcacao(["crm_reschedule_appointment", "crm_find_free_slots"])).toBe(
      false,
    );
    // E quem tem remarcação JUNTO de uma ferramenta de marcar continua marcando.
    expect(temFerramentaDeMarcacao(["crm_reschedule_appointment", "crm_book_appointment"])).toBe(
      true,
    );
  });

  it("o PONTO DE USO: quem só remarca recebe o bloco de CONSULTA, não o de marcar", async () => {
    const { blocoResidenteDaAgenda } = await import("@/lib/agent-engine/agent/inbound-turn");

    const soRemarca = blocoResidenteDaAgenda([
      "crm_reschedule_appointment",
      "crm_find_free_slots",
    ]);
    expect(soRemarca).not.toBeNull();
    // O bloco de consulta é o que NÃO manda marcar — é o que lhe cabe.
    expect(soRemarca!).toContain("quem confirma");
    expect(soRemarca!).not.toContain("nunca confirme sem checar");
    expect(soRemarca!).not.toContain("crm_book_appointment");
  });

  it("quem tem a conjunta e a consulta NÃO ouve o nome da marcação avulsa", async () => {
    // Um dono aparando capacidades para caber no teto de 25 produz este agente. O
    // bloco mandava chamar `crm_book_appointment` em três frases — e, depois, "a
    // que estiver na sua lista" entre as duas, o que ainda ENSINA o nome de uma
    // ferramenta ausente: o modelo tenta chamá-la.
    const { blocoResidenteDaAgenda } = await import("@/lib/agent-engine/agent/inbound-turn");

    const bloco = blocoResidenteDaAgenda(["crm_find_free_slots", "crm_find_and_book_appointment"]);
    expect(bloco).not.toBeNull();
    expect(bloco!).toContain("nunca confirme sem checar");
    expect(bloco!).toContain("crm_find_and_book_appointment");
    expect(bloco!).not.toContain("crm_book_appointment");
    expect(bloco!).not.toContain("crm_reschedule_appointment");
  });

  it("em TODA combinação de ferramentas de agenda, o bloco só nomeia as que o agente tem", async () => {
    // A regra inteira, e não um caso: são 4 ferramentas e 16 combinações, e cada
    // uma é alcançável pela tela (uma caixa por capacidade no ToolPicker). Um texto
    // novo escrito à mão com um nome fixo fica vermelho aqui na combinação que não
    // o tem.
    const { blocoResidenteDaAgenda, temFerramentaDeMarcacao } = await import(
      "@/lib/agent-engine/agent/inbound-turn"
    );
    const AGENDA = [
      "crm_find_free_slots",
      "crm_book_appointment",
      "crm_reschedule_appointment",
      "crm_find_and_book_appointment",
    ];

    let blocosMedidos = 0;
    for (let mascara = 0; mascara < 1 << AGENDA.length; mascara++) {
      const tem = AGENDA.filter((_, i) => (mascara & (1 << i)) !== 0);
      const bloco = blocoResidenteDaAgenda(["crm_update_lead_state", ...tem]);
      if (bloco === null) continue;
      blocosMedidos++;
      for (const ausente of AGENDA.filter((nome) => !tem.includes(nome))) {
        expect(bloco, `[${tem.join(", ")}] não tem ${ausente}`).not.toContain(ausente);
      }
      // E quem marca ouve o nome de CADA ferramenta de marcar que tem.
      if (temFerramentaDeMarcacao(tem)) {
        for (const marca of ["crm_book_appointment", "crm_find_and_book_appointment"]) {
          if (tem.includes(marca)) expect(bloco, `[${tem.join(", ")}]`).toContain(marca);
        }
      }
    }
    // Controle: sem isto, um `blocoResidenteDaAgenda` que devolvesse sempre null
    // deixaria o laço sem nenhuma asserção e o caso verde.
    expect(blocosMedidos).toBe(14);
  });

  it("agente sem ferramenta de agenda nenhuma não recebe bloco", async () => {
    const { blocoResidenteDaAgenda } = await import("@/lib/agent-engine/agent/inbound-turn");
    expect(blocoResidenteDaAgenda(["crm_update_lead_state"])).toBeNull();
  });
});
