/**
 * "LEAD ATRIBUÍDO A VOCÊ" SÓ QUANDO O RESPONSÁVEL MUDA — ISSUE #3040.
 *
 * O defeito (1.84.0): cada mensagem enviada pelo vendedor num negócio do qual
 * ele JÁ é responsável gerava a notificação, uma por mensagem. O `old` do
 * UPDATE do Realtime (`postgres_changes`) traz apenas a chave primária enquanto
 * a tabela não tem `REPLICA IDENTITY FULL` — `crm_leads` não tem nenhuma no
 * baseline —, então `ownerAntes` era sempre `null` e QUALQUER UPDATE passava no
 * teste `owner !== ownerAntes`. Com o `#2958` cada resposta carimba
 * `last_activity_at`, e o carimbo virou notificação.
 *
 * A prova é pela FUNÇÃO que decide a notificação (`../aviso-de-negocio.ts`,
 * extraída do hook para ser medível sem DOM) e pelo HOOK real alimentado pelo
 * canal do Realtime — os dois níveis, porque a regra certa com o hook
 * alimentando o histórico errado continuaria notificando a cada mensagem.
 *
 * ─── A outra ponta: #3224 ───────────────────────────────────────────────────
 *
 * Sem histórico a memória calava, e o PRIMEIRO evento de um negócio — a
 * atribuição num negócio parado, a aba logo após recarregar, A→B com a
 * visibilidade padrão — justamente por isso não saía. O hook passou a
 * perguntar ao BANCO (`./eventos-do-negocio.ts` + `avisosDoBanco`), casando o
 * evento da transação com o `updated_at` do UPDATE. Os casos deles estão no
 * bloco final deste arquivo, e os da #3040 seguem intactos: histórico conhecido
 * decide sem consultar, e evento de outra transação não vira aviso.
 *
 * Roda com: npx vitest run hooks/notifications/alerta-de-atribuicao.test.ts
 */
import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { entregarAvisoFalso, canais, eventosDoBancoFalso } = vi.hoisted(() => ({
  entregarAvisoFalso: vi.fn(),
  canais: {} as Record<string, (p: unknown) => void>,
  eventosDoBancoFalso: vi.fn(async (_leadId: string): Promise<unknown[]> => []),
}));

vi.mock("@/lib/notifications/deliver", () => ({ entregarAviso: entregarAvisoFalso }));
vi.mock("@/hooks/auth/AuthProvider", () => ({
  useActiveOrg: () => ({ orgId: "org-1" }),
  useUser: () => ({ id: "vendedor-1", email: "vendedor@empresa.test", full_name: "Vendedor" }),
}));
vi.mock("@/hooks/realtime/useRealtimeChannel", () => ({
  useRealtimeChannel: (opts: { name: string; onChange: (p: unknown) => void }) => {
    canais[opts.name] = opts.onChange;
    return { status: "subscribed" };
  },
}));
vi.mock("./eventos-do-negocio", () => ({
  buscaEventosDoNegocio: (leadId: string) => eventosDoBancoFalso(leadId),
}));

import {
  avisosDoBanco,
  avisosDoNegocio,
  carimboDaTransacao,
  estadoDoAntigo,
  estadoDoNovo,
  type EstadoVisto,
  type EventoDeNegocio,
} from "./aviso-de-negocio";
import { useCrmAlerts } from "./useCrmAlerts";

const VENDEDOR = "vendedor-1";
const OUTRO = "outro-vendedor";

/** O carimbo da transação do primeiro UPDATE — `now()` igual nos dois lados. */
const CARIMBO = "2026-10-25T12:00:00.000Z";
/** Outra transação, cinco minutos depois. */
const CARIMBO_DEPOIS = "2026-10-25T12:05:00.000Z";

/** O evento do Realtime como o baseline o entrega: `new` completo, `old` = PK. */
function eventoUpdate(novo: Record<string, unknown>, antigo: Record<string, unknown> | null): unknown {
  return { eventType: "UPDATE", new: novo, old: antigo };
}

function negocio(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { id: "lead-1", title: "Ana Lima", pipeline_id: "pipe-1", status: "open", ...extra };
}

/** Uma linha de `event_log` como a rota devolve — org-1 por padrão, como a aba. */
function eventoDoBanco(extra: Partial<EventoDeNegocio> = {}): EventoDeNegocio {
  return {
    organization_id: "org-1",
    event_type: "lead.assigned",
    entity_id: "lead-1",
    created_at: CARIMBO,
    to_user_id: VENDEDOR,
    ...extra,
  };
}

/** Esvazia a fila: a promessa da consulta ao banco já resolveu e o `.then` rodou. */
const esvaziarFila = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe("a função que decide a notificação (#3040)", () => {
  it("(1) UPDATE sem mudança de responsável NÃO notifica — é o defeito", () => {
    const anterior: EstadoVisto = { owner_user_id: VENDEDOR, status: "open" };
    // É o carimbo do #2958: só `last_activity_at` muda, o resto está igual.
    expect(avisosDoNegocio(anterior, estadoDoNovo(negocio({ owner_user_id: VENDEDOR })), VENDEDOR)).toEqual([]);
    // A mesma coisa logo depois, com a memória já carimbada pelo próprio hook.
    expect(avisosDoNegocio(anterior, { owner_user_id: VENDEDOR, status: "open" }, VENDEDOR)).toEqual([]);
  });

  it("(2) atribuição de verdade notifica — de A para B, e de ninguém para A", () => {
    expect(
      avisosDoNegocio(
        { owner_user_id: OUTRO, status: "open" },
        { owner_user_id: VENDEDOR, status: "open" },
        VENDEDOR,
      ),
    ).toEqual(["lead_assigned"]);
    expect(
      avisosDoNegocio(
        { owner_user_id: null, status: "open" },
        { owner_user_id: VENDEDOR, status: "open" },
        VENDEDOR,
      ),
    ).toEqual(["lead_assigned"]);
    // E não notifica quem não é o responsável novo.
    expect(
      avisosDoNegocio(
        { owner_user_id: null, status: "open" },
        { owner_user_id: OUTRO, status: "open" },
        VENDEDOR,
      ),
    ).toEqual([]);
  });

  it("(3) lead_won/lead_lost seguem o mesmo critério — mudança de status, não qualquer UPDATE", () => {
    const meu: EstadoVisto = { owner_user_id: VENDEDOR, status: "open" };
    expect(avisosDoNegocio(meu, { owner_user_id: VENDEDOR, status: "won" }, VENDEDOR)).toEqual(["lead_won"]);
    expect(avisosDoNegocio(meu, { owner_user_id: VENDEDOR, status: "lost" }, VENDEDOR)).toEqual(["lead_lost"]);
    // Update irrelevante com o status já fechado: silêncio.
    const ganho: EstadoVisto = { owner_user_id: VENDEDOR, status: "won" };
    expect(avisosDoNegocio(ganho, { owner_user_id: VENDEDOR, status: "won" }, VENDEDOR)).toEqual([]);
    const perdido: EstadoVisto = { owner_user_id: VENDEDOR, status: "lost" };
    expect(avisosDoNegocio(perdido, { owner_user_id: VENDEDOR, status: "lost" }, VENDEDOR)).toEqual([]);
  });

  it("(4) o primeiro evento de um negócio sem histórico conhecido não notifica", () => {
    // Pela FUNÇÃO sozinha o silêncio continua sendo a resposta certa — quem
    // cobre este caso agora é o banco, no hook (issue #3224, bloco final).
    expect(avisosDoNegocio(null, { owner_user_id: VENDEDOR, status: "won" }, VENDEDOR)).toEqual([]);
    expect(avisosDoNegocio(null, { owner_user_id: VENDEDOR, status: "lost" }, VENDEDOR)).toEqual([]);
    expect(avisosDoNegocio(null, { owner_user_id: VENDEDOR, status: "open" }, VENDEDOR)).toEqual([]);
  });

  it("o `old` sem os campos é DESCONHECIDO, não 'responsável ninguém'", () => {
    // O formato medido em produção: sem REPLICA IDENTITY FULL vem só a PK.
    expect(estadoDoAntigo({ id: "lead-1" })).toBeNull();
    expect(estadoDoAntigo(null)).toBeNull();
    expect(estadoDoAntigo({})).toBeNull();
    // Com os campos (instalação com REPLICA IDENTITY FULL) ele é histórico.
    expect(estadoDoAntigo({ owner_user_id: null, status: "open" })).toEqual({
      owner_user_id: null,
      status: "open",
    });
  });
});

describe("a regra que decide pelo banco quando a sessão não tem histórico (#3224)", () => {
  const carimbo = carimboDaTransacao(CARIMBO) as string;

  const decide = (entrada: Partial<Parameters<typeof avisosDoBanco>[0]> = {}): ReturnType<typeof avisosDoBanco> =>
    avisosDoBanco({
      organizationId: "org-1",
      leadId: "lead-1",
      carimboDoUpdate: carimbo,
      eventos: [eventoDoBanco()],
      novo: { owner_user_id: VENDEDOR, status: "open" },
      userId: VENDEDOR,
      ...entrada,
    });

  it("evento da MESMA transação, do MESMO negócio e da MESMA org decide", () => {
    expect(decide()).toEqual(["lead_assigned"]);
    expect(decide({ eventos: [eventoDoBanco({ event_type: "lead.won" })], novo: { owner_user_id: VENDEDOR, status: "won" } })).toEqual(["lead_won"]);
    expect(decide({ eventos: [eventoDoBanco({ event_type: "lead.lost" })], novo: { owner_user_id: VENDEDOR, status: "lost" } })).toEqual(["lead_lost"]);
  });

  it("(D) outra organização → silêncio, mesmo com o evento certinho", () => {
    expect(decide({ eventos: [eventoDoBanco({ organization_id: "org-de-fora" })] })).toEqual([]);
  });

  it("outro negócio → silêncio (o evento é do vizinho)", () => {
    expect(decide({ eventos: [eventoDoBanco({ entity_id: "lead-9" })] })).toEqual([]);
  });

  it("evento de OUTRA transação → silêncio: é a #3040 que não volta", () => {
    // A atribuição de ontem, que a aba nunca viu: não casa com o carimbo de
    // hoje, então a resposta do vendedor continua calada.
    expect(decide({ eventos: [eventoDoBanco({ created_at: "2026-10-24T09:00:00.000Z" })] })).toEqual([]);
    // E sem carimbo legível não há transação a casar.
    expect(decide({ carimboDoUpdate: "" })).toEqual([]);
  });

  it("dono agente não vira aviso de gente: to_user_id nulo não é para mim", () => {
    expect(decide({ eventos: [eventoDoBanco({ to_user_id: null })] })).toEqual([]);
    // Nem quando quem fala do estado novo é outro vendedor.
    expect(decide({ eventos: [eventoDoBanco({ to_user_id: OUTRO })] })).toEqual([]);
  });

  it("status novo diferente do evento: ganho no banco com estado aberto não avisa", () => {
    expect(
      decide({ eventos: [eventoDoBanco({ event_type: "lead.won" })], novo: { owner_user_id: VENDEDOR, status: "open" } }),
    ).toEqual([]);
  });

  it("quem não é o responsável atual não recebe nada, como na memória", () => {
    expect(decide({ novo: { owner_user_id: OUTRO, status: "open" } })).toEqual([]);
    expect(decide({ novo: { owner_user_id: null, status: "won" } })).toEqual([]);
  });
});

describe("o hook real, alimentado pelo canal do Realtime", () => {
  let aoAtualizarNegocio: (p: unknown) => void;

  beforeEach(() => {
    entregarAvisoFalso.mockClear();
    eventosDoBancoFalso.mockReset();
    eventosDoBancoFalso.mockResolvedValue([]);
    renderHook(() => useCrmAlerts());
    const canal = canais["alerts-leads-org-1"];
    if (!canal) throw new Error("o hook não assinou o canal de negócios");
    aoAtualizarNegocio = canal;
  });

  it("duas mensagens do vendedor no negócio dele não notificam — o defeito da #3040", () => {
    aoAtualizarNegocio(eventoUpdate(negocio({ owner_user_id: VENDEDOR, last_activity_at: "2026-10-21T10:00:00Z" }), { id: "lead-1" }));
    expect(entregarAvisoFalso).not.toHaveBeenCalled();
    aoAtualizarNegocio(eventoUpdate(negocio({ owner_user_id: VENDEDOR, last_activity_at: "2026-10-21T10:04:00Z" }), { id: "lead-1" }));
    aoAtualizarNegocio(eventoUpdate(negocio({ owner_user_id: VENDEDOR, last_activity_at: "2026-10-21T10:09:00Z" }), { id: "lead-1" }));
    expect(entregarAvisoFalso).not.toHaveBeenCalled();
  });

  it("a atribuição de verdade notifica, com o título e o destino do negócio", () => {
    // O vendedor já viu este negócio com outro responsável…
    aoAtualizarNegocio(eventoUpdate(negocio({ owner_user_id: OUTRO }), { id: "lead-1" }));
    expect(entregarAvisoFalso).not.toHaveBeenCalled();
    // …e o evento da atribuição (de novo, com `old` só de PK) notifica.
    aoAtualizarNegocio(eventoUpdate(negocio({ owner_user_id: VENDEDOR }), { id: "lead-1" }));
    expect(entregarAvisoFalso).toHaveBeenCalledTimes(1);
    expect(entregarAvisoFalso).toHaveBeenCalledWith(
      expect.objectContaining({
        category: "lead_assigned",
        kind: "lead_assigned",
        title: "Lead atribuído a você",
        body: "Ana Lima",
        tag: "lead-1",
        href: "/app/pipelines/pipe-1",
      }),
    );
  });

  it("o negócio sem ninguém atribuído também notifica quem recebe a atribuição", () => {
    aoAtualizarNegocio(eventoUpdate(negocio({ owner_user_id: null }), { id: "lead-1" }));
    aoAtualizarNegocio(eventoUpdate(negocio({ owner_user_id: VENDEDOR }), { id: "lead-1" }));
    expect(entregarAvisoFalso).toHaveBeenCalledTimes(1);
  });

  it("ganho e perdido só quando o status muda de verdade, e o primeiro evento fica quieto", () => {
    // Primeiro evento do negócio já ganho: sem histórico, não notifica — e
    // sem `updated_at` nesta fixture não há transação a perguntar ao banco
    // (o caminho dele está no bloco #3224, abaixo).
    aoAtualizarNegocio(eventoUpdate(negocio({ owner_user_id: VENDEDOR, status: "won" }), { id: "lead-1" }));
    expect(entregarAvisoFalso).not.toHaveBeenCalled();
    // Update irrelevante com o status já ganho: continua quieto.
    aoAtualizarNegocio(eventoUpdate(negocio({ owner_user_id: VENDEDOR, status: "won" }), { id: "lead-1" }));
    expect(entregarAvisoFalso).not.toHaveBeenCalled();
    // A transição aberto → ganho, num negócio de outro id, notifica.
    aoAtualizarNegocio(eventoUpdate(negocio({ id: "lead-2", owner_user_id: VENDEDOR, status: "open" }), { id: "lead-2" }));
    aoAtualizarNegocio(eventoUpdate(negocio({ id: "lead-2", owner_user_id: VENDEDOR, status: "won" }), { id: "lead-2" }));
    expect(entregarAvisoFalso).toHaveBeenCalledTimes(1);
    expect(entregarAvisoFalso).toHaveBeenCalledWith(
      expect.objectContaining({ category: "lead_won", title: "Lead ganho", tag: "lead-2" }),
    );
    // E aberto → perdido também.
    aoAtualizarNegocio(eventoUpdate(negocio({ id: "lead-3", owner_user_id: VENDEDOR, status: "open" }), { id: "lead-3" }));
    aoAtualizarNegocio(eventoUpdate(negocio({ id: "lead-3", owner_user_id: VENDEDOR, status: "lost" }), { id: "lead-3" }));
    expect(entregarAvisoFalso).toHaveBeenCalledTimes(2);
    expect(entregarAvisoFalso).toHaveBeenLastCalledWith(
      expect.objectContaining({ category: "lead_lost", title: "Lead perdido", tag: "lead-3" }),
    );
  });

  it("instalação com REPLICA IDENTITY FULL (old completo) volta a notificar já no primeiro evento", () => {
    aoAtualizarNegocio(
      eventoUpdate(negocio({ owner_user_id: VENDEDOR }), { owner_user_id: null, status: "open" }),
    );
    expect(entregarAvisoFalso).toHaveBeenCalledTimes(1);
    expect(entregarAvisoFalso).toHaveBeenCalledWith(expect.objectContaining({ category: "lead_assigned" }));
  });
});

describe("o hook pergunta ao banco quando a sessão nunca viu o negócio (#3224)", () => {
  let aoAtualizarNegocio: (p: unknown) => void;

  beforeEach(() => {
    entregarAvisoFalso.mockClear();
    eventosDoBancoFalso.mockReset();
    eventosDoBancoFalso.mockResolvedValue([]);
    renderHook(() => useCrmAlerts());
    const canal = canais["alerts-leads-org-1"];
    if (!canal) throw new Error("o hook não assinou o canal de negócios");
    aoAtualizarNegocio = canal;
  });

  it("(A) negócio nunca visto: a atribuição sai pelo banco — e sai uma vez só", async () => {
    eventosDoBancoFalso.mockResolvedValue([eventoDoBanco()]);
    // O formato medido em produção: `old` só com a PK (sem REPLICA IDENTITY
    // FULL) e memória vazia — o primeiro UPDATE que a aba recebe já é a
    // atribuição, e hoje isso ficava calado.
    const atribuicao = eventoUpdate(negocio({ owner_user_id: VENDEDOR, updated_at: CARIMBO }), { id: "lead-1" });
    aoAtualizarNegocio(atribuicao);
    await vi.waitFor(() => expect(entregarAvisoFalso).toHaveBeenCalledTimes(1));
    expect(entregarAvisoFalso).toHaveBeenCalledWith(
      expect.objectContaining({
        category: "lead_assigned",
        kind: "lead_assigned",
        title: "Lead atribuído a você",
        body: "Ana Lima",
        tag: "lead-1",
        href: "/app/pipelines/pipe-1",
      }),
    );
    // Uma pergunta por negócio: a MESMA imagem entregue de novo não consulta
    // nem repete o aviso — o "não dispara duas vezes para o mesmo evento".
    aoAtualizarNegocio(atribuicao);
    await esvaziarFila();
    expect(eventosDoBancoFalso).toHaveBeenCalledTimes(1);
    expect(eventosDoBancoFalso).toHaveBeenCalledWith("lead-1");
    expect(entregarAvisoFalso).toHaveBeenCalledTimes(1);
  });

  it("(A) ganho e perdido de negócio nunca visto também saem", async () => {
    eventosDoBancoFalso.mockResolvedValue([eventoDoBanco({ event_type: "lead.won" })]);
    aoAtualizarNegocio(
      eventoUpdate(negocio({ owner_user_id: VENDEDOR, status: "won", updated_at: CARIMBO }), { id: "lead-1" }),
    );
    await vi.waitFor(() => expect(entregarAvisoFalso).toHaveBeenCalledTimes(1));
    expect(entregarAvisoFalso).toHaveBeenCalledWith(
      expect.objectContaining({ category: "lead_won", kind: "lead_won", title: "Lead ganho", tag: "lead-1" }),
    );

    eventosDoBancoFalso.mockResolvedValue([
      eventoDoBanco({ event_type: "lead.lost", entity_id: "lead-2", created_at: CARIMBO_DEPOIS }),
    ]);
    aoAtualizarNegocio(
      eventoUpdate(
        negocio({ id: "lead-2", owner_user_id: VENDEDOR, status: "lost", updated_at: CARIMBO_DEPOIS }),
        { id: "lead-2" },
      ),
    );
    await vi.waitFor(() => expect(entregarAvisoFalso).toHaveBeenCalledTimes(2));
    expect(entregarAvisoFalso).toHaveBeenLastCalledWith(
      expect.objectContaining({ category: "lead_lost", kind: "lead_lost", title: "Lead perdido", tag: "lead-2" }),
    );
  });

  it("(A) atribuição vem do banco e ganho da memória: dois eventos, dois avisos", async () => {
    eventosDoBancoFalso.mockResolvedValue([eventoDoBanco()]);
    aoAtualizarNegocio(
      eventoUpdate(negocio({ owner_user_id: VENDEDOR, updated_at: CARIMBO }), { id: "lead-1" }),
    );
    await vi.waitFor(() => expect(entregarAvisoFalso).toHaveBeenCalledTimes(1));
    // A partir daqui a memória tem o negócio: o ganho é transição (hoje o
    // único caminho), o banco não é consultado de novo.
    aoAtualizarNegocio(
      eventoUpdate(negocio({ owner_user_id: VENDEDOR, status: "won", updated_at: CARIMBO_DEPOIS }), { id: "lead-1" }),
    );
    expect(entregarAvisoFalso).toHaveBeenCalledTimes(2);
    expect(entregarAvisoFalso).toHaveBeenLastCalledWith(
      expect.objectContaining({ category: "lead_won", title: "Lead ganho" }),
    );
    expect(eventosDoBancoFalso).toHaveBeenCalledTimes(1);
  });

  it("(B) histórico conhecido: aviso igual hoje, e o banco nem é consultado", () => {
    // A sessão já viu este negócio com outro responsável…
    aoAtualizarNegocio(eventoUpdate(negocio({ owner_user_id: OUTRO, updated_at: CARIMBO }), { id: "lead-1" }));
    expect(entregarAvisoFalso).not.toHaveBeenCalled();
    // …e a atribuição notifica pela memória, como antes da #3224.
    aoAtualizarNegocio(eventoUpdate(negocio({ owner_user_id: VENDEDOR, updated_at: CARIMBO_DEPOIS }), { id: "lead-1" }));
    expect(entregarAvisoFalso).toHaveBeenCalledTimes(1);
    expect(eventosDoBancoFalso).not.toHaveBeenCalled();
  });

  it("(B) #3040 não volta: evento do banco de OUTRA transação não vira aviso", async () => {
    // A atribuição de ONTEM, que a aba nunca viu, segue gravada no banco…
    eventosDoBancoFalso.mockResolvedValue([
      eventoDoBanco({ created_at: "2026-10-24T09:00:00.000Z" }),
    ]);
    // …e a primeira coisa que a aba vê hoje é o carimbo da própria resposta.
    aoAtualizarNegocio(
      eventoUpdate(
        negocio({
          owner_user_id: VENDEDOR,
          updated_at: CARIMBO,
          last_activity_at: CARIMBO,
        }),
        { id: "lead-1" },
      ),
    );
    await esvaziarFila();
    expect(entregarAvisoFalso).not.toHaveBeenCalled();
  });

  it("(C) a mesma imagem de UPDATE entregue de novo não repete o aviso nem consulta duas vezes", () => {
    // Primeiro evento, negócio de OUTRO responsável: não é meu, não pergunta.
    aoAtualizarNegocio(eventoUpdate(negocio({ owner_user_id: OUTRO, updated_at: CARIMBO }), { id: "lead-1" }));
    // A atribuição notifica uma vez…
    aoAtualizarNegocio(eventoUpdate(negocio({ owner_user_id: VENDEDOR, updated_at: CARIMBO_DEPOIS }), { id: "lead-1" }));
    expect(entregarAvisoFalso).toHaveBeenCalledTimes(1);
    // …e a MESMA imagem, entregue de novo (reentrega do canal), não repete:
    // a memória já registra o estado do evento, não há nova transição.
    aoAtualizarNegocio(eventoUpdate(negocio({ owner_user_id: VENDEDOR, updated_at: CARIMBO_DEPOIS }), { id: "lead-1" }));
    expect(entregarAvisoFalso).toHaveBeenCalledTimes(1);
    expect(eventosDoBancoFalso).not.toHaveBeenCalled();
  });

  it("(D) evento de outra organização nunca vira aviso", async () => {
    eventosDoBancoFalso.mockResolvedValue([
      eventoDoBanco({ organization_id: "org-de-fora" }),
    ]);
    aoAtualizarNegocio(
      eventoUpdate(negocio({ owner_user_id: VENDEDOR, updated_at: CARIMBO }), { id: "lead-1" }),
    );
    await esvaziarFila();
    expect(entregarAvisoFalso).not.toHaveBeenCalled();
  });
});
