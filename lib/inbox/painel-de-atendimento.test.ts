import { describe, expect, it } from "vitest";

import { listConversationsHandler } from "@/app/api/v1/conversations/_handler";
import { ehAFila, ORDEM_DA_ESPERA } from "@/lib/inbox/comando-da-conversa";
import { conversationStatusFiltroSchema, CONVERSATION_TERMINAL_STATUSES, listConversationsQuerySchema } from "@/lib/schemas";

import { automaticoNoComando, consultasDoPainel, haQuantoTempo, montarColunas, type ConversaDoPainel } from "./painel-de-atendimento";

const agora = new Date("2026-10-23T21:00:00Z");
const SP = "America/Sao_Paulo";
function conv(id: string, p: Partial<ConversaDoPainel>): ConversaDoPainel {
  return {
    id,
    status: "open",
    created_at: "2026-10-01T12:00:00Z",
    last_inbound_at: null,
    last_outbound_at: null,
    last_message_at: null,
    awaiting_since: null,
    ...p,
  };
}

const consultas = (automaticoDaOrg?: boolean, numero = "") => consultasDoPainel({ numero, automaticoDaOrg, fuso: SP, agora });

function parametros(url: string) {
  const u = new URL(url, "http://local");
  const r = listConversationsQuerySchema.safeParse({
    status: u.searchParams.get("status") ?? undefined,
    exclude_finished: u.searchParams.get("exclude_finished") === "true" ? true : undefined,
    comando: u.searchParams.get("comando") ?? undefined,
    closed_since: u.searchParams.get("closed_since") ?? undefined,
    limit: u.searchParams.get("limit") ?? undefined,
  });
  if (!r.success) throw new Error(JSON.stringify(r.error.flatten()));
  return r.data;
}

/** O que a rota pede ao banco: a mesma cadeia que `nao-lidos-filtra-no-banco` mede. */
async function chamadasAoBanco(url: string) {
  const chamadas: Array<{ metodo: string; args: unknown[] }> = [];
  const client = {
    from: (tabela: string) => {
      const proxy: Record<string, unknown> = new Proxy(
        {},
        {
          get(_t, prop) {
            if (prop === "then") return (ok: (v: unknown) => unknown) => ok({ data: [], error: null });
            return (...args: unknown[]) => {
              if (tabela === "conversations") chamadas.push({ metodo: String(prop), args });
              return proxy;
            };
          },
        },
      );
      return proxy;
    },
  };
  const ctx = { organization_id: "org-1", requestId: "req-1", actor: { type: "user", id: "user-1" } };
  await listConversationsHandler(client as never, ctx as never, parametros(url));
  return chamadas;
}

describe("painel de atendimento", () => {
  it("cliente que falou por último fica em Aguardando, o mais antigo em cima", () => {
    const { aguardando, emAtendimento } = montarColunas(
      [
        conv("novo", { last_inbound_at: "2026-10-23T20:50:00Z", last_outbound_at: "2026-10-23T20:00:00Z" }),
        conv("antigo", { last_inbound_at: "2026-10-23T19:00:00Z" }),
        conv("respondido", { last_inbound_at: "2026-10-23T19:30:00Z", last_outbound_at: "2026-10-23T19:31:00Z", last_message_at: "2026-10-23T19:31:00Z" }),
      ],
      SP,
      agora,
    );
    expect(aguardando.map((c) => c.id)).toEqual(["antigo", "novo"]);
    expect(emAtendimento.map((c) => c.id)).toEqual(["respondido"]);
  });

  it("resposta da IA conta como atendimento", () => {
    const { aguardando, emAtendimento } = montarColunas(
      [conv("ia", { status: "ai_handling", last_inbound_at: "2026-10-23T20:00:00Z", last_outbound_at: "2026-10-23T20:00:05Z" })],
      SP,
      agora,
    );
    expect(aguardando).toHaveLength(0);
    expect(emAtendimento.map((c) => c.id)).toEqual(["ia"]);
  });

  it("conversa sem dono no automático, já respondida, não entra em Aguardando pela `awaiting_since` antiga", () => {
    const robo = conv("robo", {
      status: "open",
      comando_da_conversa: "automatico",
      awaiting_since: "2026-10-20T10:00:00Z",
      last_inbound_at: "2026-10-20T10:00:00Z",
      last_outbound_at: "2026-10-20T10:00:04Z",
    });
    const { aguardando, emAtendimento } = montarColunas([robo], SP, agora);
    expect(aguardando).toHaveLength(0);
    expect(emAtendimento.map((c) => c.id)).toEqual(["robo"]);
  });

  it("awaiting_since velho (antes da nossa resposta) não manda a conversa pro topo", () => {
    const { aguardando } = montarColunas(
      [
        conv("insistente", {
          awaiting_since: "2026-10-23T12:00:00Z",
          last_outbound_at: "2026-10-23T18:00:00Z",
          last_inbound_at: "2026-10-23T20:30:00Z",
        }),
        conv("esperando", { awaiting_since: "2026-10-23T19:00:00Z", last_inbound_at: "2026-10-23T19:10:00Z" }),
      ],
      SP,
      agora,
    );
    expect(aguardando.map((c) => [c.id, c.esperandoDesde])).toEqual([
      ["esperando", "2026-10-23T19:00:00Z"],
      ["insistente", "2026-10-23T20:30:00Z"],
    ]);
  });

  // A linha é a medida no banco depois da passagem pelo motor (prova de tela do #3403): `open`, não `pending`.
  describe("conversa que a IA passou para a equipe", () => {
    const naEspera = { status: "open", comando_da_conversa: "aguardando", bot_silenced_until: "infinity", awaiting_since: "2026-10-23T19:59:00Z" };

    it("com o aviso da IA como última palavra fica em Aguardando, pela régua da Fila", () => {
      const { aguardando, emAtendimento } = montarColunas(
        [conv("aviso", { ...naEspera, last_inbound_at: "2026-10-23T19:59:00Z", last_outbound_at: "2026-10-23T20:00:04Z" })],
        SP,
        agora,
      );
      expect(emAtendimento).toHaveLength(0);
      expect(aguardando.map((c) => [c.id, c.esperandoDesde])).toEqual([["aviso", "2026-10-23T19:59:00Z"]]);
    });

    it("com resposta humana sem assumir segue em Aguardando, até alguém assumir", () => {
      const { aguardando } = montarColunas(
        [conv("respondida", { ...naEspera, last_inbound_at: "2026-10-23T19:59:00Z", last_outbound_at: "2026-10-23T20:10:00Z" })],
        SP,
        agora,
      );
      expect(aguardando.map((c) => c.id)).toEqual(["respondida"]);
    });

    it("com dono segue a regra de quem falou por último", () => {
      const { aguardando, emAtendimento } = montarColunas(
        [
          conv("assumida", { status: "claimed", comando_da_conversa: "humano", bot_silenced_until: "infinity", last_inbound_at: "2026-10-23T19:59:00Z", last_outbound_at: "2026-10-23T20:10:00Z" }),
          conv("cobrando", { status: "claimed", comando_da_conversa: "humano", bot_silenced_until: "infinity", last_inbound_at: "2026-10-23T20:20:00Z", last_outbound_at: "2026-10-23T20:10:00Z" }),
        ],
        SP,
        agora,
      );
      expect(aguardando.map((c) => c.id)).toEqual(["cobrando"]);
      expect(emAtendimento.map((c) => c.id)).toEqual(["assumida"]);
    });

    it("sem mensagem nenhuma do cliente usa a criação da conversa", () => {
      const { aguardando } = montarColunas([conv("calada", { status: "open", comando_da_conversa: "aguardando", bot_silenced_until: "infinity" })], SP, agora);
      expect(aguardando.map((c) => c.esperandoDesde)).toEqual(["2026-10-01T12:00:00Z"]);
    });
  });

  describe("sem dono, na janela de 5 min depois de uma resposta manual", () => {
    const naJanela = {
      status: "open",
      comando_da_conversa: "aguardando",
      bot_silenced_until: "2026-10-23T21:03:00Z",
      awaiting_since: "2026-10-23T20:50:00Z",
      last_inbound_at: "2026-10-23T20:50:00Z",
      last_outbound_at: "2026-10-23T20:58:00Z",
    };

    it("fica em Em atendimento, porque alguém acabou de responder", () => {
      const { aguardando, emAtendimento } = montarColunas([conv("respondida", naJanela)], SP, agora);
      expect(aguardando).toHaveLength(0);
      expect(emAtendimento.map((c) => c.id)).toEqual(["respondida"]);
    });

    it("a janela vencer no navegador antes da próxima consulta não joga o cartão em Aguardando", () => {
      const depois = new Date("2026-10-23T21:03:01Z");
      expect(montarColunas([conv("respondida", naJanela)], SP, depois).aguardando).toHaveLength(0);
    });

    it("o cliente voltar a falar a leva para Aguardando", () => {
      const { aguardando } = montarColunas([conv("voltou", { ...naJanela, last_inbound_at: "2026-10-23T20:59:00Z" })], SP, agora);
      expect(aguardando.map((c) => c.id)).toEqual(["voltou"]);
    });

    it("grupo e contato travado seguem em Aguardando: não há automático para quem a janela devolver", () => {
      const { aguardando } = montarColunas(
        [
          conv("grupo", { ...naJanela, is_group: true }),
          conv("travado", { ...naJanela, contacts: { force_human: true } }),
          conv("bloqueado", { ...naJanela, contacts: { is_blocked: true } }),
        ],
        SP,
        agora,
      );
      expect(aguardando.map((c) => c.id).sort()).toEqual(["bloqueado", "grupo", "travado"]);
    });
  });

  describe("ícone do automático", () => {
    it("aparece na conversa que o automático está atendendo", () => {
      expect(automaticoNoComando(conv("robo", { comando_da_conversa: "automatico" }), true)).toBe(true);
    });

    it("não aparece na encerrada, mesmo com o `assignee_kind='ai'` que o encerramento grava", () => {
      const encerrada = { ...conv("fechada", { status: "closed", comando_da_conversa: "encerrada" }), assignee_kind: "ai" };
      expect(automaticoNoComando(encerrada, true)).toBe(false);
    });

    it("não afirma automático em org sem automático, nem enquanto não se sabe", () => {
      const c = conv("sem", { comando_da_conversa: "automatico" });
      expect(automaticoNoComando(c, false)).toBe(false);
      expect(automaticoNoComando(c, undefined)).toBe(false);
    });
  });

  it("a mesma conversa vinda das duas consultas aparece uma vez só", () => {
    const c = conv("repetida", { last_inbound_at: "2026-10-23T20:00:00Z" });
    expect(montarColunas([c, { ...c }], SP, agora).aguardando).toHaveLength(1);
  });

  it("encerradas hoje vão para Atendidos; as de outro dia e arquivadas ficam de fora", () => {
    const { atendidosHoje } = montarColunas(
      [
        conv("hoje", { status: "closed", service_closed_at: "2026-10-23T18:00:00Z" }),
        conv("ontem", { status: "closed", service_closed_at: "2026-10-21T18:00:00Z" }),
        conv("arquivada", { status: "archived", service_closed_at: "2026-10-23T18:00:00Z" }),
      ],
      SP,
      agora,
    );
    expect(atendidosHoje.map((c) => c.id)).toEqual(["hoje"]);
  });

  it("o dia de Atendidos é o da organização, não o do aparelho", () => {
    const manha = new Date("2026-10-23T10:00:00Z");
    const c = conv("virada", { status: "closed", service_closed_at: "2026-10-23T02:30:00Z" });
    expect(montarColunas([c], "America/Sao_Paulo", manha).atendidosHoje).toHaveLength(0);
    expect(montarColunas([c], "Asia/Tokyo", manha).atendidosHoje).toHaveLength(1);
  });

  it("mostra o tempo de espera de forma curta, sempre para baixo", () => {
    expect(haQuantoTempo("2026-10-23T20:35:00Z", agora)).toBe("25 min");
    expect(haQuantoTempo("2026-10-23T20:00:01Z", agora)).toBe("59 min");
    expect(haQuantoTempo("2026-10-23T19:00:01Z", agora)).toBe("1 h");
    expect(haQuantoTempo("2026-10-23T18:00:00Z", agora)).toBe("3 h");
    expect(haQuantoTempo("2026-10-20T21:00:00Z", agora)).toBe("3 d");
  });

  describe("consulta e regra no mesmo conjunto", () => {
    it("todo status vivo que `abertas` traz cabe em coluna; o `resolved` legado não vira conversa aberta", () => {
      expect(parametros(consultas().abertas).exclude_finished).toBe(true);
      const trazidos = conversationStatusFiltroSchema.options.filter(
        (s) => !(CONVERSATION_TERMINAL_STATUSES as readonly string[]).includes(s),
      );
      expect(trazidos).toContain("pending");
      for (const status of trazidos) {
        const { aguardando, emAtendimento } = montarColunas([conv("c", { status })], SP, agora);
        expect(aguardando.length + emAtendimento.length).toBe(status === "resolved" ? 0 : 1);
      }
    });

    it("a consulta da fila é a da aba Fila: pede quem manda, não `sem dono`", async () => {
      const url = consultas().fila;
      expect(url).not.toContain("assigned_to");
      expect(parametros(url).comando).toEqual(["aguardando"]);
      expect(ehAFila(parametros(url))).toBe(true);
      expect(parametros(consultas(false).fila).comando).toEqual(["aguardando", "automatico"]);
      expect(parametros(consultas(true).fila).comando).toEqual(["aguardando"]);

      const chamadas = await chamadasAoBanco(url);
      expect(chamadas).toContainEqual({ metodo: "in", args: ["comando_da_conversa", ["aguardando"]] });
      expect(chamadas).toContainEqual({ metodo: "order", args: [ORDEM_DA_ESPERA.coluna, ORDEM_DA_ESPERA.opcoes] });
      expect(chamadas.some((c) => c.args[0] === "assigned_to_user_id")).toBe(false);
    });

    it("`encerradas` recorta no banco pelo encerramento, a partir da meia-noite da organização", async () => {
      const url = consultasDoPainel({ numero: "", automaticoDaOrg: true, fuso: SP, agora: new Date("2026-10-23T10:00:00Z") }).encerradas;
      const chamadas = await chamadasAoBanco(url);
      expect(chamadas).toContainEqual({ metodo: "gte", args: ["service_closed_at", "2026-10-23T03:00:00.000Z"] });
      expect(chamadas).toContainEqual({ metodo: "eq", args: ["organization_id", "org-1"] });
    });

    it("o filtro de número vale nas três", () => {
      for (const url of Object.values(consultas(true, "b5a2f1de-6a0e-4f3a-9d57-0a1b2c3d4e5f"))) {
        expect(url).toContain("&channel_session_id=b5a2f1de-6a0e-4f3a-9d57-0a1b2c3d4e5f");
      }
    });
  });
});
