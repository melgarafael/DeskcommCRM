/**
 * #3974 — o contexto de MENSAGEM RECEBIDA passa a entregar o NEGÓCIO do contato.
 *
 * Antes, `buildContext` hidratava só `contact` em evento de mensagem
 * (`lib/automation/engine.ts`), então uma regra de "mensagem recebida" não
 * tinha como mover o card: `create_or_move_lead` sem `lead` no contexto cai no
 * ramo de CONTATO, que cria um negócio novo quando não acha um aberto no funil
 * de destino. O pedido da issue é justamente "quando o cliente responder, mover
 * o card para a etapa X" — e não há card no contexto.
 *
 * A regra escolhida para contato com VÁRIOS negócios é uma e está declarada no
 * código: o negócio ABERTO mais recente (a mesma escolha de
 * `negocioAbertoDoContato`, que é a fonte única da pergunta "o card do contato").
 *
 * O dublê aplica DE VERDADE os filtros `eq` e a ordem que o motor pede — um
 * filtro de organização esquecido muda a linha devolvida em vez de passar
 * despercebido.
 */
import { describe, expect, it } from "vitest";

import { buildContext } from "@/lib/automation/engine";
import type { EventRow } from "@/lib/event-log/dispatcher";

const ORG = "11111111-1111-4111-8111-111111111111";
const OUTRA_ORG = "22222222-2222-4222-8222-222222222222";
const CONTATO = "33333333-3333-4333-8333-333333333333";
const CONTATO_SEM_NEGOCIO = "44444444-4444-4444-8444-444444444444";
const NEGOCIO_ANTIGO = "55555555-5555-4555-8555-555555555555";
const NEGOCIO_NOVO = "66666666-6666-4666-8666-666666666666";
const NEGOCIO_DE_OUTRA_ORG = "77777777-7777-4777-8777-777777777777";

type Linha = Record<string, unknown>;

const CONTATOS: Linha[] = [
  { id: CONTATO, organization_id: ORG, name: "Marisa Fontenelle", phone_number: "+5511900000000" },
  { id: CONTATO_SEM_NEGOCIO, organization_id: ORG, name: "Sem card", phone_number: "+5511900000001" },
];

const NEGOCIOS: Linha[] = [
  // O mais RECENTE do contato é de outra organização: se o filtro de org
  // faltasse, seria ele a aparecer no contexto.
  {
    id: NEGOCIO_DE_OUTRA_ORG,
    organization_id: OUTRA_ORG,
    contact_id: CONTATO,
    status: "open",
    created_at: "2026-11-01T12:00:00Z",
  },
  {
    id: NEGOCIO_ANTIGO,
    organization_id: ORG,
    contact_id: CONTATO,
    status: "open",
    stage_id: "88888888-8888-4888-8888-888888888888",
    created_at: "2026-10-01T12:00:00Z",
  },
  {
    id: NEGOCIO_NOVO,
    organization_id: ORG,
    contact_id: CONTATO,
    status: "open",
    stage_id: "99999999-9999-4999-8999-999999999999",
    created_at: "2026-10-20T12:00:00Z",
  },
];

/** Dublê mínimo do service-role: aplica `eq` e `order`, tudo mais vira cadeia. */
function cliente(tabelas: Record<string, Linha[]>) {
  return {
    from(tabela: string) {
      const filtros: Array<[string, unknown]> = [];
      let ordem: string | null = null;
      let decrescente = false;
      const q = {
        select: () => q,
        eq: (coluna: string, valor: unknown) => (filtros.push([coluna, valor]), q),
        order: (coluna: string, opcoes?: { ascending?: boolean }) => {
          ordem = coluna;
          decrescente = opcoes?.ascending === false;
          return q;
        },
        limit: () => q,
        maybeSingle: async () => {
          const linhas = (tabelas[tabela] ?? []).filter((l) => filtros.every(([c, v]) => l[c] === v));
          if (ordem) {
            linhas.sort((a, b) => {
              const va = String(a[ordem!] ?? "");
              const vb = String(b[ordem!] ?? "");
              return decrescente ? vb.localeCompare(va) : va.localeCompare(vb);
            });
          }
          return { data: linhas[0] ?? null, error: null };
        },
      };
      return q;
    },
  } as never;
}

/** A linha que o `fn_emit_message_event` grava para mensagem de ENTRADA. */
function eventoDeMensagem(contactId = CONTATO): EventRow {
  return {
    id: "aaaaaaaa-0000-4000-8000-000000000001",
    organization_id: ORG,
    event_type: "message.received",
    entity_kind: "message",
    entity_id: "bbbbbbbb-0000-4000-8000-000000000002",
    payload: { contact_id: contactId, direction: "inbound", conversation_id: "conversa-1" },
    created_at: "2026-11-05T12:00:00Z",
  } as unknown as EventRow;
}

describe("contexto de mensagem recebida (#3974)", () => {
  it("traz o negócio do contato, e não só o contato", async () => {
    const contexto = await buildContext(cliente({ contacts: CONTATOS, crm_leads: NEGOCIOS }), eventoDeMensagem());

    expect(contexto.contact).toMatchObject({ id: CONTATO });
    expect(contexto.lead).toMatchObject({ id: NEGOCIO_NOVO });
  });

  it("com vários negócios abertos, vence o MAIS RECENTE da organização do evento", async () => {
    const contexto = await buildContext(cliente({ contacts: CONTATOS, crm_leads: NEGOCIOS }), eventoDeMensagem());

    // O de outra organização é mais novo; se o recorte de org faltasse, seria ele.
    expect(contexto.lead).toMatchObject({ id: NEGOCIO_NOVO });
  });

  it("contato sem negócio não quebra e não inventa `lead`", async () => {
    const contexto = await buildContext(
      cliente({ contacts: CONTATOS, crm_leads: NEGOCIOS }),
      eventoDeMensagem(CONTATO_SEM_NEGOCIO),
    );

    expect(contexto.contact).toMatchObject({ id: CONTATO_SEM_NEGOCIO });
    expect(contexto.lead).toBeUndefined();
  });
});
