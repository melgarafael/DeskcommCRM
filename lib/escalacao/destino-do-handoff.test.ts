/**
 * #3804, item 3 — a IA passa a conversa para uma pessoa e ela vai para QUEM É O
 * DONO (responsável do negócio / dono da carteira), conforme a configuração da
 * organização.
 *
 * O que este arquivo prova, lado a lado com o caminho de sempre:
 *
 *   1. organiza ção configurada: a conversa é atribuída à pessoa que a cadeia
 *      resolvel, e o motivo diz QUAL elo decidiu;
 *   2. organização SEM a configuração: nenhuma leitura de negócio/contato e
 *      nenhuma escrita de atribuição — byte a byte o handoff de hoje;
 *   3. ninguém qualificado: o fallback decide (pessoa fixa OU rodízio), e quando
 *      nem ele serve o desfecho é `sem_destino` — nunca "atribuiu a ninguém e
 *      ninguém soube";
 *   4. candidato recusado (inativo / `viewer`): próximo elo da cadeia, com o
 *      `motivo` certo;
 *   5. passagem feita por uma PESSOA (`caso_escalado`, o "Assumir eu") não
 *      reatribui a conversa.
 */
import { describe, expect, it, vi } from "vitest";

import {
  CHAVE_DO_DESTINO_DO_HANDOFF,
  configDoDestinoDoHandoff,
  entregarAoDonoDoHandoff,
  origemDaIA,
  type ConversaDaEntrega,
  type PortaDaEntrega,
} from "@/lib/escalacao/destino-do-handoff";
import type { VinculoDoDestino } from "@/lib/automation/vinculo-do-destino";

const RESPONSAVEL = "11111111-1111-4111-8111-111111111111";
const CARTEIRA = "22222222-2222-4222-8222-222222222222";
const FALLBACK = "33333333-3333-4333-8333-333333333333";
const ORG = "99999999-9999-4999-8999-999999999999";
const CONVERSA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const CONTATO = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

const CONFIG_CARTEIRA_COM_FIXO = {
  modo: "destino",
  destinos: ["dono_da_carteira"],
  fallback: { modo: "fixo", user_id: FALLBACK },
};

const CONFIG_NEGOCIO_E_CARTEIRA = {
  modo: "destino",
  destinos: ["responsavel_do_negocio", "dono_da_carteira"],
  fallback: { modo: "fixo", user_id: FALLBACK },
};

function settingsCom(config: unknown): Record<string, unknown> {
  return { atendimento: { [CHAVE_DO_DESTINO_DO_HANDOFF]: config } };
}

interface Estado {
  settings?: unknown;
  conversa?: ConversaDaEntrega | null;
  negocio?: { owner_user_id?: unknown; owner_kind?: unknown } | null;
  contato?: { carteira_user_id?: unknown } | null;
  /** Quem pode receber; fora do mapa = `user_not_in_org`. */
  vinculos?: Record<string, VinculoDoDestino>;
  erroAoAtribuir?: string;
  erroAoEnfileirar?: string;
}

type Registro = {
  leituras: string[];
  atribuicoes: string[];
  enfileiramentos: number;
};

function portaFalsa(estado: Estado = {}): { porta: PortaDaEntrega; registro: Registro } {
  const registro: Registro = { leituras: [], atribuicoes: [], enfileiramentos: 0 };
  const vinculos = estado.vinculos ?? {
    [RESPONSAVEL]: { ok: true },
    [CARTEIRA]: { ok: true },
    [FALLBACK]: { ok: true },
  };
  const porta: PortaDaEntrega = {
    async lerSettings() {
      registro.leituras.push("settings");
      return estado.settings ?? null;
    },
    async lerConversa() {
      registro.leituras.push("conversa");
      return estado.conversa === undefined
        ? { assigned_to_user_id: null, assignee_kind: "agent", contact_id: CONTATO }
        : estado.conversa;
    },
    async lerNegocioDoContato() {
      registro.leituras.push("negocio");
      return estado.negocio === undefined
        ? { owner_user_id: RESPONSAVEL, owner_kind: "user" }
        : estado.negocio;
    },
    async lerContato() {
      registro.leituras.push("contato");
      return estado.contato === undefined ? { carteira_user_id: CARTEIRA } : estado.contato;
    },
    async conferirVinculo(_org, userId) {
      registro.leituras.push(`vinculo:${userId}`);
      return vinculos[userId] ?? { ok: false, motivo: "user_not_in_org" };
    },
    async atribuir(_org, _conversa, userId) {
      if (estado.erroAoAtribuir) return estado.erroAoAtribuir;
      registro.atribuicoes.push(userId);
      return null;
    },
    async enfileirarNoRodizio() {
      if (estado.erroAoEnfileirar) return estado.erroAoEnfileirar;
      registro.enfileiramentos += 1;
      return null;
    },
  };
  return { porta, registro };
}

function entrega(porta: PortaDaEntrega, origem: "pedido_explicito" | "caso_escalado" = "pedido_explicito") {
  return entregarAoDonoDoHandoff(porta, {
    organizationId: ORG,
    conversationId: CONVERSA,
    origem,
  });
}

describe("configDoDestinoDoHandoff — a MESMA chave do modo `destino` da regra (#3822)", () => {
  it("lê `settings.atendimento.destino_do_handoff` com modo `destino`", () => {
    expect(configDoDestinoDoHandoff(settingsCom(CONFIG_CARTEIRA_COM_FIXO))).toEqual(
      CONFIG_CARTEIRA_COM_FIXO,
    );
  });

  it("sem a chave, sem a árvore e sem settings: não configurado", () => {
    expect(configDoDestinoDoHandoff(null)).toBeNull();
    expect(configDoDestinoDoHandoff(undefined)).toBeNull();
    expect(configDoDestinoDoHandoff({})).toBeNull();
    expect(configDoDestinoDoHandoff({ atendimento: {} })).toBeNull();
    expect(configDoDestinoDoHandoff({ crm: { cliente_pela_venda: true } })).toBeNull();
  });

  it("modo que não é `destino` (fixo, rodizio, lixo de outra versão) é NÃO configurado", () => {
    expect(configDoDestinoDoHandoff(settingsCom({ modo: "fixo", user_id: FALLBACK }))).toBeNull();
    expect(configDoDestinoDoHandoff(settingsCom({ modo: "rodizio" }))).toBeNull();
    expect(configDoDestinoDoHandoff(settingsCom({ modo: "destino-futuro" }))).toBeNull();
    expect(configDoDestinoDoHandoff(settingsCom("destino"))).toBeNull();
    expect(configDoDestinoDoHandoff(settingsCom([CONFIG_CARTEIRA_COM_FIXO]))).toBeNull();
  });
});

describe("origemDaIA — quem decidiu passar a conversa", () => {
  it("a IA e o agente externo entregam", () => {
    expect(origemDaIA("pedido_explicito")).toBe(true);
    expect(origemDaIA("ferramenta_do_modelo")).toBe(true);
    expect(origemDaIA("mcp_externo")).toBe(true);
    expect(origemDaIA("teto_de_gasto")).toBe(true);
    expect(origemDaIA("sentimento")).toBe(true);
  });

  it("uma PESSOA escalando (caso_escalado) e a ausência não entregam", () => {
    expect(origemDaIA("caso_escalado")).toBe(false);
    expect(origemDaIA(null)).toBe(false);
    expect(origemDaIA(undefined)).toBe(false);
  });
});

describe("entregarAoDonoDoHandoff — o caminho de hoje, intocado", () => {
  it("SEM configuração: nenhuma leitura de negócio/contato, nenhuma escrita", async () => {
    const { porta, registro } = portaFalsa({ settings: { crm: { cliente_pela_venda: true } } });
    const desfecho = await entrega(porta);

    expect(desfecho).toEqual({ entregue: false, motivo: "sem_configuracao", descartes: [] });
    // O handoff de hoje não é "quase": ele não lê nem escreve nada além da própria chave.
    expect(registro.leituras).toEqual(["settings"]);
    expect(registro.atribuicoes).toEqual([]);
    expect(registro.enfileiramentos).toBe(0);
  });

  it("organização com o modo `fixo` na chave: também não configurado", async () => {
    const { porta, registro } = portaFalsa({
      settings: settingsCom({ modo: "fixo", user_id: FALLBACK }),
    });
    const desfecho = await entrega(porta);

    expect(desfecho.motivo).toBe("sem_configuracao");
    expect(registro.atribuicoes).toEqual([]);
  });

  it("passagem feita por uma PESSOA não reatribui — nem lê a configuração", async () => {
    const { porta, registro } = portaFalsa({ settings: settingsCom(CONFIG_CARTEIRA_COM_FIXO) });
    const desfecho = await entrega(porta, "caso_escalado");

    expect(desfecho).toEqual({ entregue: false, motivo: "origem_humana", descartes: [] });
    expect(registro.leituras).toEqual([]);
    expect(registro.atribuicoes).toEqual([]);
  });

  it("conversa que já é de uma pessoa: não é roubada pela configuração", async () => {
    const { porta, registro } = portaFalsa({
      settings: settingsCom(CONFIG_CARTEIRA_COM_FIXO),
      conversa: { assigned_to_user_id: RESPONSAVEL, assignee_kind: "user", contact_id: CONTATO },
    });
    const desfecho = await entrega(porta);

    expect(desfecho).toEqual({ entregue: false, motivo: "conversa_com_dono", descartes: [] });
    expect(registro.atribuicoes).toEqual([]);
  });
});

describe("entregarAoDonoDoHandoff — a IA entrega a quem é o dono", () => {
  it("GREEN: dono da carteira recebe a conversa quando a cadeia pede só a carteira", async () => {
    const { porta, registro } = portaFalsa({ settings: settingsCom(CONFIG_CARTEIRA_COM_FIXO) });
    const desfecho = await entrega(porta);

    expect(desfecho).toEqual({
      entregue: true,
      user_id: CARTEIRA,
      motivo: "dono_da_carteira",
      descartes: [],
    });
    expect(registro.atribuicoes).toEqual([CARTEIRA]);
  });

  it("responsável do negócio vence quando é o primeiro elo da configuração", async () => {
    const { porta, registro } = portaFalsa({ settings: settingsCom(CONFIG_NEGOCIO_E_CARTEIRA) });
    const desfecho = await entrega(porta);

    expect(desfecho).toMatchObject({ entregue: true, user_id: RESPONSAVEL, motivo: "responsavel_do_negocio" });
    expect(registro.atribuicoes).toEqual([RESPONSAVEL]);
  });

  it("negócio sem responsável: a cadeia cai no dono da carteira, e a trilha diz por quê", async () => {
    const { porta, registro } = portaFalsa({
      settings: settingsCom(CONFIG_NEGOCIO_E_CARTEIRA),
      negocio: null,
    });
    const desfecho = await entrega(porta);

    expect(desfecho).toMatchObject({ entregue: true, user_id: CARTEIRA, motivo: "dono_da_carteira" });
    if (!desfecho.entregue) throw new Error("deveria ter entregado");
    expect(desfecho.descartes).toEqual([{ elo: "responsavel_do_negocio", motivo: "ausente" }]);
    expect(registro.atribuicoes).toEqual([CARTEIRA]);
  });

  it("candidato RECUSADO (`viewer`, inativo): próximo elo da cadeia, com `recusado` na trilha", async () => {
    const { porta, registro } = portaFalsa({
      settings: settingsCom(CONFIG_NEGOCIO_E_CARTEIRA),
      vinculos: {
        [RESPONSAVEL]: { ok: false, motivo: "invalid_owner" },
        [CARTEIRA]: { ok: true },
        [FALLBACK]: { ok: true },
      },
    });
    const desfecho = await entrega(porta);

    expect(desfecho).toMatchObject({ entregue: true, user_id: CARTEIRA, motivo: "dono_da_carteira" });
    if (!desfecho.entregue) throw new Error("deveria ter entregado");
    expect(desfecho.descartes).toEqual([{ elo: "responsavel_do_negocio", motivo: "recusado" }]);
    expect(registro.atribuicoes).toEqual([CARTEIRA]);
  });

  it("vínculo INDETERMINADO (leitura do membro falhou): não atribui no escuro", async () => {
    const { porta, registro } = portaFalsa({
      settings: settingsCom(CONFIG_CARTEIRA_COM_FIXO),
      vinculos: { [CARTEIRA]: { ok: false, indeterminado: "timeout" } },
    });
    const desfecho = await entrega(porta);

    expect(desfecho).toMatchObject({ entregue: false, motivo: "vinculo_indeterminado", erro: "timeout" });
    expect(registro.atribuicoes).toEqual([]);
  });

  it("o banco recusando a atribuição: desfecho com o erro, sem inventar dono", async () => {
    const { porta } = portaFalsa({
      settings: settingsCom(CONFIG_CARTEIRA_COM_FIXO),
      erroAoAtribuir: "assignee_not_eligible_member",
    });
    const desfecho = await entrega(porta);

    expect(desfecho).toMatchObject({
      entregue: false,
      motivo: "falha_ao_atribuir",
      erro: "assignee_not_eligible_member",
    });
  });
});

describe("entregarAoDonoDoHandoff — ninguém qualificado nunca é silêncio", () => {
  it("fallback PESSOA FIXA decide quando nem o negócio nem a carteira servem", async () => {
    const { porta, registro } = portaFalsa({
      settings: settingsCom(CONFIG_NEGOCIO_E_CARTEIRA),
      negocio: null,
      contato: { carteira_user_id: null },
    });
    const desfecho = await entrega(porta);

    expect(desfecho).toMatchObject({ entregue: true, user_id: FALLBACK, motivo: "fallback_fixo" });
    expect(registro.atribuicoes).toEqual([FALLBACK]);
  });

  it("fallback RODÍZIO decide pela distribuição do canal (a mesma do handoff de hoje)", async () => {
    const { porta, registro } = portaFalsa({
      settings: settingsCom({
        modo: "destino",
        destinos: ["dono_da_carteira"],
        fallback: { modo: "rodizio" },
      }),
      contato: { carteira_user_id: null },
    });
    const desfecho = await entrega(porta);

    expect(desfecho).toMatchObject({ entregue: true, user_id: null, motivo: "fallback_rodizio" });
    expect(registro.enfileiramentos).toBe(1);
    expect(registro.atribuicoes).toEqual([]);
  });

  it("nem o fallback serve: `sem_destino` com a trilha — e nada é escrito", async () => {
    const { porta, registro } = portaFalsa({
      settings: settingsCom(CONFIG_NEGOCIO_E_CARTEIRA),
      negocio: null,
      contato: { carteira_user_id: null },
      vinculos: { [RESPONSAVEL]: { ok: true }, [CARTEIRA]: { ok: true } },
    });
    const desfecho = await entrega(porta);

    expect(desfecho).toMatchObject({ entregue: false, motivo: "sem_destino" });
    if (desfecho.entregue) throw new Error("não deveria ter entregado");
    expect(desfecho.descartes).toEqual([
      { elo: "responsavel_do_negocio", motivo: "ausente" },
      { elo: "dono_da_carteira", motivo: "ausente" },
      { elo: "fallback_fixo", motivo: "recusado" },
    ]);
    expect(registro.atribuicoes).toEqual([]);
    expect(registro.enfileiramentos).toBe(0);
  });

  it("conversa órfã (sem contato): nem negócio nem carteira — o fallback decide", async () => {
    const { porta, registro } = portaFalsa({
      settings: settingsCom(CONFIG_CARTEIRA_COM_FIXO),
      conversa: { assigned_to_user_id: null, assignee_kind: null, contact_id: null },
    });
    const desfecho = await entrega(porta);

    expect(desfecho).toMatchObject({ entregue: true, user_id: FALLBACK, motivo: "fallback_fixo" });
    expect(registro.leituras).not.toContain("negocio");
    expect(registro.leituras).not.toContain("contato");
    expect(registro.atribuicoes).toEqual([FALLBACK]);
  });

  it("a conversa sumiu entre o handoff e a entrega: `sem_conversa`, sem escrita", async () => {
    const { porta, registro } = portaFalsa({
      settings: settingsCom(CONFIG_CARTEIRA_COM_FIXO),
      conversa: null,
    });
    const desfecho = await entrega(porta);

    expect(desfecho).toEqual({ entregue: false, motivo: "sem_conversa", descartes: [] });
    expect(registro.atribuicoes).toEqual([]);
  });

  it("falha ao enfileirar no rodízio é reportada, não escondida", async () => {
    const { porta } = portaFalsa({
      settings: settingsCom({
        modo: "destino",
        destinos: ["dono_da_carteira"],
        fallback: { modo: "rodizio" },
      }),
      contato: { carteira_user_id: null },
      erroAoEnfileirar: "routing_forbidden",
    });
    const desfecho = await entrega(porta);

    expect(desfecho).toMatchObject({
      entregue: false,
      motivo: "falha_ao_enfileirar",
      erro: "routing_forbidden",
    });
  });
});
