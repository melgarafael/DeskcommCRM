import { describe, expect, it, vi } from "vitest";

import { logger } from "@/lib/logger";

import { criarIngestDeGrupoDb, gravarMensagemDeGrupo, type EntradaDeGrupo, type IngestDeGrupoDb } from "./ingest";

const ORG = "11111111-1111-4111-8111-111111111111";
const SESS = "22222222-2222-4222-8222-222222222222";
const entrada = (o: Partial<EntradaDeGrupo> = {}): EntradaDeGrupo => ({
  organizationId: ORG, channelSessionId: SESS, groupChatId: "1@g.us", direction: "inbound",
  externalId: "ext-1", type: "text", body: "oi", mediaUrl: null, mediaMime: null,
  sentAt: "2026-09-23T12:00:00.000Z", remetente: { name: "Maria", phone: "+5521999990000", lid: null }, rawType: "chat", ...o,
});
function db(
  grupo: Awaited<ReturnType<IngestDeGrupoDb["grupoLigado"]>>,
  dup = false,
  messageId = "m1",
) {
  return {
    grupoLigado: vi.fn<IngestDeGrupoDb["grupoLigado"]>(async () => grupo),
    criarContatoDoGrupo: vi.fn<IngestDeGrupoDb["criarContatoDoGrupo"]>(async () => "contato-g"),
    criarConversaDoGrupo: vi.fn<IngestDeGrupoDb["criarConversaDoGrupo"]>(async () => "conversa-g"),
    vincular: vi.fn<IngestDeGrupoDb["vincular"]>(async () => {}),
    inserirMensagem: vi.fn<IngestDeGrupoDb["inserirMensagem"]>(async () =>
      dup ? { status: "duplicada", messageId: null } : { status: "ok", messageId },
    ),
    marcarConversa: vi.fn<IngestDeGrupoDb["marcarConversa"]>(async () => {}),
    reabrirSeFechada: vi.fn<IngestDeGrupoDb["reabrirSeFechada"]>(async () => {}),
    pedirDespachoDeIa: vi.fn<IngestDeGrupoDb["pedirDespachoDeIa"]>(async () => {}),
    // #3566 — o dublê resolve o rótulo como o de verdade faria: devolve a
    // menção com o nome que o "contato" tem, e sem nome quando não tem.
    rotulosDasMencoes: vi.fn<IngestDeGrupoDb["rotulosDasMencoes"]>(async (_org, mencoes) =>
      mencoes.map((m) =>
        m.lid === "75235009282237" ? { ...m, name: "Maria Exemplo" } : m,
      ),
    ),
  } satisfies IngestDeGrupoDb;
}
const ligado = (extra: Partial<NonNullable<Awaited<ReturnType<IngestDeGrupoDb["grupoLigado"]>>>> = {}) => ({
  id: "g1",
  subject: "A",
  contactId: "c",
  conversationId: "v",
  iaResponde: false,
  ...extra,
});

describe("gravarMensagemDeGrupo", () => {
  it("grupo desligado: descarta sem gravar nada", async () => {
    const d = db(null);
    await expect(gravarMensagemDeGrupo(d, entrada())).resolves.toBe("grupo_desligado");
    expect(d.inserirMensagem).not.toHaveBeenCalled();
    expect(d.criarContatoDoGrupo).not.toHaveBeenCalled();
  });
  it("primeira mensagem de um grupo ligado cria contato e conversa do grupo e grava com o remetente", async () => {
    const d = db(ligado({ subject: "Cliente A", contactId: null, conversationId: null }));
    await expect(gravarMensagemDeGrupo(d, entrada())).resolves.toBe("gravada");
    expect(d.criarContatoDoGrupo).toHaveBeenCalledWith(ORG, "1@g.us", "Cliente A");
    // #2729 — a conversa nasce com o episódio datado na mensagem que a criou.
    expect(d.criarConversaDoGrupo).toHaveBeenCalledWith(
      ORG,
      SESS,
      "contato-g",
      "1@g.us",
      "2026-09-23T12:00:00.000Z",
    );
    expect(d.vincular).toHaveBeenCalledWith(ORG, "g1", "contato-g", "conversa-g");
    const row = d.inserirMensagem.mock.calls[0]![0];
    expect(row).toMatchObject({
      organization_id: ORG, conversation_id: "conversa-g", contact_id: "contato-g", direction: "inbound", external_id: "ext-1",
      metadata: { raw_type: "chat", group_sender: { name: "Maria", phone: "+5521999990000", lid: null } },
    });
  });
  it("grupo já vinculado reaproveita contato e conversa", async () => {
    const d = db(ligado());
    await gravarMensagemDeGrupo(d, entrada());
    expect(d.criarContatoDoGrupo).not.toHaveBeenCalled();
    expect(d.inserirMensagem.mock.calls[0]![0]).toMatchObject({ conversation_id: "v", contact_id: "c" });
  });
  it("mensagem repetida (mesmo external_id) não duplica", async () => {
    const d = db(ligado(), true);
    await expect(gravarMensagemDeGrupo(d, entrada())).resolves.toBe("duplicada");
    expect(d.marcarConversa).not.toHaveBeenCalled();
  });
  it("mensagem enviada do celular entra como outbound, sem remetente", async () => {
    const d = db(ligado());
    await gravarMensagemDeGrupo(d, entrada({ direction: "outbound", remetente: null }));
    expect(d.inserirMensagem.mock.calls[0]![0]).toMatchObject({ direction: "outbound", sent_via: "external_device" });
    expect((d.inserirMensagem.mock.calls[0]![0]!.metadata as Record<string, unknown>).group_sender).toBeUndefined();
  });
  // ── #3566 — as menções ─────────────────────────────────────────────────────
  it("menção: o metadata guarda a lista resolvida e o CORPO continua cru", async () => {
    const d = db(ligado());
    await gravarMensagemDeGrupo(
      d,
      entrada({ body: "oi @75235009282237", mencoes: [{ lid: "75235009282237", phone: null, name: null }] }),
    );
    const row = d.inserirMensagem.mock.calls[0]![0]!;
    expect(row.body).toBe("oi @75235009282237");
    expect((row.metadata as Record<string, unknown>).mentions).toEqual([
      { lid: "75235009282237", phone: null, name: "Maria Exemplo" },
    ]);
  });

  it("menção a desconhecido é guardada sem nome, e o texto dela não muda", async () => {
    const d = db(ligado());
    await gravarMensagemDeGrupo(
      d,
      entrada({ body: "oi @99887766554433", mencoes: [{ lid: "99887766554433", phone: null, name: null }] }),
    );
    expect((d.inserirMensagem.mock.calls[0]![0]!.metadata as Record<string, unknown>).mentions).toEqual([
      { lid: "99887766554433", phone: null, name: null },
    ]);
  });

  it("CONTROLE: mensagem SEM menção grava o metadata igual ao de antes, e nem consulta contato", async () => {
    const d = db(ligado());
    await gravarMensagemDeGrupo(d, entrada({ body: "bom dia, grupo" }));
    expect(d.rotulosDasMencoes).not.toHaveBeenCalled();
    // Igualdade EXATA: nenhuma chave nova entra na mensagem sem menção.
    expect(d.inserirMensagem.mock.calls[0]![0]!.metadata).toEqual({
      raw_type: "chat",
      group_sender: { name: "Maria", phone: "+5521999990000", lid: null },
    });
  });

  it("mensagem sem texto e sem mídia é ignorada", async () => {
    const d = db(ligado());
    await expect(gravarMensagemDeGrupo(d, entrada({ body: null }))).resolves.toBe("vazia");
  });

  it("carimba a conversa com o sentido da mensagem e prévia de mídia quando não há texto", async () => {
    const d = db(ligado());
    await gravarMensagemDeGrupo(d, entrada({ body: null, type: "image", mediaUrl: "https://x/y.jpg" }));
    expect(d.marcarConversa).toHaveBeenCalledWith(ORG, "v", "Imagem", "2026-09-23T12:00:00.000Z", "inbound");
  });

  it("vCard no grupo: a prévia é o nome do cartão, igual à conversa individual (#2742)", async () => {
    const d = db(ligado());
    const cartao = "BEGIN:VCARD\nVERSION:3.0\nFN:Maria Silva\nEND:VCARD";
    await gravarMensagemDeGrupo(d, entrada({ type: "contact", body: cartao, rawType: "vcard" }));
    expect(d.marcarConversa).toHaveBeenCalledWith(
      ORG,
      "v",
      "Contato: Maria Silva",
      "2026-09-23T12:00:00.000Z",
      "inbound",
    );
  });

  it("mídia anunciada sem URL entra, como na conversa individual", async () => {
    const d = db(ligado());
    await expect(
      gravarMensagemDeGrupo(d, entrada({ body: null, type: "image", mediaUrl: null, temMidia: true })),
    ).resolves.toBe("gravada");
  });

  it("I2: mensagem RECEBIDA reabre a conversa do grupo se ela estiver fechada, antes de carimbar", async () => {
    const d = db(ligado());
    await gravarMensagemDeGrupo(d, entrada());
    // #2729 — a mensagem que reabriu vai junto: ela recebe a revisão NOVA do
    // episódio e o episódio começa no instante dela (como na 1:1).
    expect(d.reabrirSeFechada).toHaveBeenCalledWith(ORG, "v", "m1", "2026-09-23T12:00:00.000Z");
    expect(d.reabrirSeFechada.mock.invocationCallOrder[0]).toBeLessThan(d.marcarConversa.mock.invocationCallOrder[0]!);
  });

  it("I2: mensagem enviada do celular e mensagem repetida NÃO reabrem", async () => {
    const eco = db(ligado());
    await gravarMensagemDeGrupo(eco, entrada({ direction: "outbound", remetente: null }));
    expect(eco.reabrirSeFechada).not.toHaveBeenCalled();
    const dup = db(ligado(), true);
    await gravarMensagemDeGrupo(dup, entrada());
    expect(dup.reabrirSeFechada).not.toHaveBeenCalled();
  });

  it("remetente fora do formato não derruba a mensagem: grava sem group_sender", async () => {
    const d = db(ligado());
    await expect(
      gravarMensagemDeGrupo(d, entrada({ remetente: { name: "M", phone: "lixo", lid: null } })),
    ).resolves.toBe("gravada");
    expect((d.inserirMensagem.mock.calls[0]![0]!.metadata as Record<string, unknown>).group_sender).toBeUndefined();
  });

  // ── #2729 — a chave POR GRUPO "Permitir que a IA responda neste grupo" ─────
  //
  // A régua é o `ia_responde` da linha do grupo. DESLIGADO (o default, e o
  // estado de quem nunca mexeu em nada) mantém o comportamento de sempre: o
  // grupo entra na inbox e a IA fica calada, sem evento nenhum pedido. Ligado,
  // a mensagem gravada pede o turno do agente — o MESMO evento
  // `ai_agent.dispatch_requested` da conversa individual, pelo mesmo consumidor
  // (`lib/agent-engine/edge/crm/drain.ts`), que é quem decide se o turno roda.
  it("#2729: grupo que libera a IA ganha o pedido de turno, depois do carimbo da conversa", async () => {
    const d = db(ligado({ iaResponde: true }));
    await expect(gravarMensagemDeGrupo(d, entrada())).resolves.toBe("gravada");
    expect(d.pedirDespachoDeIa).toHaveBeenCalledWith({
      organizationId: ORG,
      conversationId: "v",
      contactId: "c",
      channelSessionId: SESS,
      messageId: "m1",
    });
    // Depois do carimbo: o turno lê a conversa já com `last_inbound_at` novo.
    expect(d.pedirDespachoDeIa.mock.invocationCallOrder[0]).toBeGreaterThan(
      d.marcarConversa.mock.invocationCallOrder[0]!,
    );
  });

  it("#2729: padrão DESLIGADO — grupo ligado sem a chave não pede turno nenhum", async () => {
    const semChave = db(ligado());
    await gravarMensagemDeGrupo(semChave, entrada());
    expect(semChave.pedirDespachoDeIa).not.toHaveBeenCalled();

    const chaveDesligada = db(ligado({ iaResponde: false }));
    await gravarMensagemDeGrupo(chaveDesligada, entrada());
    expect(chaveDesligada.pedirDespachoDeIa).not.toHaveBeenCalled();

    // Linha gravada por uma versão anterior (coluna ainda nula): falha fechada.
    const nula = db({ id: "g1", subject: "A", contactId: "c", conversationId: "v", iaResponde: null } as never);
    await gravarMensagemDeGrupo(nula, entrada());
    expect(nula.pedirDespachoDeIa).not.toHaveBeenCalled();
  });

  it("#2729: eco do celular e mensagem repetida não pedem turno, mesmo com a chave ligada", async () => {
    const eco = db(ligado({ iaResponde: true }));
    await gravarMensagemDeGrupo(eco, entrada({ direction: "outbound", remetente: null }));
    expect(eco.pedirDespachoDeIa).not.toHaveBeenCalled();

    const dup = db(ligado({ iaResponde: true }), true);
    await gravarMensagemDeGrupo(dup, entrada());
    expect(dup.pedirDespachoDeIa).not.toHaveBeenCalled();
  });
});

/**
 * Banco de mentira para `criarIngestDeGrupoDb`: registra cada comando com os
 * filtros que ele citou, e deixa o teste decidir o que o INSERT devolve.
 */
function adminDeMentira(cfg: {
  insercao?: Record<string, { data: unknown; error: unknown }>;
  leitura?: Record<string, { data: unknown; error: unknown }>;
  /** Substitui o `rpc` fake — para provar que um `emit_event` recusado não derruba nada. */
  rpc?: (fn: string, args: Record<string, unknown>) => Promise<{ data: unknown; error: unknown }>;
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
      is: (c: string, v: unknown) => { cmd.filtros.push([c, v]); return q; },
      limit: () => q,
      single: fim,
      maybeSingle: fim,
      then: (ok: (v: unknown) => unknown) => fim().then(ok),
    };
    return q;
  };
  const admin = {
    from,
    rpc: async (fn: string, args: Record<string, unknown>) => {
      rpcs.push({ fn, args });
      return cfg.rpc ? await cfg.rpc(fn, args) : { data: null, error: null };
    },
  };
  return { admin, comandos, rpcs };
}

const DUP = { data: null, error: { code: "23505", message: "duplicate key" } };

/**
 * #3566 — o rótulo da menção, pela régua do `group_sender`: `wa_lid` primeiro,
 * `phone_number` nas duas grafias do nono dígito depois, contato fundido fora.
 */
describe("criarIngestDeGrupoDb — rótulo das menções (#3566)", () => {
  it("resolve por wa_lid e por telefone (duas grafias), e deixa sem nome quem não achou", async () => {
    const { admin, comandos } = adminDeMentira({
      leitura: {
        contacts: {
          data: [
            // `name` vazio: o rótulo vem do `display_name` pela `nomeDoContato`.
            { name: null, display_name: "Maria Exemplo", phone_number: "+5511999990000", wa_lid: "75235009282237" },
            // Celular gravado SEM o nono dígito — a menção chegou COM ele.
            { name: "João", display_name: null, phone_number: "+553198966398", wa_lid: null },
          ],
          error: null,
        },
      },
    });
    const r = await criarIngestDeGrupoDb(admin as never).rotulosDasMencoes(ORG, [
      { lid: "75235009282237", phone: null, name: null },
      { lid: null, phone: "+5531998966398", name: null },
      { lid: "11111111111111", phone: null, name: null },
    ]);
    expect(r).toEqual([
      { lid: "75235009282237", phone: null, name: "Maria Exemplo" },
      { lid: null, phone: "+5531998966398", name: "João" },
      { lid: "11111111111111", phone: null, name: null },
    ]);
    const leituras = comandos.filter((c) => c.tabela === "contacts" && c.op === "select");
    expect(leituras.map((c) => c.filtros.find(([k]) => k === "wa_lid" || k === "phone_number"))).toEqual([
      ["wa_lid", ["75235009282237", "11111111111111"]],
      ["phone_number", ["+5531998966398", "+553198966398"]],
    ]);
    for (const c of leituras) {
      expect(c.filtros).toContainEqual(["organization_id", ORG]);
      // Contato fundido em outro não dá rótulo: quem aparece é o sobrevivente.
      expect(c.filtros).toContainEqual(["is_merged_into", null]);
    }
  });

  it("leitura que falha não derruba nada: a menção volta sem rótulo", async () => {
    const { admin } = adminDeMentira({ leitura: { contacts: { data: null, error: { message: "sem rede" } } } });
    await expect(
      criarIngestDeGrupoDb(admin as never).rotulosDasMencoes(ORG, [{ lid: "75235009282237", phone: null, name: null }]),
    ).resolves.toEqual([{ lid: "75235009282237", phone: null, name: null }]);
  });

  it("menção sem lid e sem telefone não paga leitura nenhuma", async () => {
    const { admin, comandos } = adminDeMentira({});
    await expect(
      criarIngestDeGrupoDb(admin as never).rotulosDasMencoes(ORG, [{ lid: null, phone: null, name: null }]),
    ).resolves.toEqual([{ lid: null, phone: null, name: null }]);
    expect(comandos).toEqual([]);
  });
});

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
    const id = await criarIngestDeGrupoDb(admin as never).criarConversaDoGrupo(ORG, SESS, "c1", "1@g.us", "2026-09-23T12:00:00.000Z");
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
    expect(r).toMatchObject({ status: "ok", messageId: "m1" });
    expect(rpcs.find((c) => c.fn === "emit_event")?.args).toMatchObject({
      p_event_type: "media.persist_requested", p_entity_id: "m1", p_organization_id: ORG,
    });
  });

  it("mensagem duplicada não pede persistência de mídia de novo", async () => {
    const { admin, rpcs } = adminDeMentira({ insercao: { messages: DUP } });
    const r = await criarIngestDeGrupoDb(admin as never).inserirMensagem({
      organization_id: ORG, conversation_id: "v", media_url: "https://x/y.jpg",
    });
    expect(r).toEqual({ status: "duplicada", messageId: null });
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

  // ── #2729 — o episódio de serviço da conversa de grupo ────────────────────
  it("#2729: a conversa de grupo nasce com service_started_at (sem ele toda enviada sai do histórico)", async () => {
    const { admin, comandos } = adminDeMentira({});
    await criarIngestDeGrupoDb(admin as never).criarConversaDoGrupo(
      ORG,
      SESS,
      "c1",
      "1@g.us",
      "2026-09-23T12:00:00.000Z",
    );
    expect(comandos[0]!.linha).toMatchObject({
      is_group: true,
      service_started_at: "2026-09-23T12:00:00.000Z",
    });
  });

  it("#2729: reabrir carimba a recebida com a revisão NOVA e datar o episódio nela", async () => {
    const { admin, comandos } = adminDeMentira({
      leitura: { conversations: { data: { service_revision: 7 }, error: null } },
    });
    await criarIngestDeGrupoDb(admin as never).reabrirSeFechada(
      ORG,
      "v",
      "m1",
      "2026-09-23T12:00:00.000Z",
    );
    expect(comandos[0]!.linha).toMatchObject({
      status: "open",
      service_started_at: "2026-09-23T12:00:00.000Z",
    });
    const carimbo = comandos.find((c) => c.tabela === "messages")!;
    expect(carimbo.linha).toEqual({ service_revision: 7 });
    expect(carimbo.filtros).toEqual(
      expect.arrayContaining([
        ["organization_id", ORG],
        ["conversation_id", "v"],
        ["id", "m1"],
        ["direction", "inbound"],
        ["service_revision", null],
      ]),
    );
  });

  it("#2729: conversa que NÃO estava fechada não carimba mensagem nenhuma", async () => {
    const { admin, comandos } = adminDeMentira({
      leitura: { conversations: { data: null, error: null } },
    });
    await criarIngestDeGrupoDb(admin as never).reabrirSeFechada(ORG, "v", "m1", "2026-09-23T12:00:00.000Z");
    expect(comandos.filter((c) => c.tabela === "messages")).toHaveLength(0);
  });

  it("carimbo da conversa passa pela função compartilhada (fn_mark_conversation_message)", async () => {
    const { admin, rpcs } = adminDeMentira({});
    await criarIngestDeGrupoDb(admin as never).marcarConversa(ORG, "v", "oi", "2026-09-23T12:00:00.000Z", "outbound");
    expect(rpcs[0]).toMatchObject({
      fn: "fn_mark_conversation_message",
      args: { p_conv: "v", p_direction: "outbound", p_preview: "oi", p_at: "2026-09-23T12:00:00.000Z" },
    });
  });

  // ── #2729 — a chave da IA vem LIDA da linha do grupo, junto com o resto ───
  it("#2729: grupoLigado devolve a chave da IA (e a coluna entra no SELECT)", async () => {
    const { admin, comandos } = adminDeMentira({
      leitura: { channel_session_groups: { data: { id: "g1", subject: "A", contact_id: "c", conversation_id: "v", ia_responde: true }, error: null } },
    });
    await expect(criarIngestDeGrupoDb(admin as never).grupoLigado(ORG, SESS, "1@g.us")).resolves.toEqual({
      id: "g1",
      subject: "A",
      contactId: "c",
      conversationId: "v",
      iaResponde: true,
    });
    expect(comandos[0]!.filtros).toEqual(expect.arrayContaining([["enabled", true]]));
  });

  it("#2729: o pedido de turno é o MESMO evento da conversa individual, e falha para dentro", async () => {
    const ok = adminDeMentira({});
    await criarIngestDeGrupoDb(ok.admin as never).pedirDespachoDeIa({
      organizationId: ORG,
      conversationId: "v",
      contactId: "c",
      channelSessionId: SESS,
      messageId: "m1",
    });
    expect(ok.rpcs[0]).toMatchObject({
      fn: "emit_event",
      args: {
        p_event_type: "ai_agent.dispatch_requested",
        p_entity_kind: "message",
        p_entity_id: "m1",
        p_organization_id: ORG,
        p_payload: {
          organization_id: ORG,
          conversation_id: "v",
          contact_id: "c",
          channel_session_id: SESS,
          inbound_message_id: "m1",
        },
      },
    });

    // Recusado pelo banco: a mensagem JÁ está gravada, então é log e nada mais.
    // Um throw aqui viraria 500 para o provedor, que reenviaria tudo.
    const aviso = vi.spyOn(logger, "warn").mockImplementation(() => {});
    const recusado = adminDeMentira({
      rpc: async () => ({ data: null, error: { message: "permission denied" } }),
    });
    await expect(
      criarIngestDeGrupoDb(recusado.admin as never).pedirDespachoDeIa({
        organizationId: ORG,
        conversationId: "v",
        contactId: "c",
        channelSessionId: SESS,
        messageId: "m1",
      }),
    ).resolves.toBeUndefined();
    expect(aviso).toHaveBeenCalled();
    aviso.mockRestore();
  });
});
