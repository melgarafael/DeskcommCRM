import { describe, expect, it } from "vitest";

import {
  EVENTO_LEMBRETE_DE_CASO,
  aplicaAvisoDeCaso,
  type AvisoDeps,
  type EntregaDoAviso,
} from "@/lib/escalacao/aviso-ao-suporte";
import type { EventRow } from "@/lib/event-log/dispatcher";

const ORG = "11111111-1111-4111-8111-111111111111";
const CASO = "22222222-2222-4222-8222-222222222222";
const CANAL = "33333333-3333-4333-8333-333333333333";
const EVENTO = "44444444-4444-4444-8444-444444444444";
const DESTINO = "+5531998966398";
const AGORA = new Date("2026-10-07T14:00:00.000Z");

function evento(minute: number, over: Partial<EventRow> = {}): EventRow {
  return {
    id: EVENTO,
    organization_id: ORG,
    event_type: EVENTO_LEMBRETE_DE_CASO,
    entity_kind: "agent_case",
    entity_id: CASO,
    payload: { case_id: CASO, wait_generation: 4, minute },
    metadata: {},
    consumed_by: [],
    attempts: 0,
    created_at: new Date(AGORA.getTime() - 30_000).toISOString(),
    ...over,
  };
}

function monta(
  entrada: {
    minute?: number;
    optIn?: boolean;
    avisoInicialLigado?: boolean;
    orgOperante?: boolean;
    eventoVinculado?: boolean;
    caso?: Partial<Record<string, unknown>>;
    entrega?: Record<string, unknown> | null;
    eventosVinculados?: string[];
    geracoesVinculadas?: number[];
    durantePacing?: () => void;
    falhasDeEnvio?: number;
    minutosConfigurados?: number[];
  } = {},
) {
  const minute = entrada.minute ?? 3;
  const estado = {
    agora: new Date(AGORA),
    config: {
      organization_id: ORG,
      channel_session_id: CANAL,
      telefone_destino: DESTINO,
      destino_jid: null,
      ligado: entrada.avisoInicialLigado ?? true,
      repetir_lembretes_whatsapp: entrada.optIn ?? true,
      minutos_lembrete_equipe: entrada.minutosConfigurados ?? [3, 6, 9],
    } as Record<string, unknown> | null,
    caso: {
      id: CASO,
      organization_id: ORG,
      conversation_id: "55555555-5555-4555-8555-555555555555",
      kind: "financeiro",
      source: "agent",
      status: "awaiting_human",
      title: "Dado privado que não deve sair no lembrete",
      summary: "Resumo do cliente que não deve sair no lembrete",
      blocker: "Detalhe privado que não deve sair no lembrete",
      task_kind: "payment_details",
      task_state: "awaiting_human",
      wait_generation: 4,
      wait_started_at: new Date(AGORA.getTime() - minute * 60_000).toISOString(),
      ...entrada.caso,
    } as Record<string, unknown> | null,
    canal: { id: CANAL, status: "WORKING", archived_at: null, aceitaMensagemLivre: true },
    orgOperante: entrada.orgOperante ?? true,
    eventoVinculado: entrada.eventoVinculado ?? true,
    eventosVinculados: entrada.eventosVinculados ?? [EVENTO],
    geracoesVinculadas: entrada.geracoesVinculadas ?? [4],
    entrega: (entrada.entrega as EntregaDoAviso | null | undefined) ?? null,
    entregas: [] as EntregaDoAviso[],
    patches: [] as Array<Record<string, unknown>>,
    cancelamentos: [] as Array<{
      orgId: string;
      caseId: string;
      waitGeneration: number;
      minute: number;
    }>,
    destinosCancelados: [] as Array<{
      orgId: string;
      caseId: string;
      waitGeneration: number;
      minute: number;
      destino: string;
    }>,
    mensagens: [] as Array<{ body: string; to: string }>,
    chamadasDeEnvio: 0,
    falhasDeEnvio: entrada.falhasDeEnvio ?? 0,
    eventosDoCaso: [] as Array<Record<string, unknown>>,
    durantePacing: entrada.durantePacing,
  };
  if (estado.entrega) estado.entregas.push(estado.entrega);

  const deps: AvisoDeps = {
    clock: () => new Date(estado.agora),
    urlPublica: "https://crm.example.test",
    origemDoDreno: () => "worker",
    audita: () => {},
    db: {
      async carregaConfig() {
        return estado.config as never;
      },
      async carregaCaso() {
        return estado.caso as never;
      },
      async contatoAnonimizado() {
        return false;
      },
      async reivindicaEntrega(chave) {
        const existente = estado.entregas.find(
          (linha) =>
            linha.destino === chave.destino &&
            linha.wait_generation === (chave.waitGeneration ?? null) &&
            linha.reminder_minute === (chave.reminderMinute ?? null),
        );
        if (existente) {
          estado.entrega = existente;
          return { criada: false, entrega: existente };
        }
        estado.entrega = {
          id: "66666666-6666-4666-8666-666666666666",
          organization_id: chave.organizationId,
          case_id: chave.caseId,
          destino: chave.destino,
          channel_session_id: chave.channelSessionId,
          status: "pendente",
          tentativas: 0,
          created_at: estado.agora.toISOString(),
          updated_at: estado.agora.toISOString(),
          wait_generation: chave.waitGeneration ?? null,
          reminder_minute: chave.reminderMinute ?? null,
        } as EntregaDoAviso;
        estado.entregas.push(estado.entrega);
        return { criada: true, entrega: estado.entrega };
      },
      async atualizaEntrega(_orgId, entregaId, patch) {
        estado.patches.push(patch as unknown as Record<string, unknown>);
        const atualizada = {
          ...estado.entrega,
          id: entregaId,
          ...patch,
          updated_at: estado.agora.toISOString(),
        } as EntregaDoAviso;
        estado.entrega = atualizada;
        const indice = estado.entregas.findIndex((linha) => linha.id === entregaId);
        if (indice >= 0) estado.entregas[indice] = atualizada;
        else estado.entregas.push(atualizada);
      },
      async cancelaPendentesDoCaso() {
        return 0;
      },
      async cancelaEntregaPendenteDoLembrete(orgId, caseId, waitGeneration, lembreteMinute) {
        estado.cancelamentos.push({ orgId, caseId, waitGeneration, minute: lembreteMinute });
        let count = 0;
        for (const linha of estado.entregas) {
          if (
            linha.status === "pendente" &&
            linha.organization_id === orgId &&
            linha.case_id === caseId &&
            linha.wait_generation === waitGeneration &&
            linha.reminder_minute === lembreteMinute
          ) {
            linha.status = "cancelado";
            count += 1;
          }
        }
        if (estado.entrega)
          estado.entrega =
            estado.entregas.find((linha) => linha.id === estado.entrega?.id) ?? estado.entrega;
        return count;
      },
      async cancelaPendentesDeLembreteComOutroDestino(
        orgId,
        caseId,
        waitGeneration,
        lembreteMinute,
        destinoAtual,
      ) {
        estado.destinosCancelados.push({
          orgId,
          caseId,
          waitGeneration,
          minute: lembreteMinute,
          destino: destinoAtual,
        });
        let count = 0;
        for (const linha of estado.entregas) {
          if (
            linha.status === "pendente" &&
            linha.organization_id === orgId &&
            linha.case_id === caseId &&
            linha.wait_generation === waitGeneration &&
            linha.reminder_minute === lembreteMinute &&
            linha.destino !== destinoAtual
          ) {
            linha.status = "cancelado";
            count += 1;
          }
        }
        return count;
      },
      async carregaCanal(_orgId, channelSessionId) {
        return { ...estado.canal, id: channelSessionId };
      },
      async carregaLembreteWhatsApp(_org, caseId, generation, lembreteMinute, eventId) {
        return Boolean(
          estado.eventoVinculado &&
          caseId === CASO &&
          estado.geracoesVinculadas.includes(generation) &&
          lembreteMinute === minute &&
          estado.eventosVinculados.includes(eventId),
        );
      },
      async organizacaoOperante() {
        return estado.orgOperante;
      },
      async destinoEhDaPropriaOrganizacao() {
        return false;
      },
      async avisaNaCentral() {},
      async registraEventoDoCaso(entradaCaso) {
        estado.eventosDoCaso.push(entradaCaso as unknown as Record<string, unknown>);
      },
      async registraJidDoAviso() {},
      async nomeDoContato() {
        return "Cliente confidencial";
      },
      async marcaDaOrganizacao() {
        return { nome: "Marca de teste", idioma: "pt-BR" as const };
      },
    },
    transporte: {
      async configurado() {
        return true;
      },
      async resolveDestino(_org, _canal, telefone) {
        return `${telefone.replace(/\D/g, "")}@c.us`;
      },
      async envia(_org, _canal, to, body) {
        estado.chamadasDeEnvio += 1;
        if (estado.falhasDeEnvio > 0) {
          estado.falhasDeEnvio -= 1;
          throw new Error("resposta de transporte não deve ser armazenada");
        }
        estado.mensagens.push({ to, body });
        return { externalId: "transport-id" };
      },
    },
    pacing: {
      async decide() {
        estado.durantePacing?.();
        return { liberado: true };
      },
      async registraEnvio() {},
    },
  };

  return { deps, estado };
}

describe("lembretes WhatsApp da equipe para casos", () => {
  it.each([3, 6, 9] as const)(
    "envia o marco de %i minutos com referência e sem conteúdo do cliente",
    async (minute) => {
      const { deps, estado } = monta({ minute });
      const resultado = await aplicaAvisoDeCaso(deps, evento(minute));

      expect(resultado.status).toBe("ok");
      expect(estado.mensagens).toHaveLength(1);
      expect(estado.mensagens[0]?.body).toContain(`${minute} minutos`);
      expect(estado.mensagens[0]?.body).toContain(CASO.slice(0, 8));
      expect(estado.mensagens[0]?.body).toContain("Abra Casos");
      expect(estado.mensagens[0]?.body).toContain("Responder aqui não chega ao cliente");
      expect(estado.mensagens[0]?.body).not.toContain("Dado privado");
      expect(estado.mensagens[0]?.body).not.toContain("Resumo do cliente");
      expect(estado.entrega).toMatchObject({
        wait_generation: 4,
        reminder_minute: minute,
        status: "enviado",
      });
      expect(estado.entrega).not.toHaveProperty("body");
    },
  );

  it("aceita um marco configurado fora da cadência padrão", async () => {
    const { deps, estado } = monta({ minute: 2, minutosConfigurados: [2, 5, 12] });
    const resultado = await aplicaAvisoDeCaso(deps, evento(2));

    expect(resultado.status).toBe("ok");
    expect(resultado.detail).toContain("aceito_pelo_transporte_sem_confirmacao_final");
    expect(estado.mensagens[0]?.body).toContain("2 minutos");
  });

  it("envia lembrete para caso geral que aguarda a equipe", async () => {
    const { deps, estado } = monta({ caso: { task_kind: null, task_state: null, kind: "other" } });
    const resultado = await aplicaAvisoDeCaso(deps, evento(3));

    expect(resultado.status).toBe("ok");
    expect(estado.mensagens).toHaveLength(1);
    expect(estado.mensagens[0]?.body).toContain("lembrete de caso aguardando a equipe");
  });

  it("pausa o lembrete de caso geral enquanto aguarda resposta do cliente", async () => {
    const { deps, estado } = monta({
      caso: { task_kind: null, task_state: null, status: "awaiting_lead" },
    });
    const resultado = await aplicaAvisoDeCaso(deps, evento(3));

    expect(resultado.detail).toBe("caso_saiu_da_espera");
    expect(estado.chamadasDeEnvio).toBe(0);
  });

  it("não envia sem opt-in de lembretes mesmo que o aviso inicial esteja ligado", async () => {
    const { deps, estado } = monta({ optIn: false });
    const resultado = await aplicaAvisoDeCaso(deps, evento(3));

    expect(resultado.detail).toBe("sem_opt_in_de_lembretes");
    expect(estado.chamadasDeEnvio).toBe(0);
    expect(estado.entrega).toBeNull();
  });

  it("cancela recibo pendente após retry quando o opt-in é desligado", async () => {
    const { deps, estado } = monta({ minute: 9, falhasDeEnvio: 1 });
    const lembrete = evento(9);
    expect((await aplicaAvisoDeCaso(deps, lembrete)).status).toBe("retry");
    expect(estado.entrega).toMatchObject({
      status: "pendente",
      wait_generation: 4,
      reminder_minute: 9,
    });

    estado.config = { ...estado.config, repetir_lembretes_whatsapp: false };
    const segunda = await aplicaAvisoDeCaso(deps, lembrete);

    expect(segunda.detail).toBe("sem_opt_in_de_lembretes");
    expect(estado.entrega).toMatchObject({ status: "cancelado" });
    expect(estado.cancelamentos).toEqual([
      { orgId: ORG, caseId: CASO, waitGeneration: 4, minute: 9 },
    ]);
    expect(estado.chamadasDeEnvio).toBe(1);
  });

  it("mantém o evento e o recibo pendentes durante pausa da organização", async () => {
    const { deps, estado } = monta({ minute: 9, falhasDeEnvio: 1 });
    const lembrete = evento(9);
    expect((await aplicaAvisoDeCaso(deps, lembrete)).status).toBe("retry");
    estado.orgOperante = false;

    const durantePausa = await aplicaAvisoDeCaso(deps, lembrete);

    expect(durantePausa.status).toBe("retry");
    expect(durantePausa.detail).toContain("lembrete preservado");
    expect(estado.entrega).toMatchObject({ status: "pendente" });
    expect(estado.cancelamentos).toHaveLength(0);
    expect(estado.chamadasDeEnvio).toBe(1);

    estado.orgOperante = true;
    estado.agora = new Date(estado.agora.getTime() + 6 * 60_000);
    const retomado = await aplicaAvisoDeCaso(deps, lembrete);
    expect(retomado.status).toBe("ok");
    expect(estado.chamadasDeEnvio).toBe(2);
  });

  it("envia com opt-in de lembretes mesmo quando o aviso inicial está desligado", async () => {
    const { deps, estado } = monta({ avisoInicialLigado: false });
    const resultado = await aplicaAvisoDeCaso(deps, evento(3));

    expect(resultado.status).toBe("ok");
    expect(estado.mensagens).toHaveLength(1);
  });

  it("descarta caso resolvido antes de reivindicar a entrega", async () => {
    const { deps, estado } = monta({ caso: { status: "resolved" } });
    const resultado = await aplicaAvisoDeCaso(deps, evento(3));

    expect(resultado.detail).toBe("caso_saiu_da_espera");
    expect(estado.chamadasDeEnvio).toBe(0);
    expect(estado.entrega).toBeNull();
  });

  it("descarta geração antiga e não envia quando o marco foi ultrapassado", async () => {
    const antigo = monta({ geracoesVinculadas: [3] });
    const resultadoAntigo = await aplicaAvisoDeCaso(
      antigo.deps,
      evento(3, { payload: { case_id: CASO, wait_generation: 3, minute: 3 } }),
    );
    expect(resultadoAntigo.detail).toBe("geracao_antiga");
    expect(antigo.estado.chamadasDeEnvio).toBe(0);

    const ultrapassado = monta({ minute: 3 });
    ultrapassado.estado.agora = new Date(AGORA.getTime() + 6 * 60_000);
    const resultadoUltrapassado = await aplicaAvisoDeCaso(ultrapassado.deps, evento(3));
    expect(resultadoUltrapassado.detail).toBe("marco_ultrapassado_ou_ainda_nao_devido");
    expect(ultrapassado.estado.chamadasDeEnvio).toBe(0);
  });

  it("cancela um evento de marco removido da cadência configurada", async () => {
    const { deps, estado } = monta({ minute: 3, minutosConfigurados: [5, 10] });
    estado.entrega = {
      id: "66666666-6666-4666-8666-666666666666",
      organization_id: ORG,
      case_id: CASO,
      destino: DESTINO,
      status: "pendente",
      tentativas: 1,
      created_at: AGORA.toISOString(),
      updated_at: AGORA.toISOString(),
      wait_generation: 4,
      reminder_minute: 3,
    };
    estado.entregas.push(estado.entrega);

    const resultado = await aplicaAvisoDeCaso(deps, evento(3));

    expect(resultado.detail).toBe("marco_removido_da_cadencia");
    expect(estado.entrega.status).toBe("cancelado");
    expect(estado.chamadasDeEnvio).toBe(0);
  });

  it.each([
    ["caso resolvido", () => ({ status: "resolved" })],
    ["geração alterada", () => ({ wait_generation: 5 })],
    [
      "marco ultrapassado",
      () => ({ wait_started_at: new Date(AGORA.getTime() - 6 * 60_000).toISOString() }),
    ],
  ])("cancela recibo pendente após retry quando %s", async (_nome, alteraCaso) => {
    const { deps, estado } = monta({ minute: 3, falhasDeEnvio: 1 });
    const lembrete = evento(3);
    expect((await aplicaAvisoDeCaso(deps, lembrete)).status).toBe("retry");
    estado.caso = { ...estado.caso, ...alteraCaso() };

    const segunda = await aplicaAvisoDeCaso(deps, lembrete);

    expect(segunda.status).toBe("skipped");
    expect(estado.entrega).toMatchObject({ status: "cancelado" });
    expect(estado.cancelamentos).toEqual([
      { orgId: ORG, caseId: CASO, waitGeneration: 4, minute: 3 },
    ]);
    expect(estado.chamadasDeEnvio).toBe(1);
  });

  it("catch-up não envia rajada de 3 e 6; só o patamar atual de 9 segue", async () => {
    const { deps, estado } = monta({
      minute: 9,
      eventosVinculados: [
        "77777777-7777-4777-8777-777777777777",
        "88888888-8888-4888-8888-888888888888",
        EVENTO,
      ],
    });
    const tres = evento(3, { id: "77777777-7777-4777-8777-777777777777" });
    const seis = evento(6, { id: "88888888-8888-4888-8888-888888888888" });
    const nove = evento(9);

    const resultadoTres = await aplicaAvisoDeCaso(deps, tres);
    const resultadoSeis = await aplicaAvisoDeCaso(deps, seis);
    const resultadoNove = await aplicaAvisoDeCaso(deps, nove);

    expect(resultadoTres.status).toBe("skipped");
    expect(resultadoSeis.status).toBe("skipped");
    expect(resultadoNove.status).toBe("ok");
    expect(estado.chamadasDeEnvio).toBe(1);
    expect(estado.mensagens[0]?.body).toContain("9 minutos");
  });

  it("não descarta o marco 9 só por atraso no event_log quando 9 continua atual", async () => {
    const { deps, estado } = monta({
      minute: 9,
      caso: { wait_started_at: new Date(AGORA.getTime() - 40 * 60_000).toISOString() },
    });
    const atrasado = evento(9, {
      created_at: new Date(AGORA.getTime() - 31 * 60_000).toISOString(),
    });
    const resultado = await aplicaAvisoDeCaso(deps, atrasado);

    expect(resultado.status).toBe("ok");
    expect(estado.mensagens).toHaveLength(1);
  });

  it("cancela a entrega se a tarefa sair da espera durante o pacing", async () => {
    const { deps, estado } = monta({
      durantePacing: () => {
        estado.caso = { ...estado.caso, task_state: "completed" };
      },
    });
    const resultado = await aplicaAvisoDeCaso(deps, evento(3));

    expect(resultado.detail).toBe("caso_saiu_da_espera");
    expect(estado.chamadasDeEnvio).toBe(0);
    expect(estado.entrega).toMatchObject({ status: "cancelado" });
  });

  it("cancela a entrega se um caso geral passar a aguardar o cliente durante o pacing", async () => {
    const { deps, estado } = monta({
      caso: { task_kind: null, task_state: null },
      durantePacing: () => {
        estado.caso = { ...estado.caso, status: "awaiting_lead" };
      },
    });
    const resultado = await aplicaAvisoDeCaso(deps, evento(3));

    expect(resultado.detail).toBe("caso_saiu_da_espera");
    expect(estado.chamadasDeEnvio).toBe(0);
    expect(estado.entrega).toMatchObject({ status: "cancelado" });
  });

  it("faz retry após falha do transporte e não repete uma entrega já enviada", async () => {
    const { deps, estado } = monta({ minute: 9, falhasDeEnvio: 1 });
    const lembrete = evento(9);
    const primeira = await aplicaAvisoDeCaso(deps, lembrete);
    expect(primeira.status).toBe("retry");
    expect(estado.entrega).toMatchObject({ status: "pendente", tentativas: 1, erro_detalhe: null });

    estado.agora = new Date(estado.agora.getTime() + 5 * 60_000);
    const segunda = await aplicaAvisoDeCaso(deps, lembrete);
    expect(segunda.status).toBe("ok");
    expect(estado.chamadasDeEnvio).toBe(2);
    expect(estado.mensagens).toHaveLength(1);

    const duplicada = await aplicaAvisoDeCaso(deps, lembrete);
    expect(duplicada.status).toBe("skipped");
    expect(estado.chamadasDeEnvio).toBe(2);
  });

  it("cancela o recibo do destino antigo e cria um novo ao trocar o número", async () => {
    const { deps, estado } = monta({ minute: 9, falhasDeEnvio: 1 });
    const lembrete = evento(9);
    expect((await aplicaAvisoDeCaso(deps, lembrete)).status).toBe("retry");
    const destinoAntigo = estado.entrega;
    estado.config = { ...estado.config, telefone_destino: "+5511999991111" };
    estado.agora = new Date(estado.agora.getTime() + 6 * 60_000);

    const retomado = await aplicaAvisoDeCaso(deps, lembrete);

    expect(retomado.status).toBe("ok");
    expect(destinoAntigo).toMatchObject({ status: "cancelado", destino: DESTINO });
    expect(estado.entrega).toMatchObject({ status: "enviado", destino: "+5511999991111" });
    expect(estado.entregas).toHaveLength(2);
    expect(
      estado.entregas.some((linha) => linha.status === "pendente" && linha.destino === DESTINO),
    ).toBe(false);
  });

  it("preserva o evento se o número mudar enquanto o envio aguarda pacing", async () => {
    const novoDestino = "+5511999992222";
    const { deps, estado } = monta({
      minute: 9,
      durantePacing: () => {
        estado.config = { ...estado.config, telefone_destino: novoDestino };
      },
    });
    const lembrete = evento(9);

    const interrompido = await aplicaAvisoDeCaso(deps, lembrete);
    expect(interrompido.status).toBe("retry");
    expect(estado.chamadasDeEnvio).toBe(0);
    expect(estado.entrega).toMatchObject({ status: "cancelado", destino: DESTINO });

    const retomado = await aplicaAvisoDeCaso(deps, lembrete);
    expect(retomado.status).toBe("ok");
    expect(estado.entrega).toMatchObject({ status: "enviado", destino: novoDestino });
    expect(estado.chamadasDeEnvio).toBe(1);
  });

  it("atualiza o canal no recibo pendente antes de retomar a tentativa", async () => {
    const { deps, estado } = monta({ minute: 9, falhasDeEnvio: 1 });
    const lembrete = evento(9);
    expect((await aplicaAvisoDeCaso(deps, lembrete)).status).toBe("retry");
    estado.config = {
      ...estado.config,
      channel_session_id: "99999999-9999-4999-8999-999999999999",
    };
    estado.agora = new Date(estado.agora.getTime() + 6 * 60_000);

    const retomado = await aplicaAvisoDeCaso(deps, lembrete);

    expect(retomado.status).toBe("ok");
    expect(estado.entregas).toHaveLength(1);
    expect(estado.entrega).toMatchObject({
      status: "enviado",
      channel_session_id: "99999999-9999-4999-8999-999999999999",
    });
  });

  it("exige a associação durável entre o evento e o marco", async () => {
    const { deps, estado } = monta({
      eventoVinculado: false,
      entrega: {
        id: "66666666-6666-4666-8666-666666666666",
        organization_id: ORG,
        case_id: CASO,
        destino: DESTINO,
        status: "pendente",
        tentativas: 1,
        created_at: AGORA.toISOString(),
        updated_at: AGORA.toISOString(),
        wait_generation: 4,
        reminder_minute: 3,
      },
    });
    const resultado = await aplicaAvisoDeCaso(deps, evento(3));

    expect(resultado.detail).toBe("evento_sem_vinculo_duravel");
    expect(estado.chamadasDeEnvio).toBe(0);
    expect(estado.entrega).toMatchObject({ status: "pendente" });
    expect(estado.cancelamentos).toHaveLength(0);
  });
});
