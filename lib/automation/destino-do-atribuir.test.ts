/**
 * #3804 — a resolução do DESTINO da ação `assign_owner` quando ele não está
 * escrito na regra ("responsável do negócio", "dono da carteira do contato").
 *
 * A função é PURA e é o contrato que a #3803 vai reusar (o aviso no WhatsApp
 * para o responsável): recebe (negócio, contato, configuração) e devolve
 * (user_id, motivo). Cada caso aqui é uma linha da cadeia de decisão, e o
 * `motivo` é o que a Atividade registra — sem ele, a regra entrega o negócio a
 * alguém e ninguém sabe por quê.
 *
 * O que este arquivo NÃO prova (e o teste da ação prova): que o executor usa a
 * resolução, e que o banco aceita a configuração.
 */
import { describe, expect, it } from "vitest";

import {
  resolverDestinoDoAtribuir,
  type DestinoResolvido,
} from "@/lib/automation/destino-do-atribuir";

/** Ids de gente de verdade — a forma que o banco grava. */
const X = "11111111-1111-4111-8111-111111111111";
const Y = "22222222-2222-4222-8222-222222222222";
const FIXO = "33333333-3333-4333-8333-333333333333";

const COM_RESPONSAVEL = { id: "lead-1", owner_user_id: X, owner_kind: "user" };
const SEM_RESPONSAVEL = { id: "lead-1", owner_user_id: null, owner_kind: null };
const CONTATO_COM_CARTEIRA = { id: "contato-1", carteira_user_id: Y };
const CONTATO_SEM_CARTEIRA = { id: "contato-1", carteira_user_id: null };

/** Os dois destinos, nesta ordem: o responsável do negócio e depois a carteira. */
const DESTINOS: Array<"responsavel_do_negocio" | "dono_da_carteira"> = [
  "responsavel_do_negocio",
  "dono_da_carteira",
];

const destinoCom = (fallback: unknown) => ({ modo: "destino", destinos: DESTINOS, fallback });
const FALLBACK_FIXO = { modo: "fixo", user_id: FIXO };
const FALLBACK_RODIZIO = { modo: "rodizio", fila: [{ user_id: X, pausado: false }] };

const elosDescartados = (resolvido: DestinoResolvido) =>
  resolvido.descartes.map((d) => `${d.elo}:${d.motivo}`);

describe("resolverDestinoDoAtribuir — a cadeia de destinos (#3804)", () => {
  it("o responsável do negócio é o destino quando o card tem dono", () => {
    const r = resolverDestinoDoAtribuir(COM_RESPONSAVEL, CONTATO_COM_CARTEIRA, destinoCom(FALLBACK_FIXO));

    expect(r).toEqual({ user_id: X, motivo: "responsavel_do_negocio", descartes: [] });
  });

  it("sem responsável no negócio, o dono da carteira do contato recebe — e o motivo diz por quê", () => {
    const r = resolverDestinoDoAtribuir(SEM_RESPONSAVEL, CONTATO_COM_CARTEIRA, destinoCom(FALLBACK_FIXO));

    expect(r.user_id).toBe(Y);
    expect(r.motivo).toBe("dono_da_carteira");
    // A Atividade mostra a cadeia: o primeiro elo foi tentado e não serviu.
    expect(elosDescartados(r)).toEqual(["responsavel_do_negocio:ausente"]);
  });

  it("sem nenhum dos dois, cai na PESSOA FIXA do fallback", () => {
    const r = resolverDestinoDoAtribuir(
      SEM_RESPONSAVEL,
      CONTATO_SEM_CARTEIRA,
      destinoCom(FALLBACK_FIXO),
    );

    expect(r.user_id).toBe(FIXO);
    expect(r.motivo).toBe("fallback_fixo");
    expect(elosDescartados(r)).toEqual([
      "responsavel_do_negocio:ausente",
      "dono_da_carteira:ausente",
    ]);
  });

  it("sem nenhum dos dois, cai no RODÍZIO do fallback — quem escolhe a pessoa é o banco", () => {
    const r = resolverDestinoDoAtribuir(
      SEM_RESPONSAVEL,
      CONTATO_SEM_CARTEIRA,
      destinoCom(FALLBACK_RODIZIO),
    );

    // `user_id` nulo aqui não é "ninguém": é "o banco decide na hora da atribuição".
    expect(r).toEqual({
      user_id: null,
      motivo: "fallback_rodizio",
      descartes: [
        { elo: "responsavel_do_negocio", motivo: "ausente" },
        { elo: "dono_da_carteira", motivo: "ausente" },
      ],
    });
  });

  it("destino com número (não é id de usuário) não explode: descarta e cai no fallback, com motivo", () => {
    const negocio = { id: "lead-1", owner_user_id: 4321, owner_kind: "user" };
    const contato = { id: "contato-1", carteira_user_id: "sem-dono" };

    const r = resolverDestinoDoAtribuir(negocio, contato, destinoCom(FALLBACK_FIXO));

    expect(r.user_id).toBe(FIXO);
    expect(r.motivo).toBe("fallback_fixo");
    expect(elosDescartados(r)).toEqual([
      "responsavel_do_negocio:id_invalido",
      "dono_da_carteira:id_invalido",
    ]);
  });

  it("destino apontando para usuário inexistente (recusado por quem chama) também cai no fallback", () => {
    // Quem chama confere se a pessoa é membro ativo da organização e passa aqui
    // o que recusou — a função continua pura, sem tocar no banco.
    const r = resolverDestinoDoAtribuir(COM_RESPONSAVEL, CONTATO_SEM_CARTEIRA, destinoCom(FALLBACK_FIXO), [
      X,
    ]);

    expect(r.user_id).toBe(FIXO);
    expect(r.motivo).toBe("fallback_fixo");
    expect(elosDescartados(r)).toEqual([
      "responsavel_do_negocio:recusado",
      "dono_da_carteira:ausente",
    ]);
  });

  it("o dono do card que é a IA (owner_kind 'agent') não é destino humano: a cadeia segue", () => {
    const negocio = { id: "lead-1", owner_user_id: X, owner_kind: "agent" };

    const r = resolverDestinoDoAtribuir(negocio, CONTATO_COM_CARTEIRA, destinoCom(FALLBACK_FIXO));

    expect(r.user_id).toBe(Y);
    expect(r.motivo).toBe("dono_da_carteira");
    expect(elosDescartados(r)).toEqual(["responsavel_do_negocio:ausente"]);
  });

  it("a ORDEM da configuração é a ordem da cadeia", () => {
    const invertido = {
      modo: "destino",
      destinos: ["dono_da_carteira", "responsavel_do_negocio"],
      fallback: FALLBACK_FIXO,
    };

    const r = resolverDestinoDoAtribuir(COM_RESPONSAVEL, CONTATO_COM_CARTEIRA, invertido);

    expect(r.user_id).toBe(Y);
    expect(r.motivo).toBe("dono_da_carteira");
  });

  it("configuração incompleta não atribui a ninguém — e diz que foi por isso", () => {
    const semFallback = { modo: "destino", destinos: DESTINOS };

    const r = resolverDestinoDoAtribuir(SEM_RESPONSAVEL, CONTATO_SEM_CARTEIRA, semFallback);

    expect(r).toEqual({
      user_id: null,
      motivo: "sem_destino",
      descartes: [
        { elo: "responsavel_do_negocio", motivo: "ausente" },
        { elo: "dono_da_carteira", motivo: "ausente" },
      ],
    });
  });

  it("entrada torta (negócio/contato nulos, modo desconhecido) devolve sem_destino em vez de estourar", () => {
    expect(resolverDestinoDoAtribuir(null, null, { modo: "destino", destinos: DESTINOS })).toEqual({
      user_id: null,
      motivo: "sem_destino",
      descartes: [
        { elo: "responsavel_do_negocio", motivo: "ausente" },
        { elo: "dono_da_carteira", motivo: "ausente" },
      ],
    });
    expect(resolverDestinoDoAtribuir(undefined, undefined, { modo: "outra-coisa" })).toEqual({
      user_id: null,
      motivo: "sem_destino",
      descartes: [],
    });
    expect(resolverDestinoDoAtribuir(COM_RESPONSAVEL, null, null)).toEqual({
      user_id: null,
      motivo: "sem_destino",
      descartes: [{ elo: "pessoa_fixa", motivo: "ausente" }],
    });
  });
});

describe("resolverDestinoDoAtribuir — os modos de sempre continuam iguais", () => {
  it("pessoa fixa: o id escolhido na regra, motivo 'fixo'", () => {
    const r = resolverDestinoDoAtribuir(COM_RESPONSAVEL, CONTATO_COM_CARTEIRA, {
      user_id: FIXO,
      contato: true,
    });

    expect(r).toEqual({ user_id: FIXO, motivo: "fixo", descartes: [] });
  });

  it("rodízio: a pessoa é do banco, então a resolução não escolhe ninguém", () => {
    const r = resolverDestinoDoAtribuir(COM_RESPONSAVEL, CONTATO_COM_CARTEIRA, {
      modo: "rodizio",
      fila: [{ user_id: X, pausado: false }],
    });

    expect(r).toEqual({ user_id: null, motivo: "rodizio", descartes: [] });
  });
});
