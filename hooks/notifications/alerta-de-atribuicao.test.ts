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
 * Roda com: npx vitest run hooks/notifications/alerta-de-atribuicao.test.ts
 */
import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { entregarAvisoFalso, canais } = vi.hoisted(() => ({
  entregarAvisoFalso: vi.fn(),
  canais: {} as Record<string, (p: unknown) => void>,
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

import {
  avisosDoNegocio,
  estadoDoAntigo,
  estadoDoNovo,
  type EstadoVisto,
} from "./aviso-de-negocio";
import { useCrmAlerts } from "./useCrmAlerts";

const VENDEDOR = "vendedor-1";
const OUTRO = "outro-vendedor";

/** O evento do Realtime como o baseline o entrega: `new` completo, `old` = PK. */
function eventoUpdate(novo: Record<string, unknown>, antigo: Record<string, unknown> | null): unknown {
  return { eventType: "UPDATE", new: novo, old: antigo };
}

function negocio(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { id: "lead-1", title: "Ana Lima", pipeline_id: "pipe-1", status: "open", ...extra };
}

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

describe("o hook real, alimentado pelo canal do Realtime", () => {
  let aoAtualizarNegocio: (p: unknown) => void;

  beforeEach(() => {
    entregarAvisoFalso.mockClear();
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
    // Primeiro evento do negócio já ganho: sem histórico, não notifica.
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
