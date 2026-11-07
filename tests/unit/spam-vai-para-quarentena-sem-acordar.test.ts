import { beforeEach, describe, expect, it, vi } from "vitest";

import { aplicarEfeitosPosEntrada } from "@/lib/channels/pos-entrada";
import {
  classificarEntrada,
  lerOpcaoDoFiltroDeSpam,
  LIMIAR_PADRAO,
  vaiParaQuarentena,
} from "@/lib/entrada/filtro-de-spam";
import {
  avaliarQuarentenaDaEntrada,
  liberarDaQuarentena,
  resumoDaQuarentena,
} from "@/lib/entrada/quarentena";

import { bancoFake } from "./_duplo-de-banco-692";

// ── As dependências dos efeitos pós-entrada ────────────────────────────────
//
// O que interessa aqui é UMA coisa: com a mensagem retida, os efeitos de
// trabalho não rodam. Para medir isso sem banco de verdade, cada passo que
// abriria trabalho vira espião — e o despacho do agente é medido no PRÓPRIO
// `emit_event` do RPC, que é onde ele acontece de fato.
// `vi.hoisted` porque o `vi.mock` é içado acima dos imports: uma `const` comum
// ainda não existe quando a fábrica roda, e o erro é "Cannot access before
// initialization" — que parece falha de mock e é, na verdade, ordem de módulo.
const espioes = vi.hoisted(() => ({
  garantirLeadDaConversa: vi.fn(),
  aplicarRespostaNaCampanha: vi.fn(),
  acelerarFollowupDoInbound: vi.fn(),
  drenarEventosDoInbound: vi.fn(),
  audit: vi.fn(),
}));
const {
  garantirLeadDaConversa,
  aplicarRespostaNaCampanha,
  acelerarFollowupDoInbound,
  drenarEventosDoInbound,
  audit,
} = espioes;

vi.mock("@/lib/leads/nascimento-do-lead", () => ({
  garantirLeadDaConversa: espioes.garantirLeadDaConversa,
}));
vi.mock("@/lib/campanhas/resposta", () => ({
  aplicarRespostaNaCampanha: espioes.aplicarRespostaNaCampanha,
}));
vi.mock("@/lib/dev/kick-local-pipeline", () => ({
  acelerarFollowupDoInbound: espioes.acelerarFollowupDoInbound,
  drenarEventosDoInbound: espioes.drenarEventosDoInbound,
}));
vi.mock("@/lib/audit", () => ({ audit: espioes.audit }));
vi.mock("@/lib/logger", () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

/**
 * O FILTRO DE SPAM DA ENTRADA (#4026).
 *
 * ─── O TESTE DURO ───────────────────────────────────────────────────────────
 *
 * "Mensagem em quarentena é recuperável e a perda é zero." As duas metades são
 * medidas aqui, e não no comentário:
 *
 *   - RETIDA: com o filtro ligado, a mensagem suspeita vira linha em
 *     `quarentena_de_entrada` e NENHUM efeito de trabalho roda — nem demanda,
 *     nem campanha, nem follow-up, nem `ai_agent.dispatch_requested` (o pedido
 *     de turno, medido no RPC `emit_event`), nem drenagem de evento;
 *   - RECUPERÁVEL: depois da liberação, a MESMA mensagem, com os MESMOS efeitos
 *     de produção, produz o turno que tinha ficado pendente. Ela nunca saiu de
 *     `messages` — o que a quarentena segurou foi a consequência;
 *   - PERDA ZERO: o contador `perdidas` do resumo é 0 e a contagem de mensagens
 *     do banco não muda em nenhum dos caminhos.
 *
 * ─── SABOTAGEM ──────────────────────────────────────────────────────────────
 *
 *   - chamar `vaiParaQuarentena` ignorando `ligado`: o caso "desligado por
 *     padrão" acusa (o filtro reteria tudo numa organização que nunca ligou);
 *   - rodar `aplicarEfeitosPosEntrada` inteiro depois de reter: o caso do
 *     `emit_event` acusa (o agente acorda para uma mensagem que deveria
 *     esperar);
 *   - apagar a mensagem de `messages` ao quarentenar: o contador `perdidas`
 *     acusa.
 */

const ORG = "11111111-1111-4111-8111-111111111111";
const CONVERSA = "44444444-4444-4444-8444-444444444444";
const CONTATO = "55555555-5555-4555-8555-555555555555";
const CANAL = "66666666-6666-4666-8666-666666666666";
const MENSAGEM = "77777777-7777-4777-8777-777777777777";

const GOLPE = "PARABÉNS! Você foi sorteado e ganhou um prêmio. Clique aqui: bit.ly/premio";
const NORMAL = "Bom dia! Queria saber o valor do plano de vocês para 3 pessoas.";

function banco(opcoes: { ligado: boolean; limiar?: number } = { ligado: true }) {
  return bancoFake({
    settings: {
      filtro_de_spam: { ligado: opcoes.ligado, ...(opcoes.limiar ? { limiar: opcoes.limiar } : {}) },
    },
    mensagens: [
      { id: MENSAGEM, organization_id: ORG, conversation_id: CONVERSA, body: GOLPE },
    ],
  });
}

function entradaDeTeste(texto: string) {
  return {
    organizationId: ORG,
    contactId: CONTATO,
    conversationId: CONVERSA,
    messageId: MENSAGEM,
    channelSessionId: CANAL,
    texto,
    nomeDoContato: null,
    origem: "teste",
  };
}

function despachos(duplo: ReturnType<typeof banco>): unknown[] {
  return duplo.estado.rpcs.filter(
    (chamada) => chamada.args.p_event_type === "ai_agent.dispatch_requested",
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  garantirLeadDaConversa.mockResolvedValue({ criado: false, motivo: "teste" });
  aplicarRespostaNaCampanha.mockResolvedValue(undefined);
  acelerarFollowupDoInbound.mockResolvedValue(undefined);
  drenarEventosDoInbound.mockResolvedValue(undefined);
  audit.mockResolvedValue(undefined);
});

describe("#4026 — classificação por mensagem", () => {
  it("golpe com prêmio e link encurtado passa do limiar padrão", () => {
    const veredito = classificarEntrada(GOLPE);
    expect(veredito.suspeito).toBe(true);
    expect(veredito.confianca).toBeGreaterThanOrEqual(LIMIAR_PADRAO);
    expect(veredito.sinais).toContain("link_encurtado");
  });

  it("conversa normal não tem sinal nenhum", () => {
    const veredito = classificarEntrada(NORMAL);
    expect(veredito).toEqual({ suspeito: false, confianca: 0, sinais: [] });
  });

  it("falso suporte pedindo regularização é golpe mesmo sem link", () => {
    const veredito = classificarEntrada(
      "Sou do suporte do banco. Sua conta será bloqueada, regularize seu cadastro agora.",
    );
    expect(vaiParaQuarentena(veredito, { ligado: true, limiar: LIMIAR_PADRAO })).toBe(true);
  });

  it("mídia sem legenda (texto vazio) nunca é suspeita", () => {
    expect(classificarEntrada("").suspeito).toBe(false);
    expect(classificarEntrada(null).suspeito).toBe(false);
  });
});

describe("#4026 — desligado de fábrica", () => {
  it("organização sem configuração não retém NADA, nem a confiança 1", () => {
    const opcao = lerOpcaoDoFiltroDeSpam({});
    expect(opcao).toEqual({ ligado: false, limiar: LIMIAR_PADRAO });
    expect(vaiParaQuarentena({ suspeito: true, confianca: 1, sinais: ["link_encurtado"] }, opcao)).toBe(
      false,
    );
  });

  it("limiar fora da faixa é ignorado (cai no padrão), não grampeado", () => {
    expect(lerOpcaoDoFiltroDeSpam({ filtro_de_spam: { ligado: true, limiar: 0 } }).limiar).toBe(
      LIMIAR_PADRAO,
    );
    expect(lerOpcaoDoFiltroDeSpam({ filtro_de_spam: { ligado: true, limiar: 1 } }).limiar).toBe(
      LIMIAR_PADRAO,
    );
  });

  it("com o filtro desligado a mensagem segue o caminho de hoje", async () => {
    const duplo = banco({ ligado: false });

    const retida = await avaliarQuarentenaDaEntrada(duplo.client, {
      organizationId: ORG,
      conversationId: CONVERSA,
      contactId: CONTATO,
      messageId: MENSAGEM,
      channelSessionId: CANAL,
      texto: GOLPE,
      origem: "teste",
    });

    expect(retida).toBe(false);
    expect(duplo.estado.quarentena).toHaveLength(0);
  });
});

describe("#4026 — a mensagem retida não acorda ninguém", () => {
  it("vai para quarentena e NÃO emite pedido de turno, demanda, campanha nem follow-up", async () => {
    const duplo = banco({ ligado: true });

    await aplicarEfeitosPosEntrada(duplo.client, entradaDeTeste(GOLPE));

    // 1. Retida, com o motivo e a confiança que a fila mostra.
    expect(duplo.estado.quarentena).toHaveLength(1);
    expect(duplo.estado.quarentena[0]?.message_id).toBe(MENSAGEM);
    expect(duplo.estado.quarentena[0]?.status).toBe("em_quarentena");
    expect(duplo.estado.quarentena[0]?.confianca).toBeGreaterThanOrEqual(LIMIAR_PADRAO);

    // 2. Nada de trabalho: nem turno, nem lead, nem campanha, nem follow-up.
    expect(despachos(duplo)).toHaveLength(0);
    expect(garantirLeadDaConversa).not.toHaveBeenCalled();
    expect(aplicarRespostaNaCampanha).not.toHaveBeenCalled();
    expect(acelerarFollowupDoInbound).not.toHaveBeenCalled();
    expect(drenarEventosDoInbound).not.toHaveBeenCalled();

    // 3. PERDA ZERO: a mensagem continua exatamente onde estava.
    expect(duplo.estado.mensagens).toHaveLength(1);
    expect((await resumoDaQuarentena(duplo.client, ORG)).perdidas).toBe(0);
  });

  it("não-regressão: mensagem normal abre demanda e pede o turno do agente", async () => {
    const duplo = banco({ ligado: true });

    await aplicarEfeitosPosEntrada(duplo.client, entradaDeTeste(NORMAL));

    expect(duplo.estado.quarentena).toHaveLength(0);
    expect(garantirLeadDaConversa).toHaveBeenCalledTimes(1);
    expect(despachos(duplo).length).toBeGreaterThan(0);
  });

  it("a mensagem retida é RECUPERÁVEL: liberar roda o turno que ficou pendente", async () => {
    const duplo = banco({ ligado: true });
    await aplicarEfeitosPosEntrada(duplo.client, entradaDeTeste(GOLPE));
    const retida = duplo.estado.quarentena[0];
    if (!retida) throw new Error("a mensagem suspeita não foi retida");
    expect(despachos(duplo)).toHaveLength(0);

    const liberacao = await liberarDaQuarentena(duplo.client, {
      organizationId: ORG,
      id: retida.id,
      userId: "usuario-1",
    });
    expect(liberacao.ok).toBe(true);
    if (!liberacao.ok) return;
    expect(liberacao.linha.status).toBe("liberada");

    // A liberação reusa os efeitos de produção — é o mesmo caminho, atrasado.
    await aplicarEfeitosPosEntrada(duplo.client, {
      ...entradaDeTeste(GOLPE),
      origem: "quarentena_liberada",
    });
    expect(despachos(duplo).length).toBeGreaterThan(0);
    expect(duplo.estado.mensagens).toHaveLength(1);
    expect((await resumoDaQuarentena(duplo.client, ORG)).perdidas).toBe(0);
  });

  it("liberar duas vezes não duplica trabalho (o segundo clique recebe ja_liberada)", async () => {
    const duplo = banco({ ligado: true });
    await aplicarEfeitosPosEntrada(duplo.client, entradaDeTeste(GOLPE));
    const retida = duplo.estado.quarentena[0];
    if (!retida) throw new Error("a mensagem suspeita não foi retida");

    await liberarDaQuarentena(duplo.client, { organizationId: ORG, id: retida.id, userId: "u-1" });
    const segunda = await liberarDaQuarentena(duplo.client, {
      organizationId: ORG,
      id: retida.id,
      userId: "u-2",
    });

    expect(segunda).toEqual({ ok: false, motivo: "ja_liberada" });
  });

  it("reentrega da mesma mensagem não abre uma segunda linha de quarentena", async () => {
    const duplo = banco({ ligado: true });
    await aplicarEfeitosPosEntrada(duplo.client, entradaDeTeste(GOLPE));
    await aplicarEfeitosPosEntrada(duplo.client, entradaDeTeste(GOLPE));

    expect(duplo.estado.quarentena).toHaveLength(1);
  });
});
