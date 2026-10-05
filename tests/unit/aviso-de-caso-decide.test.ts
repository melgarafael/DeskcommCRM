/**
 * A MÁQUINA DE DECISÃO DO AVISO — relógio, banco e transporte falsos.
 *
 * ## As três propriedades que este arquivo guarda, e o que cada uma custa
 *
 * **1. NENHUM desfecho é `error`.** `lib/event-log/drain.ts` incrementa
 * `attempts` quando um handler devolve `error` e, na 5ª, MATA o evento e abre um
 * aviso de evento morto na Central. Um handler que devolvesse `error` porque
 * "não há configuração de aviso" faria TODO caso aberto de TODA organização sem
 * aviso — que é a instalação típica — virar cinco tentativas e um evento morto.
 * Os três e2e que exigem `failed + dead === 0` ficariam vermelhos, e a Central
 * de quem nunca ligou o aviso encheria de lixo.
 *
 * **2. O handler NUNCA DORME.** Espaçamento e teto diário viram `retry_at`, que
 * é o que o motor de eventos já sabe fazer. Um `setTimeout` aqui seguraria o
 * dreno inteiro: são 50 linhas por tick, e uma espera de 1,2 s por aviso
 * atrasaria todo mundo atrás dele. O teste mede a AUSÊNCIA de `setTimeout`,
 * porque "não dorme" é fácil de escrever e fácil de perder.
 *
 * **3. A JANELA DE HORÁRIO NÃO SE APLICA — decisão do dono.** O espaçamento e a
 * contagem no `pacing_ledger` continuam valendo; a espera pela janela 7h-22h,
 * não. A janela protege o CLIENTE de receber mensagem fora de hora; a equipe é
 * interna e pediu para ser avisada NA HORA. Um caso que abre às 23h é
 * exatamente o que mais precisa de aviso, e represá-lo até as 7h entrega um
 * aviso sobre algo que já tem oito horas de espera.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  EVENTO_CASO_ABERTO,
  EVENTO_CASO_FECHADO,
  IDADE_MAXIMA_DO_EVENTO_MS,
  aplicaAvisoDeCaso,
  type AvisoDeps,
} from "@/lib/escalacao/aviso-ao-suporte";
import type { EventRow } from "@/lib/event-log/dispatcher";

const AGORA = new Date("2026-09-18T02:30:00.000Z"); // 23h30 em São Paulo: fora da janela
const ORG = "11111111-1111-4111-8111-111111111111";
const CASO = "22222222-2222-4222-8222-222222222222";
const CONVERSA = "33333333-3333-4333-8333-333333333333";
const CONTATO = "44444444-4444-4444-8444-444444444444";
const CANAL = "55555555-5555-4555-8555-555555555555";

function evento(over: Partial<EventRow> = {}): EventRow {
  return {
    id: "66666666-6666-4666-8666-666666666666",
    organization_id: ORG,
    event_type: EVENTO_CASO_ABERTO,
    entity_kind: "agent_case",
    entity_id: CASO,
    payload: { case_id: CASO, conversation_id: CONVERSA, contact_id: CONTATO, source: "agent" },
    metadata: {},
    consumed_by: [],
    attempts: 0,
    created_at: new Date(AGORA.getTime() - 60_000).toISOString(),
    ...over,
  };
}

interface Estado {
  cfg: Record<string, unknown> | null;
  caso: Record<string, unknown> | null;
  canal: Record<string, unknown> | null;
  anonimizado: boolean;
  /** O número de destino virou o de uma conexão ATIVA desta organização? */
  destinoEhDaPropriaOrg: boolean;
  entregaExistente: Record<string, unknown> | null;
  patches: Array<Record<string, unknown>>;
  central: Array<Record<string, unknown>>;
  eventosDoCaso: Array<Record<string, unknown>>;
  enviados: Array<{ to: string; body: string }>;
  ledger: number;
  jids: string[];
  auditorias: string[];
  canceladas: number;
}

function monta(over: Partial<Estado> = {}, deps: Partial<AvisoDeps> = {}) {
  const e: Estado = {
    cfg: {
      organization_id: ORG,
      channel_session_id: CANAL,
      telefone_destino: "+5531998966398",
      destino_jid: null,
      ligado: true,
    },
    caso: {
      id: CASO,
      organization_id: ORG,
      conversation_id: CONVERSA,
      kind: "financeiro",
      source: "agent",
      status: "awaiting_human",
      title: "Desconto acima da política",
      summary: "15% no plano anual",
      blocker: "a política permite até 10%",
    },
    canal: { id: CANAL, status: "WORKING", archived_at: null, aceitaMensagemLivre: true },
    anonimizado: false,
    destinoEhDaPropriaOrg: false,
    entregaExistente: null,
    patches: [],
    central: [],
    eventosDoCaso: [],
    enviados: [],
    ledger: 0,
    jids: [],
    auditorias: [],
    canceladas: 0,
    ...over,
  };

  const base: AvisoDeps = {
    clock: () => AGORA,
    urlPublica: "https://crm.exemplo.com.br",
    origemDoDreno: () => "worker",
    audita: (entrada) => {
      e.auditorias.push(entrada.action);
    },
    db: {
      async carregaConfig() {
        return e.cfg as never;
      },
      async carregaCaso() {
        return e.caso as never;
      },
      async contatoAnonimizado() {
        return e.anonimizado;
      },
      async reivindicaEntrega(entrada) {
        if (e.entregaExistente) return { criada: false, entrega: e.entregaExistente as never };
        const nova = {
          id: "77777777-7777-4777-8777-777777777777",
          organization_id: entrada.organizationId,
          case_id: entrada.caseId,
          destino: entrada.destino,
          status: "pendente",
          tentativas: 0,
          created_at: AGORA.toISOString(),
          updated_at: AGORA.toISOString(),
        };
        e.entregaExistente = nova;
        return { criada: true, entrega: nova as never };
      },
      async atualizaEntrega(_org, _id, patch) {
        e.patches.push(patch as Record<string, unknown>);
      },
      async cancelaPendentesDoCaso() {
        return e.canceladas;
      },
      async carregaCanal() {
        return e.canal as never;
      },
      async destinoEhDaPropriaOrganizacao() {
        return e.destinoEhDaPropriaOrg;
      },
      async avisaNaCentral(entrada) {
        e.central.push(entrada as unknown as Record<string, unknown>);
      },
      async registraEventoDoCaso(entrada) {
        e.eventosDoCaso.push(entrada as unknown as Record<string, unknown>);
      },
      async registraJidDoAviso(_org, jid) {
        e.jids.push(jid);
      },
      async nomeDoContato() {
        return "Maria Aparecida";
      },
      async marcaDaOrganizacao() {
        return { nome: "Acme CRM", idioma: "pt-BR" as const };
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
        e.enviados.push({ to, body });
        return { externalId: "wamid.ABC" };
      },
    },
    pacing: {
      async decide() {
        return { liberado: true };
      },
      async registraEnvio() {
        e.ledger += 1;
      },
    },
    ...deps,
  };
  return { estado: e, deps: base };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("aviso ao suporte — nenhum desfecho é `error`", () => {
  it("evento de outro tipo sai `skipped`", async () => {
    const { deps } = monta();
    const r = await aplicaAvisoDeCaso(deps, evento({ event_type: "message.received" }));
    expect(r.status).toBe("skipped");
  });

  it("sem configuração (o caminho de TODA instalação que nunca ligou) sai `skipped`", async () => {
    const { deps, estado } = monta({ cfg: null });
    const r = await aplicaAvisoDeCaso(deps, evento());
    expect(r.status).toBe("skipped");
    expect(r.detail).toContain("sem_configuracao");
    expect(estado.enviados).toHaveLength(0);
  });

  it("configuração desligada sai `skipped`, sem tocar a rede", async () => {
    const { deps, estado } = monta({ cfg: { channel_session_id: CANAL, telefone_destino: "+5531998966398", ligado: false } });
    const r = await aplicaAvisoDeCaso(deps, evento());
    expect(r.status).toBe("skipped");
    expect(estado.enviados).toHaveLength(0);
  });

  it("nenhum caminho devolve `error` — varredura dos estados de mundo", async () => {
    const mundos: Array<Partial<Estado>> = [
      { cfg: null },
      { caso: null },
      { caso: { id: CASO, organization_id: ORG, source: "mcp_externo", status: "awaiting_human" } },
      { caso: { id: CASO, organization_id: ORG, source: "agent", status: "resolved" } },
      { canal: null },
      { canal: { id: CANAL, status: "WORKING", archived_at: new Date().toISOString(), aceitaMensagemLivre: true } },
      { canal: { id: CANAL, status: "WORKING", archived_at: null, aceitaMensagemLivre: false } },
      { canal: { id: CANAL, status: "STOPPED", archived_at: null, aceitaMensagemLivre: true } },
      { anonimizado: true },
      { destinoEhDaPropriaOrg: true },
    ];
    for (const mundo of mundos) {
      const { deps } = monta(mundo);
      const r = await aplicaAvisoDeCaso(deps, evento());
      expect(r.status, JSON.stringify(mundo)).not.toBe("error");
    }
  });
});

describe("aviso ao suporte — o que impede o envio", () => {
  it("o destino voltou a ser um número da organização → NÃO envia, e fica registrado", async () => {
    // A guarda de "número da própria organização" roda ao DEFINIR o aviso. Uma
    // conexão arquivada deixa de contar, então o número dela pode virar destino
    // — e se a conexão for REATIVADA depois, nenhuma checagem volta a rodar. O
    // aviso sairia para um número atendido por um agente DESTA organização: o
    // laço robô-com-robô que a guarda existe para evitar.
    //
    // Este caso mede o desfecho: a mensagem NÃO sai e a recusa fica gravada na
    // entrega, visível na tela e na Central — não é um silêncio.
    const { deps, estado } = monta({ destinoEhDaPropriaOrg: true });
    const r = await aplicaAvisoDeCaso(deps, evento());

    expect(r.status).toBe("skipped");
    expect(r.detail).toContain("destino_da_propria_organizacao");
    expect(estado.enviados, "o aviso saiu para um número da própria organização").toHaveLength(0);
    // O registro é o que faz a recusa ser diagnosticável depois.
    expect(estado.patches.at(-1)).toMatchObject({
      status: "falhou",
      erro_codigo: "destino_da_propria_organizacao",
    });
    // E a Central abre item: sem isso, o caso fica esperando sem ninguém saber.
    expect(estado.central).toHaveLength(1);
  });

  it("o destino de FORA continua enviando — o controle positivo da guarda nova", async () => {
    // Sem esta ponta, uma guarda que recusasse TODO destino passaria no caso
    // acima e ninguém saberia.
    const { deps, estado } = monta();
    const r = await aplicaAvisoDeCaso(deps, evento());
    expect(r.status).toBe("ok");
    expect(estado.enviados).toHaveLength(1);
  });

  it("caso fechado entre o evento e o dreno → não envia", async () => {
    const { deps, estado } = monta({
      caso: { id: CASO, organization_id: ORG, source: "agent", status: "resolved", conversation_id: CONVERSA },
    });
    const r = await aplicaAvisoDeCaso(deps, evento());
    expect(r.detail).toContain("caso_fechado");
    expect(estado.enviados).toHaveLength(0);
  });

  it("origem que não é do motor → não envia", async () => {
    const { deps, estado } = monta({
      caso: { id: CASO, organization_id: ORG, source: "mcp_externo", status: "awaiting_human", conversation_id: CONVERSA },
    });
    const r = await aplicaAvisoDeCaso(deps, evento());
    expect(r.detail).toContain("origem_nao_aceita");
    expect(estado.enviados).toHaveLength(0);
  });

  it("evento mais velho que o teto → descartado, e o descarte APARECE", async () => {
    const { deps, estado } = monta();
    const velho = evento({
      created_at: new Date(AGORA.getTime() - IDADE_MAXIMA_DO_EVENTO_MS - 1000).toISOString(),
    });
    const r = await aplicaAvisoDeCaso(deps, velho);
    expect(r.status).toBe("skipped");
    expect(r.detail).toContain("evento_velho");
    expect(estado.enviados).toHaveLength(0);
  });

  it("evento SEM `created_at` não é descartado — falha ABERTA na informação", async () => {
    const { deps, estado } = monta();
    const semData = evento();
    delete (semData as { created_at?: string }).created_at;
    await aplicaAvisoDeCaso(deps, semData);
    expect(estado.enviados).toHaveLength(1);
  });

  it("titular anonimizado → cancela a entrega e NÃO abre item na Central", async () => {
    const { deps, estado } = monta({ anonimizado: true });
    const r = await aplicaAvisoDeCaso(deps, evento());
    expect(estado.enviados).toHaveLength(0);
    expect(estado.central).toHaveLength(0);
    expect(estado.patches.at(-1)).toMatchObject({
      status: "cancelado",
      erro_codigo: "titular_anonimizado",
    });
    expect(r.status).toBe("skipped");
  });

  it("instalação sem endereço público → falha a entrega em vez de mandar aviso sem link", async () => {
    const { deps, estado } = monta({}, { urlPublica: "http://localhost:3000" });
    await aplicaAvisoDeCaso(deps, evento());
    expect(estado.enviados).toHaveLength(0);
    expect(estado.patches.at(-1)).toMatchObject({
      status: "falhou",
      erro_codigo: "sem_endereco_publico",
    });
    expect(estado.central).toHaveLength(1);
  });

  it("canal que não manda texto livre falha com o código próprio", async () => {
    const { deps, estado } = monta({
      canal: { id: CANAL, status: "WORKING", archived_at: null, aceitaMensagemLivre: false },
    });
    await aplicaAvisoDeCaso(deps, evento());
    expect(estado.patches.at(-1)).toMatchObject({ erro_codigo: "canal_nao_aceita_aviso_livre" });
  });

  it("canal PAUSADO pelo operador não envia: falha com o código próprio e avisa na Central (#2318)", async () => {
    const { deps, estado } = monta({
      canal: { id: CANAL, status: "WORKING", archived_at: null, aceitaMensagemLivre: true, desativado: true },
    });
    await aplicaAvisoDeCaso(deps, evento());
    expect(estado.enviados).toHaveLength(0);
    expect(estado.patches.at(-1)).toMatchObject({ status: "falhou", erro_codigo: "canal_desativado" });
    expect(estado.central).toHaveLength(1);
  });

  it("canal fora do ar é RETRY, não falha — ele volta sozinho", async () => {
    const { deps, estado } = monta({
      canal: { id: CANAL, status: "STOPPED", archived_at: null, aceitaMensagemLivre: true },
    });
    const r = await aplicaAvisoDeCaso(deps, evento());
    expect(r.status).toBe("retry");
    expect(r.retry_at).toBeTruthy();
    expect(estado.enviados).toHaveLength(0);
  });

  it("canal fora do ar por tentativas demais vira falha definitiva", async () => {
    const { deps, estado } = monta({
      canal: { id: CANAL, status: "STOPPED", archived_at: null, aceitaMensagemLivre: true },
      entregaExistente: {
        id: "77777777-7777-4777-8777-777777777777",
        organization_id: ORG,
        case_id: CASO,
        destino: "+5531998966398",
        status: "pendente",
        tentativas: 6,
        created_at: new Date(AGORA.getTime() - 60_000).toISOString(),
        updated_at: new Date(AGORA.getTime() - 10 * 60_000).toISOString(),
      },
    });
    const r = await aplicaAvisoDeCaso(deps, evento());
    expect(r.status).toBe("skipped");
    expect(estado.patches.at(-1)).toMatchObject({
      status: "falhou",
      erro_codigo: "canal_desconectado",
    });
    expect(estado.central).toHaveLength(1);
  });
});

describe("aviso ao suporte — a janela de horário NÃO segura o aviso (decisão do dono)", () => {
  it("23h30 no fuso do tenant: o aviso SAI", async () => {
    // Este é o caso que a decisão do dono resolve. A janela de envio protege o
    // CLIENTE; a equipe de suporte é interna e pediu para ser avisada na hora.
    const { deps, estado } = monta();
    const r = await aplicaAvisoDeCaso(deps, evento());
    expect(r.status).toBe("ok");
    expect(estado.enviados).toHaveLength(1);
  });

  it("o espaçamento entre mensagens CONTINUA valendo, e vira retry_at — não sono", async () => {
    const liberaEm = new Date(AGORA.getTime() + 1200);
    const { deps, estado } = monta(
      {},
      {
        pacing: {
          async decide() {
            return { liberado: false, motivo: "espacamento" as const, liberaEm };
          },
          async registraEnvio() {},
        },
      },
    );
    const espera = vi.spyOn(globalThis, "setTimeout");
    const r = await aplicaAvisoDeCaso(deps, evento());
    expect(r.status).toBe("retry");
    expect(r.retry_at).toBe(liberaEm.toISOString());
    expect(estado.enviados).toHaveLength(0);
    expect(espera).not.toHaveBeenCalled();
  });

  it("teto diário do número grava o código PRÓPRIO — não vira `expirou` genérico", async () => {
    const liberaEm = new Date(AGORA.getTime() + 3600_000);
    const { deps, estado } = monta(
      {},
      {
        pacing: {
          async decide() {
            return { liberado: false, motivo: "teto_diario" as const, liberaEm };
          },
          async registraEnvio() {},
        },
      },
    );
    const r = await aplicaAvisoDeCaso(deps, evento());
    expect(r.status).toBe("retry");
    expect(estado.patches.at(-1)).toMatchObject({ erro_codigo: "teto_diario_do_numero" });
  });
});

describe("aviso ao suporte — o dreno dentro da requisição não toca a rede", () => {
  it("adia em vez de enviar, e o evento continua `pending` sem gastar tentativa", async () => {
    const { deps, estado } = monta({}, { origemDoDreno: () => "request" });
    const r = await aplicaAvisoDeCaso(deps, evento());
    expect(r.status).toBe("retry");
    expect(estado.enviados).toHaveLength(0);
    // Nem a configuração foi lida: o desvio é a PRIMEIRA coisa do handler.
    expect(estado.patches).toHaveLength(0);
  });
});

describe("aviso ao suporte — o envio bem-sucedido", () => {
  it("grava a entrega, conta no ledger, registra o JID, marca a linha do tempo e audita", async () => {
    const { deps, estado } = monta();
    const r = await aplicaAvisoDeCaso(deps, evento());

    expect(r.status).toBe("ok");
    expect(estado.enviados[0]?.to).toBe("5531998966398@c.us");
    expect(estado.enviados[0]?.body).toContain("Acme CRM");
    expect(estado.enviados[0]?.body).toContain("Cliente: Maria");
    expect(estado.patches.at(-1)).toMatchObject({ status: "enviado", external_id: "wamid.ABC" });
    expect(estado.patches.at(-1)?.corpo_hash).toEqual(expect.any(String));
    expect(estado.ledger).toBe(1);
    expect(estado.jids).toEqual(["5531998966398@c.us"]);
    expect(estado.eventosDoCaso[0]).toMatchObject({ kind: "alert_sent", actorKind: "system" });
    expect(estado.auditorias).toContain("ai.case_alert_sent");
  });

  it("o CORPO do aviso nunca é guardado — só o resumo criptográfico dele", async () => {
    const { deps, estado } = monta();
    await aplicaAvisoDeCaso(deps, evento());
    const patch = estado.patches.at(-1) as Record<string, unknown>;
    for (const valor of Object.values(patch)) {
      if (typeof valor === "string") expect(valor).not.toContain("Desconto acima da política");
    }
  });

  it("destino que o transporte não sabe endereçar falha com o código próprio", async () => {
    const { deps, estado } = monta({}, {
      transporte: {
        async configurado() {
          return true;
        },
        async resolveDestino() {
          return null;
        },
        async envia() {
          throw new Error("não devia chegar aqui");
        },
      },
    });
    await aplicaAvisoDeCaso(deps, evento());
    expect(estado.patches.at(-1)).toMatchObject({ erro_codigo: "destino_invalido" });
  });
});

describe("aviso ao suporte — o laço fecha no fechamento do caso", () => {
  it("`ai.case_closed` cancela as entregas pendentes daquele caso", async () => {
    const { deps } = monta({ canceladas: 2 });
    const r = await aplicaAvisoDeCaso(deps, evento({ event_type: EVENTO_CASO_FECHADO }));
    expect(r.status).toBe("ok");
    expect(r.detail).toContain("2");
  });

  it("fechamento sem nada pendente sai `skipped`, não `error`", async () => {
    const { deps } = monta({ canceladas: 0 });
    const r = await aplicaAvisoDeCaso(deps, evento({ event_type: EVENTO_CASO_FECHADO }));
    expect(r.status).toBe("skipped");
  });
});
