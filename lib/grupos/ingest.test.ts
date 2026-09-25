import { describe, expect, it, vi } from "vitest";

import { criarIngestDeGrupoDb, gravarMensagemDeGrupo, type EntradaDeGrupo, type IngestDeGrupoDb } from "./ingest";

const ORG = "11111111-1111-4111-8111-111111111111";
const SESS = "22222222-2222-4222-8222-222222222222";
const entrada = (o: Partial<EntradaDeGrupo> = {}): EntradaDeGrupo => ({
  organizationId: ORG, channelSessionId: SESS, groupChatId: "1@g.us", direction: "inbound",
  externalId: "ext-1", type: "text", body: "oi", mediaUrl: null, mediaMime: null,
  sentAt: "2026-09-23T12:00:00.000Z", remetente: { name: "Maria", phone: "+5521999990000", lid: null }, rawType: "chat", ...o,
});
function db(grupo: Awaited<ReturnType<IngestDeGrupoDb["grupoLigado"]>>, dup = false) {
  return {
    grupoLigado: vi.fn<IngestDeGrupoDb["grupoLigado"]>(async () => grupo),
    criarContatoDoGrupo: vi.fn<IngestDeGrupoDb["criarContatoDoGrupo"]>(async () => "contato-g"),
    criarConversaDoGrupo: vi.fn<IngestDeGrupoDb["criarConversaDoGrupo"]>(async () => "conversa-g"),
    vincular: vi.fn<IngestDeGrupoDb["vincular"]>(async () => {}),
    inserirMensagem: vi.fn<IngestDeGrupoDb["inserirMensagem"]>(async () => (dup ? "duplicada" : "ok")),
    marcarConversa: vi.fn<IngestDeGrupoDb["marcarConversa"]>(async () => {}),
    reabrirSeFechada: vi.fn<IngestDeGrupoDb["reabrirSeFechada"]>(async () => {}),
  } satisfies IngestDeGrupoDb;
}

describe("gravarMensagemDeGrupo", () => {
  it("grupo desligado: descarta sem gravar nada", async () => {
    const d = db(null);
    await expect(gravarMensagemDeGrupo(d, entrada())).resolves.toBe("grupo_desligado");
    expect(d.inserirMensagem).not.toHaveBeenCalled();
    expect(d.criarContatoDoGrupo).not.toHaveBeenCalled();
  });
  it("primeira mensagem de um grupo ligado cria contato e conversa do grupo e grava com o remetente", async () => {
    const d = db({ id: "g1", subject: "Cliente A", contactId: null, conversationId: null });
    await expect(gravarMensagemDeGrupo(d, entrada())).resolves.toBe("gravada");
    expect(d.criarContatoDoGrupo).toHaveBeenCalledWith(ORG, "1@g.us", "Cliente A");
    expect(d.criarConversaDoGrupo).toHaveBeenCalledWith(ORG, SESS, "contato-g", "1@g.us");
    expect(d.vincular).toHaveBeenCalledWith(ORG, "g1", "contato-g", "conversa-g");
    const row = d.inserirMensagem.mock.calls[0]![0];
    expect(row).toMatchObject({
      organization_id: ORG, conversation_id: "conversa-g", contact_id: "contato-g", direction: "inbound", external_id: "ext-1",
      metadata: { raw_type: "chat", group_sender: { name: "Maria", phone: "+5521999990000", lid: null } },
    });
  });
  it("grupo já vinculado reaproveita contato e conversa", async () => {
    const d = db({ id: "g1", subject: "A", contactId: "c", conversationId: "v" });
    await gravarMensagemDeGrupo(d, entrada());
    expect(d.criarContatoDoGrupo).not.toHaveBeenCalled();
    expect(d.inserirMensagem.mock.calls[0]![0]).toMatchObject({ conversation_id: "v", contact_id: "c" });
  });
  it("mensagem repetida (mesmo external_id) não duplica", async () => {
    const d = db({ id: "g1", subject: "A", contactId: "c", conversationId: "v" }, true);
    await expect(gravarMensagemDeGrupo(d, entrada())).resolves.toBe("duplicada");
    expect(d.marcarConversa).not.toHaveBeenCalled();
  });
  it("mensagem enviada do celular entra como outbound, sem remetente", async () => {
    const d = db({ id: "g1", subject: "A", contactId: "c", conversationId: "v" });
    await gravarMensagemDeGrupo(d, entrada({ direction: "outbound", remetente: null }));
    expect(d.inserirMensagem.mock.calls[0]![0]).toMatchObject({ direction: "outbound", sent_via: "external_device" });
    expect((d.inserirMensagem.mock.calls[0]![0]!.metadata as Record<string, unknown>).group_sender).toBeUndefined();
  });
  it("mensagem sem texto e sem mídia é ignorada", async () => {
    const d = db({ id: "g1", subject: "A", contactId: "c", conversationId: "v" });
    await expect(gravarMensagemDeGrupo(d, entrada({ body: null }))).resolves.toBe("vazia");
  });

  it("carimba a conversa com o sentido da mensagem e prévia de mídia quando não há texto", async () => {
    const d = db({ id: "g1", subject: "A", contactId: "c", conversationId: "v" });
    await gravarMensagemDeGrupo(d, entrada({ body: null, type: "image", mediaUrl: "https://x/y.jpg" }));
    expect(d.marcarConversa).toHaveBeenCalledWith(ORG, "v", "[image]", "2026-09-23T12:00:00.000Z", "inbound");
  });

  it("mídia anunciada sem URL entra, como na conversa individual", async () => {
    const d = db({ id: "g1", subject: "A", contactId: "c", conversationId: "v" });
    await expect(
      gravarMensagemDeGrupo(d, entrada({ body: null, type: "image", mediaUrl: null, temMidia: true })),
    ).resolves.toBe("gravada");
  });

  it("I2: mensagem RECEBIDA reabre a conversa do grupo se ela estiver fechada, antes de carimbar", async () => {
    const d = db({ id: "g1", subject: "A", contactId: "c", conversationId: "v" });
    await gravarMensagemDeGrupo(d, entrada());
    expect(d.reabrirSeFechada).toHaveBeenCalledWith(ORG, "v");
    expect(d.reabrirSeFechada.mock.invocationCallOrder[0]).toBeLessThan(d.marcarConversa.mock.invocationCallOrder[0]!);
  });

  it("I2: mensagem enviada do celular e mensagem repetida NÃO reabrem", async () => {
    const eco = db({ id: "g1", subject: "A", contactId: "c", conversationId: "v" });
    await gravarMensagemDeGrupo(eco, entrada({ direction: "outbound", remetente: null }));
    expect(eco.reabrirSeFechada).not.toHaveBeenCalled();
    const dup = db({ id: "g1", subject: "A", contactId: "c", conversationId: "v" }, true);
    await gravarMensagemDeGrupo(dup, entrada());
    expect(dup.reabrirSeFechada).not.toHaveBeenCalled();
  });

  it("remetente fora do formato não derruba a mensagem: grava sem group_sender", async () => {
    const d = db({ id: "g1", subject: "A", contactId: "c", conversationId: "v" });
    await expect(
      gravarMensagemDeGrupo(d, entrada({ remetente: { name: "M", phone: "lixo", lid: null } })),
    ).resolves.toBe("gravada");
    expect((d.inserirMensagem.mock.calls[0]![0]!.metadata as Record<string, unknown>).group_sender).toBeUndefined();
  });
});

/**
 * Banco de mentira para `criarIngestDeGrupoDb`: registra cada comando com os
 * filtros que ele citou, e deixa o teste decidir o que o INSERT devolve.
 */
function adminDeMentira(cfg: {
  insercao?: Record<string, { data: unknown; error: unknown }>;
  leitura?: Record<string, { data: unknown; error: unknown }>;
}) {
  const comandos: Array<{ tabela: string; op: string; linha?: unknown; filtros: Array<[string, unknown]> }> = [];
  const rpcs: Array<{ fn: string; args: Record<string, unknown> }> = [];
  const from = (tabela: string) => {
    const cmd = { tabela, op: "select", linha: undefined as unknown, filtros: [] as Array<[string, unknown]> };
    comandos.push(cmd);
    const fim = async () =>
      cmd.op === "insert"
        ? (cfg.insercao?.[tabela] ?? { data: { id: `${tabela}-novo` }, error: null })
        : (cfg.leitura?.[tabela] ?? { data: null, error: null });
    const q = {
      select: () => q,
      insert: (linha: unknown) => { cmd.op = "insert"; cmd.linha = linha; return q; },
      update: (linha: unknown) => { cmd.op = "update"; cmd.linha = linha; return q; },
      eq: (c: string, v: unknown) => { cmd.filtros.push([c, v]); return q; },
      in: (c: string, v: unknown) => { cmd.filtros.push([c, v]); return q; },
      single: fim,
      maybeSingle: fim,
      then: (ok: (v: unknown) => unknown) => fim().then(ok),
    };
    return q;
  };
  const admin = {
    from,
    rpc: async (fn: string, args: Record<string, unknown>) => { rpcs.push({ fn, args }); return { data: null, error: null }; },
  };
  return { admin, comandos, rpcs };
}

const DUP = { data: null, error: { code: "23505", message: "duplicate key" } };

describe("criarIngestDeGrupoDb — dois webhooks do mesmo grupo novo terminam num contato só", () => {
  it("contato: 23505 no INSERT relê o contato do grupo que o outro webhook criou", async () => {
    const { admin, comandos } = adminDeMentira({
      insercao: { contacts: DUP },
      leitura: { contacts: { data: { id: "contato-do-outro" }, error: null } },
    });
    const id = await criarIngestDeGrupoDb(admin as never).criarContatoDoGrupo(ORG, "1@g.us", "Grupo A");
    expect(id).toBe("contato-do-outro");
    const releitura = comandos.find((c) => c.tabela === "contacts" && c.op === "select")!;
    expect(releitura.filtros).toEqual(
      expect.arrayContaining([
        ["organization_id", ORG],
        ["kind", "whatsapp_group"],
        ["source_metadata->>group_chat_id", "1@g.us"],
      ]),
    );
  });

  it("contato: erro que não é 23505 sobe, e 23505 sem linha para reler também", async () => {
    const outro = adminDeMentira({ insercao: { contacts: { data: null, error: { code: "42501", message: "x" } } } });
    await expect(criarIngestDeGrupoDb(outro.admin as never).criarContatoDoGrupo(ORG, "1@g.us", null)).rejects.toBeTruthy();
    const vazio = adminDeMentira({ insercao: { contacts: DUP } });
    await expect(criarIngestDeGrupoDb(vazio.admin as never).criarContatoDoGrupo(ORG, "1@g.us", null)).rejects.toBeTruthy();
  });

  it("contato novo nasce como grupo, sem telefone, com o nome do grupo", async () => {
    const { admin, comandos } = adminDeMentira({});
    await criarIngestDeGrupoDb(admin as never).criarContatoDoGrupo(ORG, "1@g.us", null);
    expect(comandos[0]!.linha).toMatchObject({
      organization_id: ORG, kind: "whatsapp_group", source_metadata: { group_chat_id: "1@g.us" },
    });
    expect((comandos[0]!.linha as Record<string, unknown>).phone_number).toBeUndefined();
  });

  it("conversa: 23505 no INSERT relê a conversa do grupo pelo mesmo quarteto do unique", async () => {
    const { admin, comandos } = adminDeMentira({
      insercao: { conversations: DUP },
      leitura: { conversations: { data: { id: "conversa-do-outro" }, error: null } },
    });
    const id = await criarIngestDeGrupoDb(admin as never).criarConversaDoGrupo(ORG, SESS, "c1", "1@g.us");
    expect(id).toBe("conversa-do-outro");
    const releitura = comandos.find((c) => c.tabela === "conversations" && c.op === "select")!;
    expect(releitura.filtros).toEqual(
      expect.arrayContaining([
        ["organization_id", ORG],
        ["contact_id", "c1"],
        ["channel_session_id", SESS],
        ["group_chat_id", "1@g.us"],
      ]),
    );
  });

  it("grupoLigado só enxerga grupo LIGADO da organização e do número", async () => {
    const { admin, comandos } = adminDeMentira({});
    await expect(criarIngestDeGrupoDb(admin as never).grupoLigado(ORG, SESS, "1@g.us")).resolves.toBeNull();
    expect(comandos[0]!.filtros).toEqual(
      expect.arrayContaining([
        ["organization_id", ORG],
        ["channel_session_id", SESS],
        ["group_chat_id", "1@g.us"],
        ["enabled", true],
      ]),
    );
  });

  it("mensagem com mídia pede a persistência, pelo mesmo evento da conversa individual", async () => {
    const { admin, rpcs } = adminDeMentira({ insercao: { messages: { data: { id: "m1" }, error: null } } });
    const r = await criarIngestDeGrupoDb(admin as never).inserirMensagem({
      organization_id: ORG, conversation_id: "v", media_url: "https://x/y.jpg",
    });
    expect(r).toBe("ok");
    expect(rpcs.find((c) => c.fn === "emit_event")?.args).toMatchObject({
      p_event_type: "media.persist_requested", p_entity_id: "m1", p_organization_id: ORG,
    });
  });

  it("mensagem duplicada não pede persistência de mídia de novo", async () => {
    const { admin, rpcs } = adminDeMentira({ insercao: { messages: DUP } });
    const r = await criarIngestDeGrupoDb(admin as never).inserirMensagem({
      organization_id: ORG, conversation_id: "v", media_url: "https://x/y.jpg",
    });
    expect(r).toBe("duplicada");
    expect(rpcs).toHaveLength(0);
  });

  it("I2: reabrir só alcança conversa DE GRUPO, fechada, da própria organização", async () => {
    const { admin, comandos } = adminDeMentira({});
    await criarIngestDeGrupoDb(admin as never).reabrirSeFechada(ORG, "v");
    expect(comandos).toHaveLength(1);
    expect(comandos[0]).toMatchObject({ tabela: "conversations", op: "update", linha: expect.objectContaining({ status: "open" }) });
    expect(comandos[0]!.filtros).toEqual(
      expect.arrayContaining([
        ["organization_id", ORG],
        ["id", "v"],
        ["is_group", true],
        ["status", ["closed", "resolved", "archived"]],
      ]),
    );
  });

  it("carimbo da conversa passa pela função compartilhada (fn_mark_conversation_message)", async () => {
    const { admin, rpcs } = adminDeMentira({});
    await criarIngestDeGrupoDb(admin as never).marcarConversa(ORG, "v", "oi", "2026-09-23T12:00:00.000Z", "outbound");
    expect(rpcs[0]).toMatchObject({
      fn: "fn_mark_conversation_message",
      args: { p_conv: "v", p_direction: "outbound", p_preview: "oi", p_at: "2026-09-23T12:00:00.000Z" },
    });
  });
});
