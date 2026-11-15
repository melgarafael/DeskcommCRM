/**
 * #3945 (fatia 2) — a ponta da tela: o nome que chega no payload vira o rótulo
 * do card, e o card NÃO depende de a lista de membros (`/team/assignable`) ter
 * carregado.
 *
 * O caminho do dado é payload → `buildCardInput` (`lib/kanban/card-state.ts:134`)
 * → `resolveLeadOwner` (`lib/kanban/owner.ts`) → `card.owner.name` →
 * `OwnerBadge` (`components/kanban/OwnerBadge.tsx:62`). Aqui se mede o meio:
 * com `owner_user_name` no lead, o nome aparece mesmo com `ownerNames`
 * indefinido — que é o estado de quem abre o quadro antes daquela rota
 * responder (ou de quem não pode lê-la).
 *
 * As réguas do aceite que moram nesta ponta:
 *
 *  · nome no payload VENCE o mapa do time (é o resolvido no servidor, do quadro);
 *  · `null` (olhei, não há cópia) e `undefined` (payload antigo) caem no mapa —
 *    o comportamento anterior a esta fatia, sem regressão;
 *  · sem nenhum dos dois, o nome é `null` e o `OwnerBadge` desenha "Responsável"
 *    — nunca "undefined", nunca e-mail cru.
 */
import { describe, expect, it } from "vitest";

import { buildCardInput } from "@/lib/kanban/card-state";
import { nomeLegivel } from "@/lib/kanban/nome-do-dono";
import { fundeRespostaNoCard, resolveLeadOwner } from "@/lib/kanban/owner";
import type { Lead } from "@/lib/types/leads";

const AGORA = new Date("2026-11-07T12:00:00.000Z");

const lead = (over: Record<string, unknown> = {}) =>
  ({
    id: "l-1",
    title: "Clínica Vitalis",
    value_cents: 0,
    currency: "BRL",
    tags: [],
    owner_kind: "user",
    owner_user_id: "u-1",
    owner_agent_id: null,
    owner_agent: null,
    next_action: null,
    score: null,
    created_at: "2026-11-01T12:00:00.000Z",
    stage_changed_at: "2026-11-06T12:00:00.000Z",
    ...over,
  }) as unknown as Parameters<typeof buildCardInput>[0];

const opts = { stageName: "Negociação", ownerNames: undefined, now: AGORA };

describe("nome do responsável no card — payload vence, ausência cai no anterior", () => {
  it("⭐ com `owner_user_name` no lead, o card mostra o nome sem o mapa do time", () => {
    const card = buildCardInput(lead({ owner_user_name: "Ana Souza" }), opts);

    expect(card.owner).toEqual({ kind: "user", name: "Ana Souza", agentVersion: null });
  });

  it("⭐ `owner_user_name` vence o mapa do time (o nome do servidor é o do quadro)", () => {
    const card = buildCardInput(lead({ owner_user_name: "Ana Souza" }), {
      ...opts,
      ownerNames: new Map([["u-1", "Ana (nome antigo da lista)"]]),
    });

    expect(card.owner.name).toBe("Ana Souza");
  });

  it("⭐ `null` no payload cai no mapa do time — comportamento anterior intacto", () => {
    const card = buildCardInput(lead({ owner_user_name: null }), {
      ...opts,
      ownerNames: new Map([["u-1", "Ana Souza"]]),
    });

    expect(card.owner.name).toBe("Ana Souza");
  });

  it("payload antigo (campo ausente) também cai no mapa — nada regride", () => {
    const card = buildCardInput(lead(), {
      ...opts,
      ownerNames: new Map([["u-1", "Ana Souza"]]),
    });

    expect(card.owner.name).toBe("Ana Souza");
  });

  it("sem nome em lugar nenhum: `null` — o badge diz 'Responsável', nunca 'undefined'", () => {
    const card = buildCardInput(lead({ owner_user_name: null }), opts);

    expect(card.owner).toEqual({ kind: "user", name: null, agentVersion: null });
    expect(resolveLeadOwner(lead({}) as Lead, undefined).name).toBeNull();
  });
});

describe("responsável que saiu da equipe e troca de dono no cache", () => {
  it("⭐ `owner_user_removed` vira `foraDaEquipe` no card, com o nome mantido", () => {
    const card = buildCardInput(lead({ owner_user_name: "Bia", owner_user_removed: true }), opts);

    expect(card.owner).toEqual({ kind: "user", name: "Bia", agentVersion: null, foraDaEquipe: true });
  });

  it("dono na equipe não ganha a chave `foraDaEquipe`", () => {
    const card = buildCardInput(lead({ owner_user_name: "Ana Souza" }), opts);

    expect("foraDaEquipe" in card.owner).toBe(false);
  });

  it("⭐ a resposta da mutação troca o dono: o nome do dono ANTERIOR sai do card", () => {
    const noCache = lead({ owner_user_name: "Ana Souza", owner_user_removed: true }) as unknown as Lead;
    const fundido = fundeRespostaNoCard(noCache, { owner_user_id: "u-2", updated_at: "x" } as Partial<Lead>);

    expect(fundido.owner_user_id).toBe("u-2");
    expect(fundido.owner_user_name).toBeUndefined();
    expect(fundido.owner_user_removed).toBeUndefined();
    // O card cai no mapa do time, que conhece o dono novo.
    expect(resolveLeadOwner(fundido, new Map([["u-2", "Beto Lima"]])).name).toBe("Beto Lima");
  });

  it("a resposta sem troca de dono mantém o nome resolvido pelo quadro", () => {
    const noCache = lead({ owner_user_name: "Ana Souza" }) as unknown as Lead;
    const fundido = fundeRespostaNoCard(noCache, { owner_user_id: "u-1", stage_id: "e2" } as Partial<Lead>);

    expect(fundido.owner_user_name).toBe("Ana Souza");
  });
});

describe("nomeLegivel — o que pode virar rótulo", () => {
  it("colapsa espaço interno e apara as pontas", () => {
    expect(nomeLegivel("  Ana   Souza ")).toBe("Ana Souza");
  });

  it("vazio, espaço e ausência não são nome", () => {
    expect(nomeLegivel("")).toBeNull();
    expect(nomeLegivel("   ")).toBeNull();
    expect(nomeLegivel(null)).toBeNull();
    expect(nomeLegivel(undefined)).toBeNull();
  });

  it("e-mail cru não é nome — `full_name` é campo livre e recebe e-mail no cadastro", () => {
    expect(nomeLegivel("ana@exemplo.com")).toBeNull();
    expect(nomeLegivel("  Ana <ana@exemplo.com>  ")).toBeNull();
  });

  it("nome com acento e sobrenome composto passa inteiro", () => {
    expect(nomeLegivel("João da Silva")).toBe("João da Silva");
  });
});
