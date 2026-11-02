import { describe, expect, it } from "vitest";

import { resolverDestinoDoAviso } from "@/lib/escalacao/destino-do-aviso";

/**
 * A CADEIA DO DESTINO DO AVISO (#3803) — a regra, sem banco.
 *
 * O aviso de caso e o de proposta deixam de ter UM número por organização como
 * único destino: com `destino_modo = 'responsavel'` quem recebe é o responsável
 * resolvido no momento do envio, nesta ordem — conversa → negócio aberto → dono
 * da carteira → número da empresa.
 *
 * Estes casos são o CONTRATO da função: cada elo, o elo sem telefone e o caso em
 * que não existe ninguém (o mais importante: o aviso não pode ficar sem número).
 */

const CONVERSA = "11111111-1111-4111-8111-111111111111";
const VENDEDOR_DO_NEGOCIO = "22222222-2222-4222-8222-222222222222";
const DONO_DA_CARTEIRA = "33333333-3333-4333-8333-333333333333";
const NUMERO_DA_EMPRESA = "+5531999990000";

function comResponsavel(destinos: Record<string, string | null>) {
  return new Map<string, string | null>(Object.entries(destinos));
}

/** Configuração no modo novo: o destino é quem responde, com o número da empresa no fim. */
const CONFIG_RESPONSAVEL = { destino_modo: "responsavel", telefone_destino: NUMERO_DA_EMPRESA };

const CONVERSA_ATRIBUIDA = { assigned_to_user_id: CONVERSA, assignee_kind: "human" };
const NEGOCIO_DO_VENDEDOR = { owner_user_id: VENDEDOR_DO_NEGOCIO, owner_kind: "human" };
const CONTATO_COM_CARTEIRA = { carteira_user_id: DONO_DA_CARTEIRA };

describe("resolverDestinoDoAviso — a ordem dos elos (#3803)", () => {
  it("conversa com responsável: é ele que recebe, pelo WhatsApp do perfil dele", () => {
    const r = resolverDestinoDoAviso({
      config: CONFIG_RESPONSAVEL,
      conversa: CONVERSA_ATRIBUIDA,
      negocio: NEGOCIO_DO_VENDEDOR,
      contato: CONTATO_COM_CARTEIRA,
      whatsapps: comResponsavel({
        [CONVERSA]: "+5531988881111",
        [VENDEDOR_DO_NEGOCIO]: "+5531988882222",
        [DONO_DA_CARTEIRA]: "+5531988883333",
      }),
    });
    expect(r).toEqual({
      telefone: "+5531988881111",
      origem: "responsavel_da_conversa",
      user_id: CONVERSA,
      descartes: [],
    });
  });

  it("sem conversa atribuída: cai no responsável do negócio aberto", () => {
    const r = resolverDestinoDoAviso({
      config: CONFIG_RESPONSAVEL,
      conversa: { assigned_to_user_id: null, assignee_kind: "human" },
      negocio: NEGOCIO_DO_VENDEDOR,
      contato: CONTATO_COM_CARTEIRA,
      whatsapps: comResponsavel({
        [VENDEDOR_DO_NEGOCIO]: "+5531988882222",
        [DONO_DA_CARTEIRA]: "+5531988883333",
      }),
    });
    expect(r.origem).toBe("responsavel_do_negocio");
    expect(r.telefone).toBe("+5531988882222");
    expect(r.user_id).toBe(VENDEDOR_DO_NEGOCIO);
    expect(r.descartes).toEqual([{ elo: "responsavel_da_conversa", motivo: "ausente" }]);
  });

  it("sem negócio: cai no dono da carteira do contato", () => {
    const r = resolverDestinoDoAviso({
      config: CONFIG_RESPONSAVEL,
      conversa: null,
      negocio: null,
      contato: CONTATO_COM_CARTEIRA,
      whatsapps: comResponsavel({ [DONO_DA_CARTEIRA]: "+5531988883333" }),
    });
    expect(r.origem).toBe("dono_da_carteira");
    expect(r.telefone).toBe("+5531988883333");
    expect(r.descartes.map((d) => d.elo)).toEqual(["responsavel_da_conversa", "responsavel_do_negocio"]);
  });

  it("sem ninguém: o aviso vai para o número da empresa", () => {
    const r = resolverDestinoDoAviso({
      config: CONFIG_RESPONSAVEL,
      conversa: null,
      negocio: null,
      contato: null,
      whatsapps: new Map(),
    });
    expect(r).toEqual({
      telefone: NUMERO_DA_EMPRESA,
      origem: "numero_da_empresa",
      user_id: null,
      descartes: [
        { elo: "responsavel_da_conversa", motivo: "ausente" },
        { elo: "responsavel_do_negocio", motivo: "ausente" },
        { elo: "dono_da_carteira", motivo: "ausente" },
      ],
    });
  });

  it("elo com pessoa mas SEM telefone no perfil cai no próximo, e o motivo do descarte é `sem_telefone`", () => {
    const r = resolverDestinoDoAviso({
      config: CONFIG_RESPONSAVEL,
      conversa: CONVERSA_ATRIBUIDA,
      negocio: NEGOCIO_DO_VENDEDOR,
      contato: CONTATO_COM_CARTEIRA,
      whatsapps: comResponsavel({
        [CONVERSA]: null,
        [VENDEDOR_DO_NEGOCIO]: "   ",
        [DONO_DA_CARTEIRA]: "+5531988883333",
      }),
    });
    expect(r.origem).toBe("dono_da_carteira");
    expect(r.telefone).toBe("+5531988883333");
    expect(r.descartes).toEqual([
      { elo: "responsavel_da_conversa", motivo: "sem_telefone" },
      { elo: "responsavel_do_negocio", motivo: "sem_telefone" },
    ]);
  });

  it("o último elo sem telefone também cai no número da empresa — e diz por quê", () => {
    const r = resolverDestinoDoAviso({
      config: CONFIG_RESPONSAVEL,
      conversa: null,
      negocio: null,
      contato: CONTATO_COM_CARTEIRA,
      whatsapps: comResponsavel({ [DONO_DA_CARTEIRA]: null }),
    });
    expect(r.origem).toBe("numero_da_empresa");
    expect(r.telefone).toBe(NUMERO_DA_EMPRESA);
    expect(r.descartes).toContainEqual({ elo: "dono_da_carteira", motivo: "sem_telefone" });
  });

  it("a conversa com a IA (`assignee_kind = 'agent'`) não é gente: não recebe aviso", () => {
    const r = resolverDestinoDoAviso({
      config: CONFIG_RESPONSAVEL,
      conversa: { assigned_to_user_id: CONVERSA, assignee_kind: "agent" },
      negocio: NEGOCIO_DO_VENDEDOR,
      contato: null,
      whatsapps: comResponsavel({
        [CONVERSA]: "+5531988881111",
        [VENDEDOR_DO_NEGOCIO]: "+5531988882222",
      }),
    });
    expect(r.origem).toBe("responsavel_do_negocio");
    expect(r.telefone).toBe("+5531988882222");
  });
});

describe("resolverDestinoDoAviso — o número NUNCA fica vazio (#3803)", () => {
  it("tudo null: ainda há um telefone, e é o da empresa", () => {
    const r = resolverDestinoDoAviso({
      config: CONFIG_RESPONSAVEL,
      conversa: null,
      negocio: null,
      contato: null,
      whatsapps: new Map(),
    });
    expect(r.telefone).not.toBe("");
    expect(r.telefone).not.toBeNull();
    expect(r.telefone).toBe(NUMERO_DA_EMPRESA);
  });

  it("tudo undefined, do jeito que um payload de outra versão chega", () => {
    const r = resolverDestinoDoAviso({
      config: CONFIG_RESPONSAVEL,
      conversa: undefined,
      negocio: undefined,
      contato: undefined,
      whatsapps: new Map(),
    });
    expect(r.telefone).toBe(NUMERO_DA_EMPRESA);
    expect(r.origem).toBe("numero_da_empresa");
  });

  it("configuração sem número nenhum: devolve `null` e `sem_destino`, jamais string vazia", () => {
    const r = resolverDestinoDoAviso({
      config: { destino_modo: "responsavel", telefone_destino: "   " },
      conversa: null,
      negocio: null,
      contato: null,
      whatsapps: new Map(),
    });
    expect(r.telefone).toBeNull();
    expect(r.origem).toBe("sem_destino");
  });
});
