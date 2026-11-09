/**
 * A AGENDA NA LIGAÇÃO (#4221) — o que o agente de VOZ passa a poder fazer.
 *
 * O agente de texto já marcava consulta pelo MCP; a voz não tinha nenhuma
 * ferramenta de agenda. Aqui os cinco nomes são oferecidos ao modelo, a
 * escrita acontece em DOIS PASSOS (preparar → confirmar) e o que volta para o
 * modelo é TEXTO curto — nunca JSON, nunca UUID.
 *
 * Os casos:
 * (a) com `ctx.agenda`, as cinco são declaradas e a instrução entra;
 * (b) sem `ctx.agenda`, nenhuma aparece — nem a instrução;
 * (c) confirmar com código desconhecido é RECUSADO e a escrita não é chamada;
 * (d) preparar + confirmar executa a marcação e o texto não tem UUID/JSON;
 * (e) preparar de REMARCAR executa remarcar, não marcar;
 * (f) `organization_id` nos argumentos não é encaminhado (a org é a da ligação).
 *
 * SABOTAGEM:
 * - fazer `confirmar_agendamento` executar mesmo com código desconhecido
 *   (ex.: cair num preparo padrão) derruba (c);
 * - espalhar `args` cru para a agenda (`...args`) derruba (f).
 */
import { EventEmitter } from "node:events";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fakes = vi.hoisted(() => ({
  ultimoWs: null as (EventEmitter & { send: ReturnType<typeof vi.fn>; readyState: number }) | null,
}));

// WebSocket de brinquedo: nenhum byte sai para a OpenAI.
vi.mock("ws", async () => {
  const { EventEmitter: Emissor } = await import("node:events");
  class FakeWs extends Emissor {
    static OPEN = 1;
    readyState = 1;
    send = vi.fn();
    close = vi.fn();
    constructor() {
      super();
      fakes.ultimoWs = this as never;
    }
  }
  return { default: FakeWs };
});

import type { AgendaDaVoz, PreparoDaVoz } from "./agenda-da-voz";
import { AudioSocketCallBridge } from "./audioSocketBridge";

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

function socketDeBrinquedo() {
  const s = new EventEmitter() as EventEmitter & Record<string, unknown>;
  s.setNoDelay = vi.fn();
  s.write = vi.fn();
  s.end = vi.fn();
  s.destroy = vi.fn();
  s.destroyed = false;
  return s;
}

/** A agenda de brinquedo: registra o que foi chamado e devolve fala pronta. */
function agendaFalsa() {
  return {
    listarTipos: vi.fn(async () => "Os atendimentos são: Consulta inicial, 30 minutos e Retorno, 15 minutos."),
    horariosLivres: vi.fn(
      async () => "Tenho segunda-feira, 10 de novembro, às 14 horas e terça-feira, 11 de novembro, às 9 horas.",
    ),
    listarCompromissos: vi.fn(async () => "Você tem Consulta inicial em segunda-feira, 10 de novembro, às 14 horas."),
    preparar: vi.fn(
      async (): Promise<PreparoDaVoz> => ({
        operacao: "marcar",
        args: { event_type_slug: "consulta-inicial", starts_at: "2026-11-10T17:00:00.000Z" },
        resumo: "Consulta inicial, segunda-feira, 10 de novembro, às 14 horas.",
      }),
    ),
    executar: vi.fn(async () => "Pronto: marquei segunda-feira, 10 de novembro, às 14 horas."),
  };
}

/** Os `type` enviados à OpenAI, na ordem. */
function enviados(): string[] {
  return fakes.ultimoWs!.send.mock.calls.map(
    (c) => (JSON.parse(c[0] as string) as { type: string }).type,
  );
}

function sessao(): { instructions: string; tools: Array<{ name: string }> } {
  const bruto = fakes.ultimoWs!.send.mock.calls
    .map((c) => JSON.parse(c[0] as string) as { type: string; session?: unknown })
    .find((e) => e.type === "session.update");
  return (bruto as { session: { instructions: string; tools: Array<{ name: string }> } }).session;
}

function nomesDasTools(): string[] {
  return (sessao().tools ?? []).map((t) => t.name);
}

/** O `output` devolvido ao modelo para um `call_id`, quando chegar. */
async function outputDe(callId: string): Promise<string> {
  await vi.waitFor(() => {
    const achou = fakes.ultimoWs!.send.mock.calls.some((c) => {
      const e = JSON.parse(c[0] as string) as {
        type: string;
        item?: { call_id?: string; output?: string };
      };
      return e.type === "conversation.item.create" && e.item?.call_id === callId;
    });
    expect(achou).toBe(true);
  });
  const evento = fakes.ultimoWs!.send.mock.calls
    .map(
      (c) =>
        JSON.parse(c[0] as string) as {
          type: string;
          item?: { call_id?: string; output?: string };
        },
    )
    .filter((e) => e.type === "conversation.item.create" && e.item?.call_id === callId)
    .at(-1)!;
  return evento.item!.output!;
}

/** Dispara uma function call completa (item + argumentos), como a API faz. */
function chamarTool(nome: string, callId: string, args: unknown) {
  fakes.ultimoWs!.emit(
    "message",
    JSON.stringify({
      type: "response.output_item.added",
      item: { type: "function_call", call_id: callId, name: nome },
    }),
  );
  fakes.ultimoWs!.emit(
    "message",
    JSON.stringify({
      type: "response.function_call_arguments.done",
      call_id: callId,
      arguments: JSON.stringify(args),
    }),
  );
}

async function abrirSessao() {
  fakes.ultimoWs!.emit("open");
  await vi.waitFor(() => expect(enviados()).toContain("session.update"));
  await new Promise((r) => setTimeout(r, 0));
}

let ponte: AudioSocketCallBridge | null = null;

function abrirPonte(agenda?: AgendaDaVoz) {
  ponte = new AudioSocketCallBridge(socketDeBrinquedo() as never, {
    callId: "call1",
    organizationId: "org-da-ligacao",
    agentInstructions: "Você é a Ana.",
    voice: "marin",
    voiceSpeed: 1,
    voiceModel: "gpt-realtime",
    onTranscriptTurn: () => {},
    onCallEnded: () => {},
    knowledgeSourceIdsPromise: Promise.resolve([]),
    searchKnowledge: async () => ({ trechos: [] }),
    ...(agenda ? { agenda } : {}),
  });
}

beforeEach(() => {
  fakes.ultimoWs = null;
});

afterEach(() => {
  ponte?.close();
  ponte = null;
});

describe("(a) com agenda injetada", () => {
  it("declara as cinco tools de agenda e a instrução entra na sessão", async () => {
    abrirPonte(agendaFalsa());
    await abrirSessao();

    expect(nomesDasTools()).toEqual(
      expect.arrayContaining([
        "encerrar_chamada",
        "listar_tipos_de_atendimento",
        "achar_horario_livre",
        "listar_compromissos",
        "preparar_agendamento",
        "confirmar_agendamento",
      ]),
    );
    expect(sessao().instructions).toContain("cuida da agenda da empresa");
    expect(sessao().instructions).toContain("PERGUNTE se pode confirmar");
  });
});

describe("(b) sem agenda injetada", () => {
  it("não declara nenhuma das cinco e não manda a instrução", async () => {
    abrirPonte(undefined);
    await abrirSessao();

    const nomes = nomesDasTools();
    expect(nomes).toEqual(["encerrar_chamada"]);
    expect(nomes).not.toContain("preparar_agendamento");
    expect(sessao().instructions).not.toContain("cuida da agenda da empresa");
  });
});

describe("(c) confirmar sem preparo", () => {
  it("código desconhecido é recusado e a escrita NÃO é chamada", async () => {
    const agenda = agendaFalsa();
    abrirPonte(agenda);
    await abrirSessao();

    // O caso só existe se a tool existir: é esta a asserção que fica vermelha
    // antes do conserto.
    expect(nomesDasTools()).toContain("confirmar_agendamento");

    chamarTool("confirmar_agendamento", "call-c", { id: "prep-99" });
    const output = await outputDe("call-c");

    expect(output).toMatch(/nada foi marcado/i);
    expect(agenda.executar).not.toHaveBeenCalled();
    expect(agenda.preparar).not.toHaveBeenCalled();
  });
});

describe("(d) preparar e confirmar", () => {
  it("marca no segundo passo e devolve texto curto, sem UUID e sem JSON", async () => {
    const agenda = agendaFalsa();
    abrirPonte(agenda);
    await abrirSessao();

    chamarTool("preparar_agendamento", "call-p", {
      tipo: "consulta-inicial",
      hora: "14:00",
      dias_a_frente: 7,
    });
    const preparo = await outputDe("call-p");

    expect(agenda.preparar).toHaveBeenCalledWith({
      tipo: "consulta-inicial",
      hora: "14:00",
      dias_a_frente: 7,
    });
    // Preparar NÃO escreve.
    expect(agenda.executar).not.toHaveBeenCalled();
    expect(preparo).toContain("Consulta inicial, segunda-feira, 10 de novembro, às 14 horas.");
    expect(preparo).toMatch(/pergunte se pode confirmar/i);

    const codigo = /prep-\d+/.exec(preparo)?.[0];
    expect(codigo).toBeTruthy();

    chamarTool("confirmar_agendamento", "call-q", { id: codigo });
    const confirmacao = await outputDe("call-q");

    expect(agenda.executar).toHaveBeenCalledTimes(1);
    expect(agenda.executar).toHaveBeenCalledWith("marcar", {
      event_type_slug: "consulta-inicial",
      starts_at: "2026-11-10T17:00:00.000Z",
    });
    expect(confirmacao).not.toMatch(UUID);
    expect(confirmacao).not.toContain("{");
    expect(confirmacao.split(/(?<=[.!?])\s+/).length).toBeLessThanOrEqual(2);
  });

  it("o mesmo código não confirma duas vezes", async () => {
    const agenda = agendaFalsa();
    abrirPonte(agenda);
    await abrirSessao();

    chamarTool("preparar_agendamento", "call-p", { tipo: "consulta-inicial", hora: "14:00" });
    const codigo = /prep-\d+/.exec(await outputDe("call-p"))?.[0];

    chamarTool("confirmar_agendamento", "call-q", { id: codigo });
    await outputDe("call-q");
    chamarTool("confirmar_agendamento", "call-r", { id: codigo });
    const segunda = await outputDe("call-r");

    expect(agenda.executar).toHaveBeenCalledTimes(1);
    expect(segunda).toMatch(/nada foi marcado/i);
  });
});

describe("(e) remarcar", () => {
  it("preparo de remarcar executa remarcar, nunca marcar", async () => {
    const agenda = agendaFalsa();
    agenda.preparar.mockResolvedValueOnce({
      operacao: "remarcar",
      args: { appointment_id: "3f0c1b7a-2d7e-4c1f-9a55-8f0f2f9e1d10", new_starts_at: "2026-11-11T12:00:00.000Z" },
      resumo: "Remarcar Consulta inicial, de segunda-feira, 10 de novembro, às 14 horas, para terça-feira, 11 de novembro, às 9 horas.",
    });
    abrirPonte(agenda);
    await abrirSessao();

    chamarTool("preparar_agendamento", "call-p", {
      tipo: "consulta-inicial",
      hora: "09:00",
      dia: "2026-11-11",
      remarcar: true,
    });
    const preparo = await outputDe("call-p");
    expect(preparo).toContain("Remarcar");
    expect(preparo).not.toMatch(UUID);

    const codigo = /prep-\d+/.exec(preparo)?.[0];
    chamarTool("confirmar_agendamento", "call-q", { id: codigo });
    await outputDe("call-q");

    expect(agenda.executar).toHaveBeenCalledWith("remarcar", {
      appointment_id: "3f0c1b7a-2d7e-4c1f-9a55-8f0f2f9e1d10",
      new_starts_at: "2026-11-11T12:00:00.000Z",
    });
    expect(agenda.executar).not.toHaveBeenCalledWith("marcar", expect.anything());
  });
});

describe("(f) organização nos argumentos", () => {
  it("organization_id de outra org não é encaminhado — a org é a da ligação", async () => {
    const agenda = agendaFalsa();
    abrirPonte(agenda);
    await abrirSessao();

    chamarTool("preparar_agendamento", "call-p", {
      tipo: "consulta-inicial",
      hora: "14:00",
      organization_id: "org-intrusa",
      org_id: "org-intrusa",
      supabase: { from: "nao-deveria-chegar" },
    });
    await outputDe("call-p");

    const recebido = agenda.preparar.mock.calls[0]![0] as Record<string, unknown>;
    expect(recebido).toEqual({ tipo: "consulta-inicial", hora: "14:00" });
    expect(recebido).not.toHaveProperty("organization_id");
    expect(recebido).not.toHaveProperty("org_id");
    expect(recebido).not.toHaveProperty("supabase");

    chamarTool("achar_horario_livre", "call-h", {
      tipo: "consulta-inicial",
      organization_id: "org-intrusa",
    });
    await outputDe("call-h");
    expect(agenda.horariosLivres).toHaveBeenCalledWith({ tipo: "consulta-inicial" });
  });
});
