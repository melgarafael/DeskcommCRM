import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * PAUSAR/RETOMAR A IA E FECHAR/REABRIR POR TOKEN (#4517, entregas 2 e 3).
 *
 * ─── O que estava quebrado ────────────────────────────────────────────────
 *
 * As três rotas (`pause-ai`, `reactivate-bot`, `close`) só conheciam cookie, e a
 * integração que precisava calar a IA numa conversa não tinha porta nenhuma. O
 * atalho que sobrava era TRANSFERIR — e transferir faz o que a issue proíbe:
 * troca o responsável da conversa (`assignee_kind='user'`) e o do NEGÓCIO
 * (`crm_leads.assigned_to`). Pausar virava takeover.
 *
 * ─── O que este arquivo mede, e por que cada asserção existe ──────────────
 *
 *  1. **Pausar não assume.** Conversa com dono continua com o MESMO dono;
 *     conversa sem dono continua SEM dono. É a sabotagem nº 2 (mandar o pausar
 *     pelo caminho de transferência) que este par de asserções mata.
 *  2. **Ninguém toca no negócio.** A tabela do funil não é lida nem escrita por
 *     este caminho — o dono do negócio é do funil, não do atendimento.
 *  3. **Retomar não solta.** Só `bot_silenced_until` sai; com dono humano o
 *     automático SEGUE vetado, e a resposta diz isso (`automacao_liberada`).
 *  4. **Fechar é a transição da tela.** `fn_service_status` com a revisão lida,
 *     e NÃO um UPDATE em `status` — as regras de revisão/carimbo/demanda são do
 *     banco.
 *  5. **Sem `conversations:write` é 403**, com código nomeado.
 *  6. **Organização alheia não é alcançada**: 404 antes de qualquer escrita.
 *  7. **A tela não mudou**: pessoa pausando conversa sem dono ainda assume.
 */
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));
vi.mock("@/lib/inbox/atividade-de-comando", () => ({
  registrarTrocaDeComando: vi.fn(async () => undefined),
}));
vi.mock("@/lib/escalacao/retomada", () => ({
  devolverAtendimentoAoAgente: vi.fn(),
}));

const adminRpc = vi.fn();
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({ rpc: adminRpc }),
  isServiceRoleConfigured: () => true,
}));

const {
  crmPauseAi,
  crmResumeAi,
  crmCloseConversation,
  crmReopenConversation,
} = await import("@/lib/mcp/tools/comandos-de-conversa");
const { audit } = await import("@/lib/audit");
const { registrarTrocaDeComando } = await import("@/lib/inbox/atividade-de-comando");
const { devolverAtendimentoAoAgente } = await import("@/lib/escalacao/retomada");
const { ApiError } = await import("@/lib/api/types");

const ORG = "aaaaaaaa-4517-4000-8000-0000000000aa";
const OUTRA_ORG = "bbbbbbbb-4517-4000-8000-0000000000bb";
const TOKEN = "cccccccc-4517-4000-8000-0000000000cc";
const CONVERSA = "dddddddd-4517-4000-8000-0000000000dd";
const CONTATO = "eeeeeeee-4517-4000-8000-0000000000ee";
const DONO = "ffffffff-4517-4000-8000-0000000000ff";

type Linha = Record<string, unknown>;

/**
 * As tabelas que este dublê tem de verdade — lista FECHADA de propósito.
 *
 * `Record<string, Linha[]>` fazia `tabelas.conversations` valer `Linha[] |
 * undefined` sob `noUncheckedIndexedAccess`, e o `pnpm typecheck` do CI
 * reprovava com TS18048 nas asserções. Declarar as chaves aqui é a asserção de
 * existência no ponto em que a fixture MONTA as tabelas: quem lê
 * `tabelas.conversations` recebe o array, e um nome fora da lista vira erro.
 */
type NomeDeTabela = "conversations" | "contacts" | "crm_leads";

/**
 * Banco mínimo, com MEMÓRIA DO QUE FOI TOCADO.
 *
 * `tabelasTocadas` é o que prova o item 2: não basta a linha do funil não mudar
 * — o caminho do pausar nem pode LER `crm_leads`. Um `.update` que gravasse o
 * mesmo valor passaria numa asserção de igualdade e seria exatamente o defeito.
 */
function banco(estado: {
  conversas: Linha[];
  contatos?: Linha[];
  negocios?: Linha[];
}) {
  const tabelas: Record<NomeDeTabela, Linha[]> = {
    conversations: estado.conversas,
    contacts: estado.contatos ?? [],
    crm_leads: estado.negocios ?? [],
  };
  const tocadas: string[] = [];
  const atualizacoes: Array<{ tabela: string; payload: Linha }> = [];
  const chamadasRpc: Array<{ fn: string; args: Linha }> = [];

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function cadeia(tabela: NomeDeTabela, op: "select" | "update", payload?: Linha): any {
    const filtros: [string, unknown][] = [];
    const linhas = tabelas[tabela] ?? [];
    const casam = () => linhas.filter((l) => filtros.every(([c, v]) => l[c] === v));
    const c: Record<string, unknown> = {};
    c.eq = (coluna: string, valor: unknown) => {
      filtros.push([coluna, valor]);
      return c;
    };
    c.select = () => c;
    c.limit = () => c;
    c.maybeSingle = async () => ({ data: casam()[0] ?? null, error: null });
    c.single = async () => ({ data: casam()[0] ?? null, error: null });
    if (op === "update") {
      atualizacoes.push({ tabela, payload: payload ?? {} });
      // A escrita é aplicada na PRIMEIRA resolução (maybeSingle/select), como o
      // PostgREST faria — e sempre no fim da cadeia de filtros.
      const aplicar = async () => {
        for (const linha of casam()) Object.assign(linha, payload);
        return { data: casam()[0] ?? null, error: null };
      };
      c.maybeSingle = aplicar;
      c.select = () => c;
    }
    return c;
  }

  const cliente = {
    from: (tabela: NomeDeTabela) => {
      tocadas.push(tabela);
      return {
        select: () => cadeia(tabela, "select"),
        update: (payload: Linha) => cadeia(tabela, "update", payload),
      };
    },
    rpc: async (fn: string, args: Linha) => {
      chamadasRpc.push({ fn, args });
      // `fn_conversation_assign` devolve a linha atribuída; `fn_service_status`
      // devolve a conversa já transicionada.
      const conv = tabelas.conversations?.[0];
      if (fn === "fn_conversation_assign" && conv) {
        conv.assigned_to_user_id = args.p_to_user_id;
        conv.assignee_kind = "user";
        return { data: [conv], error: null };
      }
      if (fn === "fn_service_status" && conv) {
        conv.status = args.p_status;
        return { data: conv, error: null };
      }
      return { data: null, error: null };
    },
  };

  return { cliente: cliente as never, tabelas, tocadas, atualizacoes, chamadasRpc };
}

const ctxToken = (escopos: string[] = ["mcp:write", "conversations:write"]) =>
  ({
    organizationId: ORG,
    actor: { type: "api_token", id: TOKEN, role: "agent" },
    requestId: "req-4517",
    apiTokenId: TOKEN,
    role: "agent",
    tokenScopes: escopos,
  }) as never;

beforeEach(() => {
  vi.clearAllMocks();
  adminRpc.mockReset();
  adminRpc.mockImplementation(async () => ({ data: { id: CONVERSA, status: "closed" }, error: null }));
});

describe("#4517 entrega 2 — pausar a IA por token não troca responsável", () => {
  it("conversa COM dono: silencia, e o dono (da conversa e do negócio) fica onde está", async () => {
    const b = banco({
      conversas: [
        {
          id: CONVERSA,
          organization_id: ORG,
          contact_id: CONTATO,
          status: "open",
          assigned_to_user_id: DONO,
          assignee_kind: "user",
          service_revision: 3,
          bot_silenced_until: null,
        },
      ],
      negocios: [{ id: "neg-1", organization_id: ORG, assigned_to: DONO }],
    });

    const r = await crmPauseAi.handler({ conversation_id: CONVERSA }, { ...(ctxToken() as object), supabase: b.cliente } as never);

    // O efeito pedido: o automático calou.
    expect(b.tabelas.conversations[0]).toMatchObject({
      bot_silenced_until: "infinity",
      last_handoff_reason: "Automático pausado pela integração",
    });
    // A asserção que a sabotagem nº 2 derruba:
    expect(b.tabelas.conversations[0]?.assigned_to_user_id).toBe(DONO);
    expect(b.chamadasRpc.filter((c) => c.fn === "fn_conversation_assign")).toHaveLength(0);
    // Nem leu o funil.
    expect(b.tocadas).not.toContain("crm_leads");
    expect(b.tabelas.crm_leads[0]?.assigned_to).toBe(DONO);
    expect(r).toMatchObject({ paused: true, assumiu_ao_pausar: false });
  });

  it("conversa SEM dono: pausar NÃO assume (o token não tem carteira)", async () => {
    const b = banco({
      conversas: [
        {
          id: CONVERSA,
          organization_id: ORG,
          contact_id: CONTATO,
          status: "open",
          assigned_to_user_id: null,
          assignee_kind: "queue",
          service_revision: 1,
          bot_silenced_until: null,
        },
      ],
    });

    const r = await crmPauseAi.handler({ conversation_id: CONVERSA }, { ...(ctxToken() as object), supabase: b.cliente } as never);

    expect(b.tabelas.conversations[0]?.assigned_to_user_id).toBeNull();
    expect(b.chamadasRpc.filter((c) => c.fn === "fn_conversation_assign")).toHaveLength(0);
    expect(r).toMatchObject({ assumiu_ao_pausar: false });
  });

  it("a TELA continua igual: pessoa pausando conversa sem dono assume", async () => {
    const b = banco({
      conversas: [
        {
          id: CONVERSA,
          organization_id: ORG,
          contact_id: CONTATO,
          status: "open",
          assigned_to_user_id: null,
          assignee_kind: "queue",
          service_revision: 1,
          bot_silenced_until: null,
        },
      ],
    });

    const { pausarIaHandler } = await import("@/app/api/v1/conversations/[id]/_handler");
    const r = await pausarIaHandler(b.cliente, {
      organization_id: ORG,
      actor: { type: "user", id: DONO, role: "agent" },
      requestId: "req-4517",
    }, CONVERSA);

    expect(r.assumiu_ao_pausar).toBe(true);
    expect(b.chamadasRpc.filter((c) => c.fn === "fn_conversation_assign")).toHaveLength(1);
  });

  it("audit: ação própria do token e a LINHA DO TOKEN (qual token pausou)", async () => {
    const b = banco({
      conversas: [
        {
          id: CONVERSA,
          organization_id: ORG,
          contact_id: CONTATO,
          status: "open",
          assigned_to_user_id: DONO,
          assignee_kind: "user",
          service_revision: 1,
          bot_silenced_until: null,
        },
      ],
    });

    await crmPauseAi.handler({ conversation_id: CONVERSA }, { ...(ctxToken() as object), supabase: b.cliente } as never);

    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "conversation.ai_paused_by_token",
        actorUserId: null,
        actorApiTokenId: TOKEN,
        resourceId: CONVERSA,
      }),
    );
    // `tipo` é o tipo de ATIVIDADE (`lib/leads/activity-vocabulary.ts`), com
    // underscore — `conversation.ai_paused` é a AÇÃO do audit log, asserida
    // acima. E a linha da timeline é assinada pelo TOKEN: é ele que diz quem
    // calou o automático, não uma pessoa.
    expect(registrarTrocaDeComando).toHaveBeenCalledWith(
      expect.objectContaining({
        tipo: "conversation_ai_paused",
        conversationId: CONVERSA,
        actor: expect.objectContaining({ type: "api_token", id: TOKEN }),
        payload: { assumiu_ao_pausar: false },
      }),
    );
  });

  it("sem o escopo `conversations:write` é 403 nomeado, e nada é escrito", async () => {
    const b = banco({
      conversas: [
        {
          id: CONVERSA,
          organization_id: ORG,
          contact_id: CONTATO,
          status: "open",
          assigned_to_user_id: DONO,
          assignee_kind: "user",
          service_revision: 1,
          bot_silenced_until: null,
        },
      ],
    });

    const erro = await crmPauseAi
      .handler({ conversation_id: CONVERSA }, { ...(ctxToken(["mcp:write"]) as object), supabase: b.cliente } as never)
      .catch((e: unknown) => e);

    expect(erro).toMatchObject({ mcpCode: -32002, httpStatus: 403, codigo: "forbidden_role" });
    expect(b.atualizacoes).toHaveLength(0);
  });

  it("o AGENTE da casa não pausa a própria automação", async () => {
    const b = banco({ conversas: [] });
    const ctx = {
      ...(ctxToken() as object),
      actor: { type: "ai_agent", id: "run-1", role: "ai_operator" },
      supabase: b.cliente,
    } as never;

    const erro = await crmPauseAi.handler({ conversation_id: CONVERSA }, ctx).catch((e: unknown) => e);

    expect(erro).toBeInstanceOf(ApiError);
    expect((erro as InstanceType<typeof ApiError>).status).toBe(403);
    // A recusa tem de RESPONDER A FRASE. Com o texto na 3ª posição
    // (`details`), `super(message ?? code)` publicava `forbidden` e a
    // integração ficava sem saber o que fazer — foi o defeito que o commit
    // anterior consertou nas rotas e deixou aqui, nas tools MCP.
    expect((erro as InstanceType<typeof ApiError>).message).toContain(
      "não comanda a sua automação",
    );
    // E o 403 volta correlacionável, como os demais erros do handler.
    expect((erro as InstanceType<typeof ApiError>).requestId).toBe("req-4517");
    expect(b.atualizacoes).toHaveLength(0);
  });

  it("conversa de OUTRA organização: 404 antes de qualquer escrita", async () => {
    const b = banco({
      conversas: [
        {
          id: CONVERSA,
          organization_id: OUTRA_ORG,
          contact_id: CONTATO,
          status: "open",
          assigned_to_user_id: DONO,
          assignee_kind: "user",
          service_revision: 1,
          bot_silenced_until: null,
        },
      ],
    });

    const erro = await crmPauseAi
      .handler({ conversation_id: CONVERSA }, { ...(ctxToken() as object), supabase: b.cliente } as never)
      .catch((e: unknown) => e);

    expect(erro).toMatchObject({ status: 404, code: "not_found" });
    expect(b.atualizacoes).toHaveLength(0);
    expect(b.tabelas.conversations[0]?.bot_silenced_until).toBeNull();
  });

  it("conversa encerrada: 409, nada muda", async () => {
    const b = banco({
      conversas: [
        {
          id: CONVERSA,
          organization_id: ORG,
          contact_id: CONTATO,
          status: "closed",
          assigned_to_user_id: DONO,
          assignee_kind: "user",
          service_revision: 2,
          bot_silenced_until: null,
        },
      ],
    });

    const erro = await crmPauseAi
      .handler({ conversation_id: CONVERSA }, { ...(ctxToken() as object), supabase: b.cliente } as never)
      .catch((e: unknown) => e);

    expect(erro).toMatchObject({ status: 409 });
    expect(b.atualizacoes).toHaveLength(0);
  });
});

describe("#4517 entrega 2 — retomar por token não solta o dono", () => {
  it("com dono humano: limpa SÓ o silêncio e diz que o automático NÃO voltou", async () => {
    const b = banco({
      conversas: [
        {
          id: CONVERSA,
          organization_id: ORG,
          contact_id: CONTATO,
          status: "open",
          assigned_to_user_id: DONO,
          assignee_kind: "user",
          service_revision: 4,
          bot_silenced_until: "infinity",
        },
      ],
      contatos: [{ id: CONTATO, organization_id: ORG, force_human: false }],
    });

    const r = await crmResumeAi.handler({ conversation_id: CONVERSA }, { ...(ctxToken() as object), supabase: b.cliente } as never);

    // UMA coluna, e só ela: a sabotagem nº 2 acrescentaria `assigned_to_user_id`.
    expect(Object.keys(b.atualizacoes[0]?.payload ?? {})).toEqual(["bot_silenced_until"]);
    expect(b.tabelas.conversations[0]?.assigned_to_user_id).toBe(DONO);
    expect(b.tabelas.conversations[0]?.bot_silenced_until).toBeNull();
    expect(devolverAtendimentoAoAgente).not.toHaveBeenCalled();
    expect(r).toMatchObject({ automacao_liberada: false, motivo_bloqueio: "responsavel_humano" });
  });

  it("sem dono humano: o silêncio sai e o automático volta", async () => {
    const b = banco({
      conversas: [
        {
          id: CONVERSA,
          organization_id: ORG,
          contact_id: CONTATO,
          status: "open",
          assigned_to_user_id: null,
          assignee_kind: "queue",
          service_revision: 4,
          bot_silenced_until: "infinity",
        },
      ],
      contatos: [{ id: CONTATO, organization_id: ORG, force_human: false }],
    });

    const r = await crmResumeAi.handler({ conversation_id: CONVERSA }, { ...(ctxToken() as object), supabase: b.cliente } as never);

    expect(r).toMatchObject({ reactivated: true, automacao_liberada: true, motivo_bloqueio: null });
    expect(b.atualizacoes[0]?.payload).toEqual({ bot_silenced_until: null });
  });

  it("contato marcado como sempre atendimento humano: o automático segue vetado", async () => {
    const b = banco({
      conversas: [
        {
          id: CONVERSA,
          organization_id: ORG,
          contact_id: CONTATO,
          status: "open",
          assigned_to_user_id: null,
          assignee_kind: "queue",
          service_revision: 4,
          bot_silenced_until: "infinity",
        },
      ],
      contatos: [{ id: CONTATO, organization_id: ORG, force_human: true }],
    });

    const r = await crmResumeAi.handler({ conversation_id: CONVERSA }, { ...(ctxToken() as object), supabase: b.cliente } as never);

    expect(r).toMatchObject({ automacao_liberada: false, motivo_bloqueio: "contato_sempre_humano" });
    // A trava do CONTATO não é limpa por aqui — ela vale para todas as conversas
    // dele, e só quem escala de verdade a escreve.
    expect(b.tabelas.contacts[0]?.force_human).toBe(true);
  });

  it("o agente não se des-trava", async () => {
    const b = banco({ conversas: [] });
    const erro = await crmResumeAi
      .handler(
        { conversation_id: CONVERSA },
        {
          ...(ctxToken() as object),
          actor: { type: "ai_agent", id: "run-1", role: "ai_operator" },
          supabase: b.cliente,
        } as never,
      )
      .catch((e: unknown) => e);

    expect(erro).toBeInstanceOf(ApiError);
    expect((erro as InstanceType<typeof ApiError>).status).toBe(403);
  });
});

describe("#4517 entrega 3 — fechar e reabrir por token com o efeito da tela", () => {
  it("fechar chama `fn_service_status('closed')` com a revisão lida — e não um UPDATE em status", async () => {
    const b = banco({
      conversas: [
        {
          id: CONVERSA,
          organization_id: ORG,
          contact_id: CONTATO,
          status: "open",
          assigned_to_user_id: DONO,
          assignee_kind: "user",
          service_revision: 7,
          bot_silenced_until: null,
        },
      ],
    });

    await crmCloseConversation.handler(
      { conversation_id: CONVERSA, expected_revision: 7 },
      { ...(ctxToken() as object), supabase: b.cliente } as never,
    );

    expect(adminRpc).toHaveBeenCalledWith("fn_service_status", {
      p_org: ORG,
      p_conversation: CONVERSA,
      p_status: "closed",
      p_expected: 7,
    });
    // Nenhum UPDATE direto em `conversations`: revisão, carimbo e demanda são do banco.
    expect(b.atualizacoes).toHaveLength(0);
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "conversation.closed_by_token",
        actorApiTokenId: TOKEN,
        actorUserId: null,
      }),
    );
  });

  it("revisão obsoleta: 409 e o banco não é chamado", async () => {
    const b = banco({
      conversas: [
        {
          id: CONVERSA,
          organization_id: ORG,
          contact_id: CONTATO,
          status: "open",
          assigned_to_user_id: DONO,
          assignee_kind: "user",
          service_revision: 9,
          bot_silenced_until: null,
        },
      ],
    });

    const erro = await crmCloseConversation
      .handler({ conversation_id: CONVERSA, expected_revision: 7 }, { ...(ctxToken() as object), supabase: b.cliente } as never)
      .catch((e: unknown) => e);

    expect(erro).toMatchObject({ status: 409, code: "conflict" });
    expect(adminRpc).not.toHaveBeenCalled();
  });

  it("reabrir chama `fn_service_status('open')` — a mesma transição do botão", async () => {
    const b = banco({
      conversas: [
        {
          id: CONVERSA,
          organization_id: ORG,
          contact_id: CONTATO,
          status: "closed",
          assigned_to_user_id: DONO,
          assignee_kind: "user",
          service_revision: 11,
          bot_silenced_until: null,
        },
      ],
    });

    const r = await crmReopenConversation.handler(
      { conversation_id: CONVERSA },
      { ...(ctxToken() as object), supabase: b.cliente } as never,
    );

    expect(adminRpc).toHaveBeenCalledWith("fn_service_status", {
      p_org: ORG,
      p_conversation: CONVERSA,
      p_status: "open",
      p_expected: 11,
    });
    expect(r).toMatchObject({ reopened: true });
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "conversation.reopened_by_token", actorApiTokenId: TOKEN }),
    );
  });

  it("fechar conversa de OUTRA organização: 404 e o banco não é chamado", async () => {
    const b = banco({
      conversas: [
        {
          id: CONVERSA,
          organization_id: OUTRA_ORG,
          contact_id: CONTATO,
          status: "open",
          assigned_to_user_id: DONO,
          assignee_kind: "user",
          service_revision: 2,
          bot_silenced_until: null,
        },
      ],
    });

    const erro = await crmCloseConversation
      .handler({ conversation_id: CONVERSA }, { ...(ctxToken() as object), supabase: b.cliente } as never)
      .catch((e: unknown) => e);

    expect(erro).toMatchObject({ status: 404 });
    expect(adminRpc).not.toHaveBeenCalled();
  });
});
