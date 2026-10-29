import { beforeEach, describe, expect, it, vi } from "vitest";

import type * as IngestModule from "@/lib/waha/ingest";

// ingest.ts importa @/lib/audit (→ supabase/server → validação de env).
const auditEspiao = vi.hoisted(() => vi.fn());
vi.mock("@/lib/audit", () => ({ audit: auditEspiao }));

// ESPIÕES: a rodada grava o passado e nada mais. Qualquer um destes chamado
// seria um efeito de mensagem NOVA (IA, demanda, push, carimbo da conversa).
const espioes = vi.hoisted(() => ({
  dispatch: vi.fn(),
  posEntrada: vi.fn(),
  marcar: vi.fn(),
}));
vi.mock("@/lib/waha/ingest", async (orig) => ({
  ...(await orig<typeof IngestModule>()),
  dispatchWahaEvent: espioes.dispatch,
}));
vi.mock("@/lib/channels/pos-entrada", () => ({ aplicarEfeitosPosEntrada: espioes.posEntrada }));
vi.mock("@/lib/channels/marcar-conversa", () => ({ marcarConversaComMensagem: espioes.marcar }));

// O canal de mentira: a mesma página que o cliente devolve, sem HTTP.
const canal = vi.hoisted(() => ({
  chats: [] as Array<Record<string, unknown>>,
  mensagens: {} as Record<string, Array<Record<string, unknown>>>,
  falha: null as string | null,
  chamadas: [] as string[],
  /** Teto do canal por página, abaixo do `limit` pedido (o canal pode devolver menos). */
  maxPorPagina: Number.POSITIVE_INFINITY,
  /** Gancho chamado a cada página de mensagens (para simular cancelamento no meio). */
  aoLerMensagens: null as null | (() => void),
  /** O que o canal resolve de lid para telefone (`/lids/{lid}`). */
  telefoneDoLid: {} as Record<string, string>,
  /** Falha de transporte em `/lids/{lid}`: lança só quando quem chama pediu `falhaLanca`. */
  falhaNoLid: null as string | null,
}));
vi.mock("@/lib/waha/client", () => ({
  getWahaClient: () => ({
    async paginaDeConversas(session: string, opts: { limit: number; offset: number }) {
      canal.chamadas.push(`chats:${session}:${opts.offset}`);
      const fatia = canal.chats.slice(opts.offset, opts.offset + opts.limit);
      const conversas = fatia
        .map((c, i) => ({ chatId: c.id as string, ultimaEm: (c.ultimaEm as number) ?? null, posicao: opts.offset + i }))
        .filter((c) => !c.chatId.endsWith("@g.us") && c.chatId !== "status@broadcast");
      return { conversas, lidas: fatia.length };
    },
    async resolvePhoneForLid(session: string, lid: string, opts: { falhaLanca?: boolean } = {}) {
      canal.chamadas.push(`lid:${session}:${lid}`);
      if (canal.falhaNoLid) {
        if (opts.falhaLanca) throw new Error(canal.falhaNoLid);
        return null;
      }
      return canal.telefoneDoLid[lid] ?? null;
    },
    async paginaDeMensagens(session: string, chatId: string, opts: { limit: number; offset: number; desde: number }) {
      canal.chamadas.push(`msgs:${session}:${chatId}:${opts.offset}:${opts.limit}`);
      if (canal.falha) throw new Error(canal.falha);
      canal.aoLerMensagens?.();
      const bruto = (canal.mensagens[chatId] ?? [])
        .filter((m) => typeof m.timestamp === "number" && (m.timestamp as number) >= opts.desde)
        .sort((a, b) => (a.timestamp as number) - (b.timestamp as number))
        .slice(opts.offset, opts.offset + Math.min(opts.limit, canal.maxPorPagina));
      // `invalido` = o item que o schema do cliente recusaria: conta em `lidas`, não vem.
      return { mensagens: bruto.filter((m) => !m.invalido), lidas: bruto.length };
    },
  }),
}));

import { rodarUmaRodada } from "@/lib/channels/historico/rodada";

const ORG = "org-1";
const SESSAO = "sess-1";
const IMP = "imp-1";
const agora = Math.floor(Date.now() / 1000);
const DIA = 86_400;

type Linha = Record<string, unknown>;

/** Banco em memória com as regras de que o desfecho depende: a unique
 * (organization_id, external_id), o formato do telefone e a chave da conversa 1:1. */
function bancoDeMentira() {
  const importacoes = new Map<string, Linha>();
  const messages: Linha[] = [];
  const conversations = new Map<string, Linha>();
  const contatos = new Map<string, string>();
  const rpcs: Array<{ fn: string; args: Record<string, unknown> }> = [];
  const tabelasTocadas: string[] = [];
  /** Telefones (canônicos) e lids marcados como apagados a pedido; `falhaNaMarca` simula erro na pergunta. */
  const apagados = new Set<string>();
  let falhaNaMarca: string | null = null;
  let antesDoInsert: (() => void) | null = null;
  /** Força a resposta de um insert (lote ou linha); `null` deixa seguir. */
  let forcarInsert: ((linhas: Linha | Linha[]) => Linha | null) | null = null;

  const colide = (l: Linha, contra: Linha[]) =>
    contra.some((m) => m.organization_id === l.organization_id && m.external_id === l.external_id);

  const admin = {
    rpc(fn: string, args: Record<string, unknown>) {
      rpcs.push({ fn, args });
      if (fn === "fn_titular_apagado_a_pedido") {
        if (falhaNaMarca) return Promise.resolve({ data: null, error: { message: falhaNaMarca } });
        return Promise.resolve({ data: apagados.has(args.p_telefone as string) || apagados.has(args.p_lid as string), error: null });
      }
      if (fn === "fn_upsert_wa_contact") {
        if (args.p_phone != null && !/^\+\d{8,15}$/.test(String(args.p_phone))) {
          return Promise.resolve({ data: null, error: { code: "23514", message: 'new row for relation "contacts" violates check constraint "contacts_phone_e164_format"' } });
        }
        const chave = `${args.p_kind}:${args.p_kind === "lid" ? args.p_lid : args.p_phone}`;
        if (!contatos.has(chave)) contatos.set(chave, `ct-${contatos.size + 1}`);
        return Promise.resolve({ data: contatos.get(chave), error: null });
      }
      if (fn === "fn_upsert_wa_conversation_importada") {
        const existente = [...conversations.values()].find(
          (c) => c.organization_id === args.p_org && c.contact_id === args.p_contact && c.channel_session_id === args.p_session,
        );
        if (existente) return Promise.resolve({ data: existente.id, error: null });
        const id = `cv-${conversations.size + 1}`;
        conversations.set(id, {
          id,
          organization_id: args.p_org,
          contact_id: args.p_contact,
          channel_session_id: args.p_session,
          status: "closed",
          assigned_to_user_id: null,
        });
        return Promise.resolve({ data: id, error: null });
      }
      return Promise.resolve({ data: null, error: { message: `rpc inesperada: ${fn}` } });
    },
    from(tabela: string) {
      tabelasTocadas.push(tabela);
      if (tabela === "importacoes_de_historico") {
        return {
          select: () => ({
            eq: (_c: string, id: string) => ({
              maybeSingle: async () => ({ data: importacoes.has(id) ? { ...importacoes.get(id) } : null, error: null }),
            }),
          }),
          update: (patch: Linha) => {
            const filtros: Array<[string, unknown]> = [];
            const q = {
              eq: (c: string, v: unknown) => (filtros.push([c, v]), q),
              select: async () => {
                const alvos = [...importacoes.values()].filter((l) => filtros.every(([c, v]) => l[c] === v));
                for (const l of alvos) importacoes.set(l.id as string, { ...l, ...structuredClone(patch) });
                return { data: alvos.map((l) => ({ id: l.id })), error: null };
              },
            };
            return q;
          },
        };
      }
      if (tabela === "channel_sessions") {
        const q = {
          eq: () => q,
          maybeSingle: async () => ({ data: { waha_session_name: "nome-no-canal" }, error: null }),
        };
        return { select: () => q };
      }
      if (tabela === "messages") {
        return {
          select: () => {
            let org: unknown = null;
            let ids: unknown[] = [];
            const q = {
              eq: (_c: string, v: unknown) => ((org = v), q),
              in: (_c: string, v: unknown[]) => ((ids = v), q),
              then: (ok: (v: unknown) => unknown) =>
                Promise.resolve(
                  ok({
                    data: messages
                      .filter((m) => m.organization_id === org && ids.includes(m.external_id))
                      .map((m) => ({ external_id: m.external_id })),
                    error: null,
                  }),
                ),
            };
            return q;
          },
          insert: async (linhas: Linha | Linha[]) => {
            if (antesDoInsert) {
              const f = antesDoInsert;
              antesDoInsert = null;
              f();
            }
            const forcado = forcarInsert?.(linhas) ?? null;
            if (forcado) return { error: forcado };
            const lote = Array.isArray(linhas) ? linhas : [linhas];
            const aceitas: Linha[] = [];
            for (const l of lote) {
              if (colide(l, messages) || colide(l, aceitas)) {
                return { error: { code: "23505", message: 'duplicate key value violates "messages_org_external_id_unique"' } };
              }
              aceitas.push(l);
            }
            messages.push(...aceitas.map((l) => structuredClone(l)));
            return { error: null };
          },
        };
      }
      throw new Error(`tabela inesperada: ${tabela}`);
    },
  };

  return {
    admin,
    importacoes,
    messages,
    conversations,
    rpcs,
    tabelasTocadas,
    apagados,
    falharNaMarca(msg: string) {
      falhaNaMarca = msg;
    },
    webhookAntesDoInsert(l: Linha) {
      antesDoInsert = () => messages.push(l);
    },
    forcarInsert(f: (linhas: Linha | Linha[]) => Linha | null) {
      forcarInsert = f;
    },
  };
}

function novaImportacao(db: ReturnType<typeof bancoDeMentira>, extra: Linha = {}) {
  db.importacoes.set(IMP, {
    id: IMP,
    organization_id: ORG,
    channel_session_id: SESSAO,
    status: "rodando",
    dias: 30,
    cursor: {},
    conversas_feitas: 0,
    mensagens_gravadas: 0,
    mensagens_existentes: 0,
    mensagens_ignoradas: 0,
    erro: null,
    ...extra,
  });
}

const TEL = "5511900000001@s.whatsapp.net";
const LID = "111111111111111@lid";

function acervoPadrao() {
  canal.chats = [
    { id: TEL, ultimaEm: agora - DIA },
    { id: "120363000000000001@g.us", ultimaEm: agora },
    { id: LID, ultimaEm: agora - DIA },
  ];
  canal.mensagens = {
    [TEL]: [
      { id: `false_${TEL}_A1`, from: TEL, fromMe: false, body: "oi", timestamp: agora - 3 * DIA, _data: { pushName: "Ana" } },
      { id: `true_${TEL}_A2`, from: "5511999999999@c.us", to: TEL, fromMe: true, body: "olá", timestamp: agora - 2 * DIA },
      // reação: não é fala, não vira linha
      { id: `false_${TEL}_A3`, from: TEL, type: "reaction", reaction: { text: "👍", messageId: "x" }, timestamp: agora - 2 * DIA + 1 },
      // sem id: não há como deduplicar, não vira linha
      { from: TEL, body: "sem id", timestamp: agora - 2 * DIA + 2 },
      // fora da janela de 30 dias
      { id: `false_${TEL}_A0`, from: TEL, body: "antiga", timestamp: agora - 40 * DIA },
    ],
    [LID]: [
      {
        id: `false_${LID}_B1`,
        from: LID,
        fromMe: false,
        body: "bom dia",
        timestamp: agora - 5 * DIA,
        _data: { key: { remoteJidAlt: "5511900000002@s.whatsapp.net" } },
      },
      { id: `true_${LID}_B2`, from: "5511999999999@c.us", to: LID, fromMe: true, body: "bom dia!", timestamp: agora - 4 * DIA },
    ],
  };
}

const SEM_TETO = { conversas: 1000, mensagens: 100_000, chamadas: 10_000 };

beforeEach(() => {
  canal.falha = null;
  canal.chamadas = [];
  canal.maxPorPagina = Number.POSITIVE_INFINITY;
  canal.aoLerMensagens = null;
  canal.telefoneDoLid = {};
  canal.falhaNoLid = null;
  auditEspiao.mockReset();
  espioes.dispatch.mockReset();
  espioes.posEntrada.mockReset();
  espioes.marcar.mockReset();
  acervoPadrao();
});

describe("rodarUmaRodada", () => {
  it.each(["0@s.whatsapp.net", "0@c.us"])("ignora avisos de %s e importa os chats seguintes (#3519)", async (chat) => {
    canal.chats.unshift({ id: chat, ultimaEm: agora });
    canal.mensagens[chat] = [
      { id: `false_${chat}_AVISO`, from: chat, fromMe: false, body: "Aviso do WhatsApp", timestamp: agora - DIA },
    ];
    const db = bancoDeMentira();
    novaImportacao(db);

    // O primeiro lote só encontra o aviso. A retomada precisa alcançar telefone e LID.
    const primeira = await rodarUmaRodada(db.admin as never, IMP, { conversas: 1, mensagens: 300 });
    expect(primeira).toEqual({ status: "rodando", gravadas: 0, existentes: 0 });
    expect(db.importacoes.get(IMP)).toMatchObject({
      cursor: { indiceConversa: 1, offsetMensagens: 0 },
      mensagens_ignoradas: 1,
      erro: null,
    });
    expect(db.rpcs.filter((x) => x.fn === "fn_upsert_wa_contact")).toHaveLength(0);

    expect(await rodarUmaRodada(db.admin as never, IMP, SEM_TETO)).toEqual({ status: "concluida", gravadas: 4, existentes: 0 });
    expect(db.importacoes.get(IMP)).toMatchObject({ status: "concluida", mensagens_gravadas: 4, mensagens_ignoradas: 3, erro: null });
    expect(db.messages.map((m) => m.external_id).sort()).toEqual([`false_${TEL}_A1`, "A2", `false_${LID}_B1`, "B2"].sort());
    const contatos = db.rpcs.filter((x) => x.fn === "fn_upsert_wa_contact").map((x) => x.args);
    expect(contatos).toContainEqual(expect.objectContaining({ p_kind: "phone", p_phone: "+5511900000001" }));
    expect(contatos).toContainEqual(expect.objectContaining({ p_kind: "lid", p_lid: "111111111111111", p_phone: "+5511900000002" }));
    expect(contatos.every((c) => c.p_chat_id !== chat)).toBe(true);
    expect(espioes.dispatch).not.toHaveBeenCalled();
    expect(espioes.posEntrada).not.toHaveBeenCalled();
  });

  it("grava contato, conversa e mensagens marcadas como histórico, e conclui", async () => {
    const db = bancoDeMentira();
    novaImportacao(db);
    const r = await rodarUmaRodada(db.admin as never, IMP, SEM_TETO);

    expect(r).toEqual({ status: "concluida", gravadas: 4, existentes: 0 });
    // contato pela RPC do ingest, com o telefone canônico e, no @lid, o alternativo
    const contatos = db.rpcs.filter((x) => x.fn === "fn_upsert_wa_contact").map((x) => x.args);
    expect(contatos).toContainEqual(
      expect.objectContaining({ p_org: ORG, p_kind: "phone", p_phone: "+5511900000001", p_lid: null, p_chat_id: TEL, p_notify: "Ana" }),
    );
    expect(contatos).toContainEqual(
      expect.objectContaining({ p_org: ORG, p_kind: "lid", p_phone: "+5511900000002", p_lid: "111111111111111", p_chat_id: LID }),
    );
    expect(db.rpcs.filter((x) => x.fn === "fn_upsert_wa_conversation_importada").length).toBeGreaterThanOrEqual(2);
    // A conversa nova nasce com a data da última mensagem que o canal tem nela
    // (`ultimaEm`), para a inbox ordená-la; a RPC só grava no INSERT.
    const datas = db.rpcs.filter((x) => x.fn === "fn_upsert_wa_conversation_importada").map((x) => x.args.p_last_message_at);
    expect(new Set(datas)).toEqual(new Set([new Date((agora - DIA) * 1000).toISOString()]));
    expect(db.messages.map((m) => m.external_id).sort()).toEqual(
      [`false_${TEL}_A1`, "A2", `false_${LID}_B1`, "B2"].sort(),
    );
    for (const m of db.messages) {
      expect(m.metadata).toMatchObject({ historico_importado: "true" });
      expect(m.organization_id).toBe(ORG);
      expect(m.channel_session_id).toBe(SESSAO);
    }
    // a sessão é endereçada pelo nome no canal, não pelo id do CRM
    expect(canal.chamadas.every((c) => c.split(":")[1] === "nome-no-canal")).toBe(true);
    const imp = db.importacoes.get(IMP)!;
    expect(imp).toMatchObject({
      status: "concluida",
      conversas_feitas: 2,
      mensagens_gravadas: 4,
      mensagens_existentes: 0,
      mensagens_ignoradas: 2,
    });
  });

  it("guarda o `desde` no cursor na primeira rodada e o reusa nas seguintes", async () => {
    const db = bancoDeMentira();
    novaImportacao(db);
    await rodarUmaRodada(db.admin as never, IMP, { conversas: 1, mensagens: 300 });
    const desde = (db.importacoes.get(IMP)!.cursor as { desde: number }).desde;
    expect(desde).toBeGreaterThanOrEqual(agora - 30 * DIA - 5);
    expect(desde).toBeLessThanOrEqual(agora - 30 * DIA + 5);
    await rodarUmaRodada(db.admin as never, IMP, { conversas: 1, mensagens: 300 });
    expect((db.importacoes.get(IMP)!.cursor as { desde: number }).desde).toBe(desde);
  });

  it("retomada: rodadas de 1 conversa chegam ao MESMO total de uma rodada sem teto, sem repetir", async () => {
    const inteira = bancoDeMentira();
    novaImportacao(inteira);
    await rodarUmaRodada(inteira.admin as never, IMP, SEM_TETO);

    const fatiada = bancoDeMentira();
    novaImportacao(fatiada);
    const primeira = await rodarUmaRodada(fatiada.admin as never, IMP, { conversas: 1, mensagens: 300 });
    expect(primeira.status).toBe("rodando");
    expect(fatiada.messages.map((m) => m.external_id).sort()).toEqual([`false_${TEL}_A1`, "A2"].sort());
    expect(fatiada.importacoes.get(IMP)!.cursor).toMatchObject({ indiceConversa: 1, offsetMensagens: 0 });

    let ultima = primeira;
    for (let i = 0; i < 5 && ultima.status === "rodando"; i++) {
      ultima = await rodarUmaRodada(fatiada.admin as never, IMP, { conversas: 1, mensagens: 300 });
    }
    expect(ultima.status).toBe("concluida");
    const ids = fatiada.messages.map((m) => m.external_id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.sort()).toEqual(inteira.messages.map((m) => m.external_id).sort());
    const a = fatiada.importacoes.get(IMP)!;
    const b = inteira.importacoes.get(IMP)!;
    for (const k of ["conversas_feitas", "mensagens_gravadas", "mensagens_existentes", "mensagens_ignoradas"]) {
      expect(a[k]).toBe(b[k]);
    }
  });

  it("teto de mensagens corta no meio da conversa e a próxima rodada continua do offset", async () => {
    const db = bancoDeMentira();
    novaImportacao(db);
    const r = await rodarUmaRodada(db.admin as never, IMP, { conversas: 10, mensagens: 1 });
    // a 1ª página é da conferência: lida, não gravada
    expect(r).toMatchObject({ status: "rodando", gravadas: 0 });
    expect(db.importacoes.get(IMP)!.cursor).toMatchObject({ indiceConversa: 0, offsetMensagens: 1, conferida: false });
    let ultima = r;
    for (let i = 0; i < 40 && ultima.status === "rodando"; i++) {
      ultima = await rodarUmaRodada(db.admin as never, IMP, { conversas: 10, mensagens: 1 });
    }
    expect(ultima.status).toBe("concluida");
    expect(db.messages).toHaveLength(4);
  });

  it("Foco 2: mensagem que o webhook já gravou conta como existente e não é inserida", async () => {
    const db = bancoDeMentira();
    novaImportacao(db);
    // o ao vivo grava a saída pelo id bare
    db.messages.push({ organization_id: ORG, external_id: "A2" });
    const r = await rodarUmaRodada(db.admin as never, IMP, SEM_TETO);
    expect(r).toEqual({ status: "concluida", gravadas: 3, existentes: 1 });
    expect(db.messages.filter((m) => m.external_id === "A2")).toHaveLength(1);
    expect(db.importacoes.get(IMP)).toMatchObject({ mensagens_existentes: 1, mensagens_gravadas: 3 });
  });

  it("Foco 2: corrida com o webhook (23505 no insert) vira existente e a rodada segue", async () => {
    const db = bancoDeMentira();
    novaImportacao(db);
    db.webhookAntesDoInsert({ organization_id: ORG, external_id: `false_${TEL}_A1` });
    const r = await rodarUmaRodada(db.admin as never, IMP, SEM_TETO);
    expect(r).toEqual({ status: "concluida", gravadas: 3, existentes: 1 });
    expect(db.messages.filter((m) => m.external_id === `false_${TEL}_A1`)).toHaveLength(1);
    expect(db.messages.map((m) => m.external_id)).toEqual(expect.arrayContaining(["A2", `false_${LID}_B1`, "B2"]));
  });

  it("linha a linha depois do 23505: erro no meio não perde do contador as linhas já gravadas", async () => {
    const db = bancoDeMentira();
    novaImportacao(db);
    db.forcarInsert((l) =>
      Array.isArray(l) ? { code: "23505", message: "duplicate key" }
      : l.external_id === "A2" ? { code: "XX000", message: "caiu" }
      : null,
    );
    const r = await rodarUmaRodada(db.admin as never, IMP, SEM_TETO);
    expect(r.status).toBe("erro");
    expect(db.messages.map((m) => m.external_id)).toEqual([`false_${TEL}_A1`]);
    expect(db.importacoes.get(IMP)).toMatchObject({ mensagens_gravadas: 1 });
  });

  it("Foco 3: conversa aberta já existente recebe as antigas sem mudar estado, dono, carimbo nem não lidas", async () => {
    const db = bancoDeMentira();
    novaImportacao(db);
    // o contato do TEL vai nascer como ct-1 (primeira conversa da lista)
    const antes = {
      id: "cv-aberta",
      organization_id: ORG,
      contact_id: "ct-1",
      channel_session_id: SESSAO,
      status: "open",
      assigned_to_user_id: "u-1",
      last_message_at: "2026-10-19T12:00:00.000Z",
      last_message_preview: "mensagem de ontem",
      last_message_direction: "inbound",
      unread_count_for_assignee: 3,
    };
    db.conversations.set("cv-aberta", { ...antes });
    await rodarUmaRodada(db.admin as never, IMP, SEM_TETO);
    expect(db.conversations.get("cv-aberta")).toEqual(antes);
    const daAberta = db.messages.filter((m) => m.conversation_id === "cv-aberta").map((m) => m.external_id);
    expect(daAberta.sort()).toEqual([`false_${TEL}_A1`, "A2"].sort());
    expect(db.tabelasTocadas).not.toContain("conversations");
  });

  it("erro do canal: status erro, mensagem gravada e cursor preservado", async () => {
    const db = bancoDeMentira();
    const cursor = { indiceConversa: 2, offsetMensagens: 0, desde: agora - 30 * DIA };
    novaImportacao(db, { cursor, mensagens_gravadas: 2 });
    canal.falha = "waha_messages_500";
    const r = await rodarUmaRodada(db.admin as never, IMP, SEM_TETO);
    expect(r).toEqual({ status: "erro", gravadas: 0, existentes: 0 });
    const imp = db.importacoes.get(IMP)!;
    expect(imp.status).toBe("erro");
    expect(imp.erro).toContain("waha_messages_500");
    expect(imp.cursor).toEqual({ ...cursor, conferida: false });
    expect(imp.mensagens_gravadas).toBe(2);
  });

  it("importação que não está rodando não roda", async () => {
    const db = bancoDeMentira();
    novaImportacao(db, { status: "cancelada" });
    await expect(rodarUmaRodada(db.admin as never, IMP, SEM_TETO)).rejects.toThrow("importacao_nao_esta_rodando");
    expect(canal.chamadas).toEqual([]);
  });

  it("nada dispara: sem dispatch, sem pós-entrada, sem carimbo da conversa, sem emit_event", async () => {
    const db = bancoDeMentira();
    novaImportacao(db);
    await rodarUmaRodada(db.admin as never, IMP, SEM_TETO);
    expect(espioes.dispatch).not.toHaveBeenCalled();
    expect(espioes.posEntrada).not.toHaveBeenCalled();
    expect(espioes.marcar).not.toHaveBeenCalled();
    expect(auditEspiao).not.toHaveBeenCalled();
    const fns = new Set(db.rpcs.map((x) => x.fn));
    expect([...fns].sort()).toEqual([
      "fn_titular_apagado_a_pedido",
      "fn_upsert_wa_contact",
      "fn_upsert_wa_conversation_importada",
    ]);
    expect(new Set(db.tabelasTocadas)).toEqual(new Set(["importacoes_de_historico", "channel_sessions", "messages"]));
  });

  it("LGPD (doc 186, B): quem foi apagado a pedido não volta — nem contato, nem conversa, nem mensagem", async () => {
    const db = bancoDeMentira();
    db.apagados.add("+5511900000001");
    novaImportacao(db);
    const r = await rodarUmaRodada(db.admin as never, IMP, SEM_TETO);

    expect(r.status).toBe("concluida");
    // a pergunta vem ANTES do upsert, com o telefone canônico
    const perguntas = db.rpcs.filter((x) => x.fn === "fn_titular_apagado_a_pedido").map((x) => x.args);
    expect(perguntas).toContainEqual({ p_org: ORG, p_telefone: "+5511900000001", p_lid: null });
    const contatos = db.rpcs.filter((x) => x.fn === "fn_upsert_wa_contact").map((x) => x.args.p_chat_id);
    expect(contatos).not.toContain(TEL);
    expect(contatos).toContain(LID);
    expect(db.messages.map((m) => m.external_id).sort()).toEqual([`false_${LID}_B1`, "B2"].sort());
    expect([...db.conversations.values()]).toHaveLength(1);
    // as 2 válidas do chat apagado contam como ignoradas, junto da reação e da sem id
    expect(db.importacoes.get(IMP)).toMatchObject({ mensagens_gravadas: 2, mensagens_ignoradas: 4 });
  });

  it("LGPD: a marca também vale pelo lid do chat", async () => {
    const db = bancoDeMentira();
    db.apagados.add("111111111111111");
    novaImportacao(db);
    await rodarUmaRodada(db.admin as never, IMP, SEM_TETO);
    expect(db.rpcs.filter((x) => x.fn === "fn_upsert_wa_contact").map((x) => x.args.p_chat_id)).toEqual([TEL]);
    expect(db.messages.every((m) => !String(m.external_id).includes("B"))).toBe(true);
  });

  it("LGPD: conversa com dois telefones, só o segundo marcado, não entra", async () => {
    (canal.mensagens[LID] ??= []).push({
      id: `false_${LID}_B3`,
      from: LID,
      fromMe: false,
      body: "sou eu de novo",
      timestamp: agora - 3 * DIA,
      _data: { key: { remoteJidAlt: "5511900000003@s.whatsapp.net" } },
    });
    const db = bancoDeMentira();
    db.apagados.add("+5511900000003");
    novaImportacao(db);
    await rodarUmaRodada(db.admin as never, IMP, SEM_TETO);
    const perguntas = db.rpcs.filter((x) => x.fn === "fn_titular_apagado_a_pedido").map((x) => x.args.p_telefone);
    expect(perguntas).toEqual(expect.arrayContaining(["+5511900000002", "+5511900000003"]));
    expect(db.rpcs.filter((x) => x.fn === "fn_upsert_wa_contact").map((x) => x.args.p_chat_id)).toEqual([TEL]);
    expect(db.messages.some((m) => String(m.external_id).includes("B"))).toBe(false);
  });

  it("LGPD: identidade marcada que só aparece na 3ª página: nada da conversa fica no banco", async () => {
    canal.maxPorPagina = 1;
    (canal.mensagens[LID] ??= []).push(
      {
        id: `false_${LID}_B3`,
        from: LID,
        fromMe: false,
        body: "sou eu de novo",
        timestamp: agora - 3 * DIA,
        _data: { key: { remoteJidAlt: "5511900000003@s.whatsapp.net" } },
      },
      { id: `true_${LID}_B4`, from: "5511999999999@c.us", to: LID, fromMe: true, body: "ok", timestamp: agora - 2 * DIA },
    );
    const db = bancoDeMentira();
    db.apagados.add("+5511900000003");
    novaImportacao(db);
    const r = await rodarUmaRodada(db.admin as never, IMP, SEM_TETO);
    expect(r.status).toBe("concluida");
    // B1 e B2 vêm antes da página da identidade marcada, e nem elas entram:
    // a conversa é conferida inteira antes da primeira gravação.
    expect(db.messages.some((m) => String(m.external_id).includes("B"))).toBe(false);
    expect(db.rpcs.filter((x) => x.fn === "fn_upsert_wa_contact").map((x) => x.args.p_chat_id)).toEqual([TEL]);
    expect([...db.conversations.values()]).toHaveLength(1);
    // a conferência para na 3ª página; a passada de gravação nem começa
    expect(canal.chamadas.filter((c) => c.startsWith(`msgs:nome-no-canal:${LID}:`))).toHaveLength(3);
    // as 3 lidas da conversa contam como ignoradas (mais a reação e a sem id do TEL)
    expect(db.importacoes.get(IMP)).toMatchObject({ mensagens_ignoradas: 5 });
  });

  it("LGPD: a conferência atravessa rodadas: marca na 3ª página, rodadas de 1 mensagem, nada entra", async () => {
    canal.chats = [{ id: LID, ultimaEm: agora - DIA }];
    (canal.mensagens[LID] ??= []).push({
      id: `false_${LID}_B3`,
      from: LID,
      fromMe: false,
      body: "sou eu de novo",
      timestamp: agora - 3 * DIA,
      _data: { key: { remoteJidAlt: "5511900000003@s.whatsapp.net" } },
    });
    const db = bancoDeMentira();
    db.apagados.add("+5511900000003");
    novaImportacao(db);
    let r = await rodarUmaRodada(db.admin as never, IMP, { conversas: 10, mensagens: 1 });
    expect(db.importacoes.get(IMP)!.cursor).toMatchObject({ indiceConversa: 0, offsetMensagens: 1, conferida: false });
    for (let i = 0; i < 10 && r.status === "rodando"; i++) {
      r = await rodarUmaRodada(db.admin as never, IMP, { conversas: 10, mensagens: 1 });
    }
    expect(r.status).toBe("concluida");
    expect(db.messages).toHaveLength(0);
    expect(db.rpcs.some((x) => x.fn === "fn_upsert_wa_contact")).toBe(false);
  });

  it("LGPD: falha de transporte ao resolver o telefone do lid para a rodada sem gravar (falha fechada)", async () => {
    canal.chats = [{ id: LID, ultimaEm: agora - DIA }];
    canal.falhaNoLid = "fetch failed";
    const db = bancoDeMentira();
    novaImportacao(db);
    const r = await rodarUmaRodada(db.admin as never, IMP, SEM_TETO);
    expect(r.status).toBe("erro");
    expect(String(db.importacoes.get(IMP)?.erro)).toContain("fetch failed");
    expect(db.messages).toHaveLength(0);
    expect(db.rpcs.some((x) => x.fn === "fn_upsert_wa_contact")).toBe(false);
  });

  it("LGPD: chat @lid sem telefone no acervo é conferido pelo telefone que o canal resolve", async () => {
    canal.mensagens[LID] = [
      { id: `false_${LID}_B1`, from: LID, fromMe: false, body: "bom dia", timestamp: agora - 5 * DIA },
    ];
    canal.telefoneDoLid["111111111111111"] = "+5511900000009";
    const db = bancoDeMentira();
    db.apagados.add("+5511900000009");
    novaImportacao(db);
    await rodarUmaRodada(db.admin as never, IMP, SEM_TETO);
    expect(db.rpcs.filter((x) => x.fn === "fn_upsert_wa_contact").map((x) => x.args.p_chat_id)).toEqual([TEL]);
    expect(db.messages.some((m) => String(m.external_id).includes("B"))).toBe(false);
  });

  it("LGPD: erro na pergunta da marca para a rodada sem criar contato (falha fechada)", async () => {
    const db = bancoDeMentira();
    db.falharNaMarca("permission denied");
    novaImportacao(db);
    const r = await rodarUmaRodada(db.admin as never, IMP, SEM_TETO);
    expect(r.status).toBe("erro");
    expect(db.rpcs.some((x) => x.fn === "fn_upsert_wa_contact")).toBe(false);
    expect(db.messages).toHaveLength(0);
    expect(String(db.importacoes.get(IMP)?.erro)).toContain("fn_titular_apagado_a_pedido");
  });

  it("canal que devolve MENOS que o pedido, com mais itens depois: nenhuma mensagem pulada", async () => {
    canal.maxPorPagina = 1;
    const db = bancoDeMentira();
    novaImportacao(db);
    const r = await rodarUmaRodada(db.admin as never, IMP, SEM_TETO);
    expect(r.status).toBe("concluida");
    expect(db.messages.map((m) => m.external_id).sort()).toEqual(
      [`false_${TEL}_A1`, "A2", `false_${LID}_B1`, "B2"].sort(),
    );
  });

  it("página inteira recusada pelo schema não termina a conversa", async () => {
    canal.maxPorPagina = 2;
    canal.mensagens[TEL] = [
      { id: `false_${TEL}_X1`, invalido: true, timestamp: agora - 9 * DIA },
      { id: `false_${TEL}_X2`, invalido: true, timestamp: agora - 8 * DIA },
      { id: `false_${TEL}_A1`, from: TEL, fromMe: false, body: "oi", timestamp: agora - 3 * DIA },
    ];
    const db = bancoDeMentira();
    novaImportacao(db);
    await rodarUmaRodada(db.admin as never, IMP, SEM_TETO);
    expect(db.messages.map((m) => m.external_id)).toContain(`false_${TEL}_A1`);
  });

  it("200 conversas antigas: a rodada respeita o teto de chamadas e o cursor avança", async () => {
    canal.chats = Array.from({ length: 200 }, (_, i) => ({
      id: `55119${String(i).padStart(8, "0")}@s.whatsapp.net`,
      ultimaEm: agora - 100 * DIA,
    }));
    const db = bancoDeMentira();
    novaImportacao(db);
    const r = await rodarUmaRodada(db.admin as never, IMP, { conversas: 3, mensagens: 300, chamadas: 2 });
    expect(canal.chamadas.length).toBeLessThanOrEqual(2);
    expect(canal.chamadas.every((c) => c.startsWith("chats:"))).toBe(true);
    expect(r.status).toBe("rodando");
    expect((db.importacoes.get(IMP)!.cursor as { indiceConversa: number }).indiceConversa).toBe(100);
    // e o padrão traz teto de chamadas: a lista inteira termina em poucas rodadas, sem conversa contada
    let ultima = r;
    for (let i = 0; i < 10 && ultima.status === "rodando"; i++) {
      ultima = await rodarUmaRodada(db.admin as never, IMP, { conversas: 3, mensagens: 300, chamadas: 2 });
    }
    expect(ultima.status).toBe("concluida");
    expect(db.messages).toHaveLength(0);
  });

  it("teto padrão de chamadas é 20", async () => {
    canal.maxPorPagina = 1;
    const db = bancoDeMentira();
    novaImportacao(db);
    await rodarUmaRodada(db.admin as never, IMP, { conversas: 100, mensagens: 10_000 });
    expect(canal.chamadas.length).toBeLessThanOrEqual(20);
    canal.chamadas = [];
    canal.mensagens[TEL] = Array.from({ length: 40 }, (_, i) => ({
      id: `false_${TEL}_M${i}`, from: TEL, body: "x", timestamp: agora - 2 * DIA + i,
    }));
    const db2 = bancoDeMentira();
    novaImportacao(db2);
    const r = await rodarUmaRodada(db2.admin as never, IMP);
    expect(canal.chamadas).toHaveLength(20);
    expect(r.status).toBe("rodando");
  });

  it("cancelamento durante a rodada não é sobrescrito", async () => {
    const db = bancoDeMentira();
    novaImportacao(db);
    canal.aoLerMensagens = () => {
      const l = db.importacoes.get(IMP)!;
      db.importacoes.set(IMP, { ...l, status: "cancelada" });
    };
    const r = await rodarUmaRodada(db.admin as never, IMP, SEM_TETO);
    expect(r.status).toBe("cancelada");
    const imp = db.importacoes.get(IMP)!;
    expect(imp.status).toBe("cancelada");
    expect(imp.cursor).toEqual({});
    expect(imp.mensagens_gravadas).toBe(0);
  });
});
