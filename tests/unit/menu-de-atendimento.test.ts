/**
 * O MENU DE ATENDIMENTO SEM IA (#4594, fatia 1) — os caminhos que a issue pede.
 *
 * ─── O que estes casos medem, e por que por aqui ────────────────────────────
 *
 * Não medem `atenderMenuSemIa` isolado com um dublê de porta: medem a INGESTÃO
 * de verdade (`aplicarEfeitosPosEntrada`), porque a promessa central da issue —
 * "sem gastar token" — não é do menu, é da LINHA que deixa de emitir
 * `ai_agent.dispatch_requested`. Um teste que só olhasse a função passaria com a
 * ingestão despachando a IA em seguida.
 *
 * As quatro portas do mundo real são dubladas no lugar certo: o envio
 * (`sendMessageHandler`, a porta de saída de todos os chamadores), a passagem
 * para humano (`triggerHandoff`, a régua do handoff) e a leitura do módulo da
 * instalação (`moduloLigadoComMemo`). O resto — configuração, estado na conversa,
 * decisão, numeração — roda o código de produção.
 *
 * Os quatro caminhos exigidos:
 *   1. a opção que passa para a FILA;
 *   2. a opção que MANDA UM ARQUIVO existente;
 *   3. a OPÇÃO INVÁLIDA: repete UMA vez e depois cai para humano (sem laço);
 *   4. a FLAG DESLIGADA: tudo como hoje, com card e com despacho da IA.
 * Mais a opção que passa para uma PESSOA, que é a terceira ação do modelo.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => {}) }));
const { moduloLigado, moduloLigadoComMemo } = vi.hoisted(() => ({
  moduloLigado: vi.fn(),
  moduloLigadoComMemo: vi.fn(),
}));
vi.mock("@/lib/instalacao/modulos", () => ({ moduloLigado, moduloLigadoComMemo }));
vi.mock("@/lib/leads/encerramento", () => ({
  encerraDemanda: vi.fn(async () => ({ lead: {}, jaEstava: false })),
}));
const { garantirLeadDaConversa } = vi.hoisted(() => ({
  garantirLeadDaConversa: vi.fn(
    async (_db: unknown, _dados: { conversationId?: string }) => ({ criado: true, leadId: "lead-1" }),
  ),
}));
vi.mock("@/lib/leads/nascimento-do-lead", () => ({ garantirLeadDaConversa }));
vi.mock("@/lib/dev/kick-local-pipeline", () => ({
  acelerarFollowupDoInbound: vi.fn(async () => {}),
  drenarEventosDoInbound: vi.fn(async () => {}),
  acelerarPipelineDeEventos: vi.fn(async () => {}),
  kickLocalPipeline: vi.fn(async () => {}),
}));

/** O envio REAL, dublado: é a porta que a ingestão usa em produção. */
interface Enviado {
  conversationId: string;
  body: string | null;
  type: string;
  mediaUrl: string | null;
  chave: string;
}
const enviados: Enviado[] = [];
vi.mock("@/app/api/v1/messages/_handler", () => ({
  sendMessageHandler: vi.fn(
    async (
      _supabase: unknown,
      _ctx: unknown,
      input: {
        conversation_id: string;
        type?: string;
        body?: string;
        media_url?: string;
        metadata?: { idempotency_key?: string };
      },
    ) => {
      enviados.push({
        conversationId: input.conversation_id,
        body: input.body ?? null,
        type: input.type ?? "text",
        mediaUrl: input.media_url ?? null,
        chave: input.metadata?.idempotency_key ?? "",
      });
      return { id: `msg-enviada-${enviados.length}`, status: "sent" };
    },
  ),
}));

/** A régua da passagem para humano, dublada: o que se mede é COMO ela é chamada. */
const { triggerHandoff } = vi.hoisted(() => ({ triggerHandoff: vi.fn() }));
vi.mock("@/lib/ai/handoff/orchestrator", () => ({ triggerHandoff }));

import type { SupabaseClient } from "@supabase/supabase-js";

import { aplicarEfeitosPosEntrada, type EntradaDeMensagem } from "@/lib/channels/pos-entrada";
import { logger } from "@/lib/logger";
import { sendMessageHandler } from "@/app/api/v1/messages/_handler";
import {
  CHAVE_NO_METADATA,
  lerEstadoDoMenu,
  type EstadoDoMenu,
} from "@/lib/atendimento/menu/decisao";
import {
  CHAVE_NO_SETTINGS,
  menuDeclarado,
  opcaoPeloNumero,
  renderizarMenu,
  validarMenu,
} from "@/lib/atendimento/menu/modelo";
import { ORG_ID, makeDb, type DbOpts } from "@/tests/helpers/stages-db-double";

const CONVERSA = "88888888-8888-4888-8888-888888888888";
const CONTATO = "99999999-9999-4999-8999-999999999999";
const SESSAO = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const PESSOA = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
/**
 * O relógio do caminho de PRODUÇÃO — `portasDoMenu` não injeta `agora`, então
 * `atenderMenuSemIa` lê o relógio de verdade. Uma data fixa aqui fazia o estado
 * semeado nascer vencido e a suíte apodrecia 24 h depois de escrita: o menu era
 * reenviado no lugar da escolha e as três opções reprovavam sem nada ter mudado
 * no código. Quem mede VALIDADE usa datas explícitas (ver o caso da expiração).
 */
const AGORA = new Date();

const MENU = {
  ativa: true,
  boas_vindas: "Olá! Escolha o setor que pode te ajudar:",
  opcoes: [
    { tipo: "arquivo" as const, rotulo: "Tabela de preços", media_url: "https://exemplo.com/tabela.pdf" },
    { tipo: "fila" as const, rotulo: "Financeiro" },
    { tipo: "pessoa" as const, rotulo: "Falar com a Ana", user_id: PESSOA },
  ],
};

type Db = ReturnType<typeof makeDb>;

function conversa(over: Record<string, unknown> = {}) {
  return {
    id: CONVERSA,
    organization_id: ORG_ID,
    channel: "whatsapp",
    status: "open",
    assigned_to_user_id: null,
    bot_silenced_until: null,
    metadata: {},
    ...over,
  };
}

function db(
  over: {
    menu?: unknown;
    metadata?: Record<string, unknown>;
    escrita?: Record<string, unknown>;
    rpcResult?: DbOpts["rpcResult"];
    /**
     * As colunas do CONTATO (#4636): `force_human`, `ai_opt_out` e `tags` são o
     * que o menu passou a ler. Sem declarar aqui, o contato do dublê não tem as
     * marcas e o caso mediria o dublê em vez do runtime.
     */
    contato?: Record<string, unknown>;
    /** Chaves a mais no `settings` da organização — as listas de etiqueta. */
    settings?: Record<string, unknown>;
  } = {},
): Db {
  const settings: Record<string, unknown> = {
    ...(over.menu === null ? {} : { [CHAVE_NO_SETTINGS]: over.menu ?? MENU }),
    ...(over.settings ?? {}),
  };
  return makeDb({
    organizationSettings: settings,
    contacts: [{ id: CONTATO, organization_id: ORG_ID, ...(over.contato ?? {}) }],
    conversas: [conversa({ metadata: over.metadata ?? {}, ...(over.escrita ?? {}) })],
    ...(over.rpcResult ? { rpcResult: over.rpcResult } : {}),
  });
}

function entrada(over: Partial<EntradaDeMensagem> = {}): EntradaDeMensagem {
  return {
    organizationId: ORG_ID,
    contactId: CONTATO,
    conversationId: CONVERSA,
    messageId: "msg-1",
    channelSessionId: SESSAO,
    texto: "bom dia",
    nomeDoContato: "Quem escreveu",
    origem: "teste",
    canal: "whatsapp",
    ...over,
  };
}

async function passar(registro: Db, over: Partial<EntradaDeMensagem> = {}) {
  await aplicarEfeitosPosEntrada(
    registro.client as unknown as SupabaseClient,
    entrada(over),
  );
}

/** O menu que o cliente efetivamente viu (o texto que contém as opções). */
function menusEnviados(): Enviado[] {
  return enviados.filter((e) => e.body !== null && e.body.includes("1 - Tabela de preços"));
}

/** O estado do menu como ele ficou gravado na conversa. */
function estadoGravado(registro: Db): EstadoDoMenu | null {
  const linha = registro.tabelas.conversations[0] as { metadata?: Record<string, unknown> };
  return lerEstadoDoMenu(linha?.metadata, AGORA);
}

/** O despacho da IA foi pedido nesta mensagem? */
function despachouIA(registro: Db): boolean {
  return despachosIA(registro).length > 0;
}

/** QUANTOS despachos da IA saíram — a corrida da #5137 mede a contagem. */
function despachosIA(registro: Db): Array<{ nome: string; args: unknown }> {
  return registro.rpcs.filter(
    (r) => r.nome === "emit_event" && (r.args as { p_event_type?: string })?.p_event_type === "ai_agent.dispatch_requested",
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  enviados.length = 0;
  moduloLigado.mockResolvedValue(true);
  moduloLigadoComMemo.mockResolvedValue(true);
  triggerHandoff.mockResolvedValue({ triggered: true, reason: "requested_human" });
});

// ---------------------------------------------------------------------------
// 1. o modelo
// ---------------------------------------------------------------------------

describe("o modelo do menu", () => {
  it("a posição no array É o número impresso — as duas coisas não podem divergir", () => {
    const validado = validarMenu(MENU);
    expect(validado.ok).toBe(true);
    if (!validado.ok) return;

    const impresso = renderizarMenu(validado.menu);
    expect(impresso).toBe(
      [
        "Olá! Escolha o setor que pode te ajudar:",
        "",
        "1 - Tabela de preços",
        "2 - Financeiro",
        "3 - Falar com a Ana",
      ].join("\n"),
    );
    // O número que o cliente digita casa com a linha que ele leu.
    expect(opcaoPeloNumero(validado.menu, "2")?.rotulo).toBe("Financeiro");
    expect(opcaoPeloNumero(validado.menu, " 3. ")?.rotulo).toBe("Falar com a Ana");
    expect(opcaoPeloNumero(validado.menu, "4")).toBeNull();
    expect(opcaoPeloNumero(validado.menu, "quero o 2")).toBeNull();
  });

  it("recusa o menu que falharia no primeiro cliente que escolhesse", () => {
    const semOpcao = validarMenu({ ativa: true, boas_vindas: "oi", opcoes: [] });
    expect(semOpcao.ok).toBe(false);

    const rotuloRepetido = validarMenu({
      ativa: true,
      boas_vindas: "oi",
      opcoes: [
        { tipo: "fila", rotulo: "Vendas" },
        { tipo: "fila", rotulo: "vendas" },
      ],
    });
    expect(rotuloRepetido.ok).toBe(false);

    const pessoaSemId = validarMenu({
      ativa: true,
      boas_vindas: "oi",
      opcoes: [{ tipo: "pessoa", rotulo: "Ana", user_id: "ana" }],
    });
    expect(pessoaSemId.ok).toBe(false);

    // PDF passa; um endereço que o envio não sabe classificar, não.
    const arquivoInvalido = validarMenu({
      ativa: true,
      boas_vindas: "oi",
      opcoes: [{ tipo: "arquivo", rotulo: "Tabela", media_url: "https://exemplo.com/planilha" }],
    });
    expect(arquivoInvalido.ok).toBe(false);
  });

  it("só o `true` EXPLÍCITO liga; ausente, texto ou lixo é desligado", () => {
    const semChave = validarMenu({ boas_vindas: "oi", opcoes: MENU.opcoes });
    expect(semChave.ok && semChave.menu.ativa).toBe(false);

    const comTexto = validarMenu({ ativa: "true", boas_vindas: "oi", opcoes: MENU.opcoes });
    expect(comTexto.ok).toBe(false);

    // E a chave que não está no `settings` da empresa é o padrão de fábrica.
    expect(menuDeclarado({})).toBeNull();
    expect(menuDeclarado({ [CHAVE_NO_SETTINGS]: { ...MENU, ativa: false } })?.ativa).toBe(false);
    expect(menuDeclarado({ [CHAVE_NO_SETTINGS]: MENU })?.ativa).toBe(true);
  });

  it("estado de mais de 24 h EXPIRA — menu velho não sequestra a conversa", () => {
    const metadata = {
      [CHAVE_NO_METADATA]: { estado: "aguardando", atualizado_em: "2026-11-12T12:00:00.000Z", repeticao: 0 },
    };
    // 25 h depois: venceu. 23 h depois: ainda vale. As duas datas são fixas para
    // o caso medir a VALIDADE, não o relógio de quem roda a suíte.
    expect(lerEstadoDoMenu(metadata, new Date("2026-11-13T13:00:00.000Z"))).toBeNull();
    expect(lerEstadoDoMenu(metadata, new Date("2026-11-13T11:00:00.000Z"))).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 2. os quatro caminhos exigidos
// ---------------------------------------------------------------------------

describe("menu de atendimento sem IA na entrada (#4594)", () => {
  it("⭐ FLAG DESLIGADA mantém o comportamento de hoje: card no funil e IA despachada", async () => {
    const registro = db({ menu: null });

    await passar(registro);

    expect(enviados).toHaveLength(0);
    expect(estadoGravado(registro)).toBeNull();
    expect(garantirLeadDaConversa).toHaveBeenCalledTimes(1);
    expect(despachouIA(registro)).toBe(true);
  });

  it("⭐ módulo da INSTALAÇÃO desligado não liga o menu nem despacha a IA de outro jeito", async () => {
    moduloLigadoComMemo.mockResolvedValue(false);
    const registro = db();

    await passar(registro);

    expect(enviados).toHaveLength(0);
    expect(estadoGravado(registro)).toBeNull();
    expect(despachouIA(registro)).toBe(true);
  });

  it("⭐ primeira mensagem recebe o menu, estado fica aguardando e NENHUMA IA é despachada", async () => {
    const registro = db();

    await passar(registro, { texto: "bom dia" });

    expect(menusEnviados()).toHaveLength(1);
    expect(enviados[0]?.body).toContain("2 - Financeiro");
    expect(estadoGravado(registro)?.estado).toBe("aguardando");
    // O coração da issue: o evento que acorda o modelo não existe.
    expect(despachouIA(registro)).toBe(false);
    // E o card no funil nasce igual — menu é atendimento, não desvio comercial.
    expect(garantirLeadDaConversa).toHaveBeenCalledTimes(1);
  });

  it("⭐ opção 2 (FILA): passa a conversa para o atendimento humano reusando o handoff", async () => {
    const registro = db({
      metadata: { [CHAVE_NO_METADATA]: { estado: "aguardando", atualizado_em: AGORA.toISOString(), repeticao: 0 } },
    });

    await passar(registro, { messageId: "msg-2", texto: "2" });

    expect(triggerHandoff).toHaveBeenCalledTimes(1);
    expect(triggerHandoff).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: ORG_ID,
        conversationId: CONVERSA,
        reason: "requested_human",
        origem: "runtime_nativo",
      }),
    );
    expect(enviados.at(-1)?.body).toContain("passando para um atendente");
    expect(estadoGravado(registro)).toMatchObject({ estado: "concluido", desfecho: "fila:2" });
    expect(despachouIA(registro)).toBe(false);
  });

  it("⭐ opção 1 (ARQUIVO): manda o arquivo existente pelo tipo que a régua de mídia achou", async () => {
    const registro = db({
      metadata: { [CHAVE_NO_METADATA]: { estado: "aguardando", atualizado_em: AGORA.toISOString(), repeticao: 0 } },
    });

    await passar(registro, { messageId: "msg-2", texto: "1" });

    expect(enviados).toHaveLength(1);
    expect(enviados[0]).toMatchObject({
      conversationId: CONVERSA,
      type: "document",
      mediaUrl: "https://exemplo.com/tabela.pdf",
    });
    expect(estadoGravado(registro)).toMatchObject({ estado: "concluido", desfecho: "arquivo:1" });
    expect(triggerHandoff).not.toHaveBeenCalled();
    expect(despachouIA(registro)).toBe(false);
  });

  it("⭐ opção 3 (PESSOA): atribui pela RPC que a rota de transferência usa", async () => {
    const registro = db({
      metadata: { [CHAVE_NO_METADATA]: { estado: "aguardando", atualizado_em: AGORA.toISOString(), repeticao: 0 } },
      rpcResult: (nome) =>
        nome === "fn_conversation_assign" ? { data: [{ id: CONVERSA }], error: null } : null,
    });

    await passar(registro, { messageId: "msg-2", texto: "3" });

    const atribuicao = registro.rpcs.find((r) => r.nome === "fn_conversation_assign");
    expect(atribuicao?.args).toMatchObject({
      p_organization_id: ORG_ID,
      p_conversation_id: CONVERSA,
      p_to_user_id: PESSOA,
      p_reason: "transfer",
    });
    expect(estadoGravado(registro)).toMatchObject({ estado: "concluido", desfecho: "pessoa:3" });
    expect(despachouIA(registro)).toBe(false);
  });

  it("⭐ OPÇÃO INVÁLIDA: repete UMA vez e depois cai para humano — sem laço", async () => {
    const registro = db();

    // 1ª mensagem: o menu sai.
    await passar(registro, { messageId: "msg-1", texto: "bom dia" });
    expect(menusEnviados()).toHaveLength(1);

    // 2ª: não é número. O menu é repetido — e é a ÚNICA repetição.
    await passar(registro, { messageId: "msg-2", texto: "queria falar com alguém" });
    expect(menusEnviados()).toHaveLength(2);
    expect(estadoGravado(registro)?.estado).toBe("repetiu");
    expect(triggerHandoff).not.toHaveBeenCalled();

    // 3ª: de novo fora da lista. Agora é humano, e o menu NÃO volta.
    await passar(registro, { messageId: "msg-3", texto: "oi??" });
    expect(menusEnviados()).toHaveLength(2);
    expect(triggerHandoff).toHaveBeenCalledTimes(1);
    expect(estadoGravado(registro)).toMatchObject({ estado: "concluido", desfecho: "opcao_invalida" });
    expect(enviados.at(-1)?.body).toContain("atendente");
    expect(despachouIA(registro)).toBe(false);
  });

  it("conversa já com dono não recebe menu (o humano está atendendo)", async () => {
    const registro = db({ escrita: { assigned_to_user_id: PESSOA } });

    await passar(registro, { texto: "bom dia" });

    expect(enviados).toHaveLength(0);
    expect(despachouIA(registro)).toBe(true);
  });

  // -------------------------------------------------------------------------
  // 3. O CONTATO: "sempre humano" é trava, e o menu a respeita (#4636)
  // -------------------------------------------------------------------------

  it("⭐ contato marcado como sempre humano NÃO recebe menu e nada é gravado", async () => {
    // "Marcar como sempre humano" (`/api/v1/contacts/[id]/always-human`) grava
    // `force_human` e `ai_opt_out` no CONTATO e não silencia conversa nenhuma.
    // O gate da IA trata a marca como trava irrevogável; o menu, que nunca lia
    // `contacts`, mandava o menu assim mesmo — este caso é o vermelho de antes.
    const registro = db({ contato: { force_human: true, ai_opt_out: true } });

    await passar(registro, { texto: "bom dia" });

    expect(menusEnviados()).toHaveLength(0);
    expect(enviados).toHaveLength(0);
    // Nada é gravado na conversa: o menu não é dono desta mensagem.
    expect(registro.escritas.filter((e) => e.table === "conversations")).toHaveLength(0);
    expect(estadoGravado(registro)).toBeNull();
    // E a ingestão segue o caminho de hoje — quem barra a IA é o gate, não o menu.
    expect(despachouIA(registro)).toBe(true);
  });

  it("⭐ contato interno da equipe NÃO recebe menu (as duas listas do gate)", async () => {
    // A lista interna (#2353) é veto de CONTATO no gate; a da equipe (#3534) é
    // o sócio que continua sendo atendido quando ESCREVE, mas não recebe
    // automação. As duas são lidas pela MESMA régua do gate, com a mesma
    // normalização (`Equipe`/`equipe` casam).
    const interna = db({
      contato: { tags: ["equipe"] },
      settings: { crm: { internal_contact_tags: ["Equipe"] } },
    });
    await passar(interna, { texto: "bom dia" });
    expect(menusEnviados()).toHaveLength(0);
    expect(interna.escritas.filter((e) => e.table === "conversations")).toHaveLength(0);

    enviados.length = 0;
    const daEquipe = db({
      contato: { tags: ["socio"] },
      settings: { crm: { team_contact_tags: ["Socio"] } },
    });
    await passar(daEquipe, { texto: "bom dia" });
    expect(menusEnviados()).toHaveLength(0);
    expect(daEquipe.escritas.filter((e) => e.table === "conversations")).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // 4. O CRITÉRIO: "a primeira mensagem de uma conversa sem dono" (#4636)
  // -------------------------------------------------------------------------

  it("⭐ estado vencido há 25 h, concluido, com saída anterior: NÃO recebe menu de novo", async () => {
    // Quem escolheu o arquivo e seguiu conversando recebia o menu outra vez 24 h
    // depois da escolha: o estado vencia, virava `null` e `null` virava
    // `enviar_menu`. O atendimento JÁ começou (há saída da empresa), então o
    // menu não entra — e o estado não é regravado.
    const vinteCincoHorasAtras = new Date(AGORA.getTime() - 25 * 60 * 60 * 1000).toISOString();
    const registro = db({
      escrita: { last_outbound_at: vinteCincoHorasAtras },
      metadata: {
        [CHAVE_NO_METADATA]: {
          estado: "concluido",
          atualizado_em: vinteCincoHorasAtras,
          repeticao: 0,
          desfecho: "arquivo:1",
        },
      },
    });

    await passar(registro, { messageId: "msg-9", texto: "e o prazo, como fica?" });

    expect(menusEnviados()).toHaveLength(0);
    expect(registro.escritas.filter((e) => e.table === "conversations")).toHaveLength(0);
    // A conversa segue viva com a IA — o menu não a sequestra.
    expect(despachouIA(registro)).toBe(true);
  });

  it("⭐ primeira mensagem de verdade RECEBE o menu", async () => {
    // O estado de fábrica de uma conversa nova: sem saída e sem atendimento.
    const registro = db({ escrita: { service_started_at: null, last_outbound_at: null } });

    await passar(registro, { texto: "bom dia" });

    expect(menusEnviados()).toHaveLength(1);
    expect(estadoGravado(registro)?.estado).toBe("aguardando");

    // E o estado REAL de uma conversa nova: `fn_service_inbound` carimba
    // `service_started_at` no INSERT da PRIMEIRA mensagem do cliente
    // (`supabase/baseline.sql:19805`) e a migração de reparo carimbou todas as
    // conversas que existiam (`:20393`). Exigir o carimbo nulo nunca enviaria
    // menu nenhum; o critério é a ausência de SAÍDA da empresa.
    enviados.length = 0;
    const comCarimboDoInbound = db({
      escrita: { service_started_at: AGORA.toISOString(), last_outbound_at: null },
    });
    await passar(comCarimboDoInbound, { texto: "oi" });
    expect(menusEnviados()).toHaveLength(1);
    expect(estadoGravado(comCarimboDoInbound)?.estado).toBe("aguardando");
  });

  // -------------------------------------------------------------------------
  // 5. A CORRIDA: duas entradas AO MESMO TEMPO na mesma conversa (#5137)
  // -------------------------------------------------------------------------

  it("⭐ duas entradas SIMULTÂNEAS: no máximo UMA decide enviar o menu (#5137)", async () => {
    // A fatia 1 do menu (PR #4636) decidia em read-modify-write: lia a conversa,
    // decidia, gravava o estado e só então mandava. Como o `messageId` entra na
    // chave de idempotência (`menu-de-atendimento:<conversa>:<mensagem>:menu`),
    // duas mensagens DIFERENTES da mesma conversa tinham chaves diferentes e as
    // DUAS passavam: medido com `Promise.all` em `aplicarEfeitosPosEntrada`,
    // "oi" e "tudo bem?" mandavam dois menus. Este caso é o vermelho de antes.
    const registro = db();

    await Promise.all([
      passar(registro, { messageId: "msg-1", texto: "oi" }),
      passar(registro, { messageId: "msg-2", texto: "tudo bem?" }),
    ]);

    // A contagem é das RESPOSTAS do dublê — o que saiu para o cliente —, não do
    // log: um teste que contasse log passaria mesmo com o menu indo duas vezes.
    expect(menusEnviados()).toHaveLength(1);
    expect(estadoGravado(registro)?.estado).toBe("aguardando");

    // O perdedor NÃO sai do fluxo: cai no caminho normal da entrada, que
    // despacha a IA. Um despacho, não dois — o vencedor tem a palavra.
    expect(despachosIA(registro)).toHaveLength(1);

    // O card é da ENTRADA, não do menu: uma chamada por entrada, e as duas
    // apontam para a MESMA conversa (o mesmo lead no banco). O menu não
    // acrescenta card nenhum.
    expect(garantirLeadDaConversa).toHaveBeenCalledTimes(2);
    expect(
      garantirLeadDaConversa.mock.calls.map(
        ([, dados]) => (dados as { conversationId?: string }).conversationId,
      ),
    ).toEqual([CONVERSA, CONVERSA]);

    // E o motivo do perdedor fica no rastro, nomeado.
    const motivos = vi
      .mocked(logger)
      .info.mock.calls.map(([, meta]) => (meta as { motivo?: string } | undefined)?.motivo);
    expect(motivos).toContain("menu_em_disputa");
  });

  it("envio do menu FALHOU: a posse é devolvida e a próxima mensagem recebe o menu (#5137)", async () => {
    const registro = db({ metadata: { outra: "chave" } });
    vi.mocked(sendMessageHandler).mockResolvedValueOnce({ status: "failed" } as Awaited<ReturnType<typeof sendMessageHandler>>);

    await passar(registro, { messageId: "msg-1", texto: "oi" });
    expect(estadoGravado(registro)).toBeNull();
    expect((registro.tabelas.conversations[0] as { metadata?: Record<string, unknown> }).metadata).toEqual({ outra: "chave" });

    await passar(registro, { messageId: "msg-2", texto: "oi de novo" });
    expect(menusEnviados()).toHaveLength(1);
    expect(estadoGravado(registro)?.estado).toBe("aguardando");
  });
});
