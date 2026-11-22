/**
 * "NÃO ENVIAR AVISO DE CASO" POR MEMBRO (#4989) — a regra, pela porta do motor.
 *
 * No modo `responsavel`, quem não tem WhatsApp é pulado (`sem_telefone`) e a
 * cadeia termina no número da empresa. A issue pede um terceiro estado: a
 * pessoa que NÃO deve receber aviso de caso. Quando a cadeia chega nela, o
 * aviso do caso para ali — não segue para o próximo elo e não cai no número da
 * empresa. O caso continua aberto no painel; só não sai WhatsApp.
 *
 * Os casos entram pelo handler (`aplicaAvisoDeCaso`, `aplicaAvisoDeProposta`)
 * e pela leitura do mundo (`carregaMundoDoAviso`), não pela função pura: o que
 * importa é se a mensagem sai, e para quem.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  EVENTO_CASO_ABERTO,
  aplicaAvisoDeCaso,
  type AvisoDeps,
} from "@/lib/escalacao/aviso-ao-suporte";
import { carregaMundoDoAviso, type MundoDoAviso } from "@/lib/escalacao/membros-do-aviso";
import { aplicaAvisoDeProposta, type AvisoDePropostaDeps } from "@/lib/propostas/aviso-no-whatsapp";
import { logger } from "@/lib/logger";
import type { EventRow } from "@/lib/event-log/dispatcher";

const AGORA = new Date("2026-11-21T12:00:00.000Z");
const ORG = "11111111-1111-4111-8111-111111111111";
const CASO = "22222222-2222-4222-8222-222222222222";
const CONVERSA = "33333333-3333-4333-8333-333333333333";
const CONTATO = "44444444-4444-4444-8444-444444444444";
const CANAL = "55555555-5555-4555-8555-555555555555";
const NUMERO_DA_EMPRESA = "+5531998966398";

/** A fila do relato: um usuário que recebe fornecedores e grupos. */
const FILA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const CELULAR_DA_FILA = "+5531977772222";
/** Uma vendedora de verdade, com WhatsApp. */
const ANA = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const CELULAR_DA_ANA = "+5531988881111";
/** Um atendente sem WhatsApp cadastrado e SEM a marca. */
const BRUNO = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

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

function mundo(over: Partial<MundoDoAviso> & { naoAvisar?: ReadonlySet<string> } = {}): MundoDoAviso {
  return {
    conversa: { assigned_to_user_id: FILA, assignee_kind: "human" },
    negocio: null,
    contato: { carteira_user_id: ANA },
    whatsapps: new Map<string, string | null>([
      [FILA, CELULAR_DA_FILA],
      [ANA, CELULAR_DA_ANA],
    ]),
    ...over,
  } as MundoDoAviso;
}

function monta(opts: { modo?: "fixo" | "responsavel"; mundos: MundoDoAviso[] }) {
  const estado = {
    enviados: [] as Array<{ to: string; body: string }>,
    reivindicadas: [] as Array<{ destino: string }>,
    patches: [] as Array<Record<string, unknown>>,
    canceladasDaAtualizacao: 0,
    aberturasCanceladas: 0,
  };
  let leitura = 0;
  const deps: AvisoDeps = {
    clock: () => AGORA,
    urlPublica: "https://crm.exemplo.com.br",
    origemDoDreno: () => "worker",
    audita: () => undefined,
    db: {
      async carregaConfig() {
        return {
          organization_id: ORG,
          channel_session_id: CANAL,
          telefone_destino: NUMERO_DA_EMPRESA,
          destino_jid: null,
          ligado: true,
          destino_modo: opts.modo ?? "responsavel",
        } as never;
      },
      async carregaCaso() {
        return {
          id: CASO,
          organization_id: ORG,
          conversation_id: CONVERSA,
          kind: "financeiro",
          source: "agent",
          status: "awaiting_human",
          title: "Fornecedor pediu cotação",
          summary: null,
          blocker: null,
        };
      },
      async contatoAnonimizado() {
        return false;
      },
      async reivindicaEntrega(entrada) {
        estado.reivindicadas.push({ destino: entrada.destino });
        return {
          criada: true,
          entrega: {
            id: "77777777-7777-4777-8777-777777777777",
            organization_id: ORG,
            case_id: CASO,
            destino: entrada.destino,
            status: "pendente",
            tentativas: 0,
            created_at: AGORA.toISOString(),
            updated_at: AGORA.toISOString(),
          },
        };
      },
      async atualizaEntrega(_org, _id, patch) {
        estado.patches.push(patch as Record<string, unknown>);
      },
      async cancelaPendentesDoCaso() {
        return 0;
      },
      async cancelaAtualizacao() {
        estado.canceladasDaAtualizacao += 1;
      },
      async cancelaAberturaPendente() {
        estado.aberturasCanceladas += 1;
      },
      async carregaCanal() {
        return { id: CANAL, status: "WORKING", archived_at: null, aceitaMensagemLivre: true };
      },
      async destinoEhDaPropriaOrganizacao() {
        return false;
      },
      async carregaMundoDoAviso() {
        const m = opts.mundos[Math.min(leitura, opts.mundos.length - 1)]!;
        leitura += 1;
        return m;
      },
      async avisaNaCentral() {},
      async registraEventoDoCaso() {},
      async registraJidDoAviso() {},
      async nomeDoContato() {
        return "João Fornecedor";
      },
      async marcaDaOrganizacao() {
        return { nome: "Acme", idioma: "pt-BR" as const };
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
        estado.enviados.push({ to, body });
        return { externalId: "wamid.X" };
      },
    },
    pacing: {
      async decide() {
        return { liberado: true };
      },
      async registraEnvio() {},
    },
  };
  return { deps, estado };
}

afterEach(() => vi.restoreAllMocks());

describe("aviso de caso no modo responsável, com a marca 'não enviar aviso de caso'", () => {
  it("a cadeia chega em quem está marcado: nada sai, nem para o número da empresa, e o motivo é nao_avisar", async () => {
    const { deps, estado } = monta({ mundos: [mundo({ naoAvisar: new Set([FILA]) })] });
    const r = await aplicaAvisoDeCaso(deps, evento());
    expect(r.status).toBe("skipped");
    expect(r.detail).toBe("nao_avisar:responsavel_da_conversa");
    expect(estado.enviados).toHaveLength(0);
    // Sem linha de entrega: o caso de quem está marcado não entra em "últimos avisos".
    expect(estado.reivindicadas).toHaveLength(0);
  });

  it("a marca vale mesmo para quem não tem número: é 'não avisar', não 'sem telefone'", async () => {
    const { deps, estado } = monta({
      mundos: [mundo({ naoAvisar: new Set([FILA]), whatsapps: new Map([[ANA, CELULAR_DA_ANA]]) })],
    });
    const r = await aplicaAvisoDeCaso(deps, evento());
    expect(r.detail).toBe("nao_avisar:responsavel_da_conversa");
    expect(estado.enviados).toHaveLength(0);
  });

  it("quem está com a conversa não tem número (e não está marcado) e o próximo elo está marcado: também não sai", async () => {
    const { deps, estado } = monta({
      mundos: [
        mundo({
          conversa: { assigned_to_user_id: BRUNO, assignee_kind: "human" },
          negocio: { owner_user_id: FILA, owner_kind: "human" },
          naoAvisar: new Set([FILA]),
          whatsapps: new Map<string, string | null>([
            [BRUNO, null],
            [FILA, CELULAR_DA_FILA],
            [ANA, CELULAR_DA_ANA],
          ]),
        }),
      ],
    });
    const r = await aplicaAvisoDeCaso(deps, evento());
    expect(r.detail).toBe("nao_avisar:responsavel_do_negocio");
    expect(estado.enviados).toHaveLength(0);
  });

  it("sem ninguém marcado, quem não tem número continua sendo pulado até o número da empresa (como antes)", async () => {
    const { deps, estado } = monta({
      mundos: [
        mundo({
          conversa: { assigned_to_user_id: BRUNO, assignee_kind: "human" },
          contato: null,
          naoAvisar: new Set(),
          whatsapps: new Map<string, string | null>([[BRUNO, null]]),
        }),
      ],
    });
    expect((await aplicaAvisoDeCaso(deps, evento())).status).toBe("ok");
    expect(estado.enviados[0]?.to).toBe("5531998966398@c.us");
  });

  it("no modo fixo a marca não muda nada: o aviso vai ao número da empresa", async () => {
    const { deps, estado } = monta({ modo: "fixo", mundos: [mundo({ naoAvisar: new Set([FILA]) })] });
    expect((await aplicaAvisoDeCaso(deps, evento())).status).toBe("ok");
    expect(estado.enviados[0]?.to).toBe("5531998966398@c.us");
  });

  it("marcado entre a reivindicação e o envio: a entrega vira cancelada, nada sai, e o motivo é a marca", async () => {
    const { deps, estado } = monta({
      mundos: [mundo(), mundo({ naoAvisar: new Set([FILA]) })],
    });
    const r = await aplicaAvisoDeCaso(deps, evento());
    expect(r.detail).toBe("nao_avisar:responsavel_da_conversa");
    expect(estado.enviados).toHaveLength(0);
    expect(estado.patches).toContainEqual({ status: "cancelado", erro_codigo: null });
  });

  it("a abertura ficou represada (espaçamento) e a pessoa foi marcada antes da rodada seguinte: a entrega pendente é cancelada", async () => {
    // Rodada 1: o pacing segura — a entrega nasce `pendente` e o evento volta depois.
    const primeira = monta({ mundos: [mundo()] });
    primeira.deps.pacing.decide = async () => ({
      liberado: false,
      motivo: "espacamento",
      liberaEm: new Date(AGORA.getTime() + 5_000),
    });
    expect((await aplicaAvisoDeCaso(primeira.deps, evento())).status).toBe("retry");
    expect(primeira.estado.reivindicadas).toHaveLength(1);

    // Rodada 2: agora a fila está marcada.
    const segunda = monta({ mundos: [mundo({ naoAvisar: new Set([FILA]) })] });
    const r = await aplicaAvisoDeCaso(segunda.deps, evento());
    expect(r.detail).toBe("nao_avisar:responsavel_da_conversa");
    expect(segunda.estado.aberturasCanceladas).toBe(1);
    expect(segunda.estado.enviados).toHaveLength(0);
  });

  describe("no aviso da resposta do cliente", () => {
    const RESPOSTA = "99999999-9999-4999-8999-999999999999";
    const retorno = () =>
      evento({
        event_type: "ai.case_updated",
        payload: {
          case_id: CASO,
          conversation_id: CONVERSA,
          contact_id: CONTATO,
          case_event_id: RESPOSTA,
          config_revision: "r1",
        },
      });
    function comRetorno(m: MundoDoAviso) {
      const montado = monta({ mundos: [m] });
      montado.deps.db.carregaAtualizacao = async () => ({
        info: "Mando a cotação amanhã",
        ask: "Qual o prazo?",
        contactId: CONTATO,
        conversationId: CONVERSA,
      });
      return montado;
    }

    it("a conversa ainda está com quem está marcado: não sai, e a atualização pendente é cancelada", async () => {
      const { deps, estado } = comRetorno(mundo({ naoAvisar: new Set([FILA]) }));
      const r = await aplicaAvisoDeCaso(deps, retorno());
      expect(r.detail).toBe("nao_avisar:responsavel_da_conversa");
      expect(estado.enviados).toHaveLength(0);
      expect(estado.canceladasDaAtualizacao).toBe(1);
    });

    it("a conversa passou para a Ana: o aviso da resposta vai para ela — vale quem está com o caso AGORA", async () => {
      const { deps, estado } = comRetorno(
        mundo({ conversa: { assigned_to_user_id: ANA, assignee_kind: "human" }, naoAvisar: new Set([FILA]) }),
      );
      expect((await aplicaAvisoDeCaso(deps, retorno())).status).toBe("ok");
      expect(estado.enviados[0]?.to).toBe("5531988881111@c.us");
    });
  });
});

describe("o aviso de PROPOSTA não olha a marca (a issue fala só de aviso de caso)", () => {
  it("a pessoa marcada, com número, continua recebendo o aviso de proposta", async () => {
    const envia = vi.fn(async () => ({ externalId: "ext-1" }));
    const resolveDestino = vi.fn(async (_o: string, _c: unknown, telefone: string) => `${telefone.replace(/\D/g, "")}@c.us`);
    const d: AvisoDePropostaDeps = {
      db: {
        preferencia: async () => true,
        carregaConfig: async () =>
          ({
            organization_id: ORG,
            channel_session_id: CANAL,
            telefone_destino: NUMERO_DA_EMPRESA,
            destino_jid: null,
            ligado: true,
            destino_modo: "responsavel",
          }) as never,
        carregaProposta: async () => ({ titulo: "Cotação", status: "rascunho", contact_id: CONTATO, conversation_id: CONVERSA }),
        avisoAberto: async () => true,
        nomeDoContato: async () => "João",
        carregaCanal: async () => ({ id: CANAL, status: "WORKING", archived_at: null, aceitaMensagemLivre: true }),
        destinoEhDaPropriaOrganizacao: async () => false,
        carregaMundoDoAviso: async () => mundo({ naoAvisar: new Set([FILA]) }),
        registraJidDoAviso: async () => undefined,
        marcaDaOrganizacao: async () => ({ nome: "Acme", idioma: "pt-BR" as const }),
      },
      transporte: { configurado: async () => true, resolveDestino, envia },
      pacing: { decide: async () => ({ liberado: true }), registraEnvio: async () => undefined },
      clock: () => AGORA,
      urlPublica: "https://crm.exemplo.com.br",
      origemDoDreno: () => "worker",
      audita: vi.fn(),
    };
    const r = await aplicaAvisoDeProposta(d, {
      ...evento(),
      event_type: "proposal.ready_for_review",
      entity_kind: "proposal",
      entity_id: "prop-1",
      payload: { proposal_id: "prop-1" },
    });
    expect(r.status).toBe("ok");
    expect(resolveDestino).toHaveBeenCalledWith(ORG, expect.anything(), CELULAR_DA_FILA);
    expect(envia).toHaveBeenCalledTimes(1);
  });
});

/**
 * Um client de serviço falso, só com o que `carregaMundoDoAviso` encadeia. Cada
 * tabela devolve o que o caso mandar; `organizations` é onde a marca mora
 * (`settings.aviso_de_caso_nao_avisar`), sem migration.
 */
function adminFalso(tabelas: Record<string, { data: unknown; error: { message: string } | null }>) {
  const from = vi.fn((tabela: string) => {
    const resposta = tabelas[tabela] ?? { data: null, error: null };
    const c: Record<string, unknown> = {};
    for (const m of ["select", "eq", "is", "in", "order", "limit"]) c[m] = () => c;
    c.maybeSingle = async () => resposta;
    c.then = (ok: (v: unknown) => unknown, falha: (e: unknown) => unknown) =>
      Promise.resolve(resposta).then(ok, falha);
    return c;
  });
  return { from } as never;
}

describe("a leitura da marca (carregaMundoDoAviso)", () => {
  const base = {
    conversations: { data: { assigned_to_user_id: FILA, assignee_kind: "human" }, error: null },
    contacts: { data: { carteira_user_id: null }, error: null },
    crm_leads: { data: null, error: null },
    user_organizations: { data: [{ user_id: FILA, whatsapp_e164: CELULAR_DA_FILA }], error: null },
  };

  it("lê os membros marcados de organizations.settings", async () => {
    const m = await carregaMundoDoAviso(
      adminFalso({
        ...base,
        organizations: { data: { settings: { aviso_de_caso_nao_avisar: { user_ids: [FILA] }, outra: 1 } }, error: null },
      }),
      { organizationId: ORG, conversationId: CONVERSA, contactId: CONTATO },
      { comMarca: true },
    );
    expect([...(m.naoAvisar ?? [])]).toEqual([FILA]);
  });

  it("jsonb torto vale como ninguém marcado", async () => {
    const m = await carregaMundoDoAviso(
      adminFalso({ ...base, organizations: { data: { settings: { aviso_de_caso_nao_avisar: "todos" } }, error: null } }),
      { organizationId: ORG, conversationId: CONVERSA, contactId: CONTATO },
      { comMarca: true },
    );
    expect([...(m.naoAvisar ?? [])]).toEqual([]);
  });

  it("a leitura da marca falhou: segue a ordem de sempre e o motivo vai para o log", async () => {
    const aviso = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    const m = await carregaMundoDoAviso(
      adminFalso({ ...base, organizations: { data: null, error: { message: "statement timeout" } } }),
      { organizationId: ORG, conversationId: CONVERSA, contactId: CONTATO },
      { comMarca: true },
    );
    expect([...(m.naoAvisar ?? [])]).toEqual([]);
    expect(m.whatsapps.get(FILA)).toBe(CELULAR_DA_FILA);
    expect(aviso).toHaveBeenCalledWith(
      expect.stringContaining("não enviar aviso"),
      expect.objectContaining({ causa: "statement timeout" }),
    );
  });

  it("quem saiu da equipe e ficou marcado não para a cadeia: é pulado como antes", async () => {
    const m = await carregaMundoDoAviso(
      adminFalso({
        ...base,
        // A FILA não está mais entre os vínculos ativos.
        user_organizations: { data: [], error: null },
        organizations: { data: { settings: { aviso_de_caso_nao_avisar: { user_ids: [FILA] } } }, error: null },
      }),
      { organizationId: ORG, conversationId: CONVERSA, contactId: CONTATO },
      { comMarca: true },
    );
    expect([...(m.naoAvisar ?? [])]).toEqual([]);
    const { deps, estado } = monta({ mundos: [m] });
    expect((await aplicaAvisoDeCaso(deps, evento())).status).toBe("ok");
    expect(estado.enviados[0]?.to).toBe("5531998966398@c.us");
  });

  it("a leitura do negócio falhou, mas a vez é de quem está marcado: nada sai (e quem não está marcado segue indo à empresa)", async () => {
    const m = await carregaMundoDoAviso(
      adminFalso({
        ...base,
        crm_leads: { data: null, error: { message: "statement timeout" } },
        organizations: { data: { settings: { aviso_de_caso_nao_avisar: { user_ids: [FILA] } } }, error: null },
      }),
      { organizationId: ORG, conversationId: CONVERSA, contactId: CONTATO },
      { comMarca: true },
    );
    // Os telefones continuam fora nesse ramo, como antes.
    expect(m.whatsapps.size).toBe(0);
    const { deps, estado } = monta({ mundos: [m] });
    expect((await aplicaAvisoDeCaso(deps, evento())).detail).toBe("nao_avisar:responsavel_da_conversa");
    expect(estado.enviados).toHaveLength(0);
  });

  it("sem `comMarca` (o aviso de proposta) a marca nem é lida", async () => {
    const admin = adminFalso({
      ...base,
      organizations: { data: { settings: { aviso_de_caso_nao_avisar: { user_ids: [FILA] } } }, error: null },
    });
    const m = await carregaMundoDoAviso(admin, { organizationId: ORG, conversationId: CONVERSA, contactId: CONTATO });
    expect(m.naoAvisar).toBeUndefined();
    expect((admin as unknown as { from: ReturnType<typeof vi.fn> }).from).not.toHaveBeenCalledWith("organizations");
  });

  it("a leitura da carteira falhou e quem está com a conversa NÃO está marcado: a marca de um elo seguinte não vale, e segue a regra de antes", async () => {
    const m = await carregaMundoDoAviso(
      adminFalso({
        conversations: { data: { assigned_to_user_id: ANA, assignee_kind: "human" }, error: null },
        contacts: { data: null, error: { message: "statement timeout" } },
        crm_leads: { data: { owner_user_id: FILA, owner_kind: "human" }, error: null },
        user_organizations: { data: [{ user_id: ANA, whatsapp_e164: CELULAR_DA_ANA }], error: null },
        organizations: { data: { settings: { aviso_de_caso_nao_avisar: { user_ids: [FILA] } } }, error: null },
      }),
      { organizationId: ORG, conversationId: CONVERSA, contactId: CONTATO },
      { comMarca: true },
    );
    const { deps, estado } = monta({ mundos: [m] });
    expect((await aplicaAvisoDeCaso(deps, evento())).status).toBe("ok");
    expect(estado.enviados[0]?.to).toBe("5531998966398@c.us");
  });
});
