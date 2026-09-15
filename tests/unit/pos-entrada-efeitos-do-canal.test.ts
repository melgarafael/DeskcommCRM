import { readFileSync } from "node:fs";

import { beforeEach, describe, expect, it, vi } from "vitest";

import type { EntradaDeMensagem } from "@/lib/channels/pos-entrada";
import { acelerarPipelineDeEventos } from "@/lib/dev/kick-local-pipeline";

/**
 * OS EFEITOS QUE TRANSFORMAM UMA MENSAGEM EM TRABALHO.
 *
 * ─── O defeito, medido em produção ──────────────────────────────────────────
 *
 *   ai_agent.dispatch_requested   QR 806   oficial 0
 *   leads a partir da conversa    QR  19   oficial 1  (em 28 conversas)
 *   contatos bloqueados por STOP           0 em 101
 *
 * Opt-out, nascimento do lead e despacho do agente moravam dentro de
 * `lib/waha/ingest.ts`. A pessoa que escrevia para o número oficial entrava no
 * CRM e parava ali: sem card no funil, sem agente, e — o pior — com o pedido de
 * "PARAR" evaporando num canal onde a plataforma cobra por mensagem e pune a
 * denúncia de spam.
 *
 * ─── Por que a maioria dos casos é sobre ORDEM ──────────────────────────────
 *
 * Os três efeitos rodam em sequência, e a sequência é regra de negócio:
 * inverter opt-out e lead faz quem pediu para sair virar card de oportunidade.
 * Uma troca de ordem não quebra tipo nem derruba nada em runtime — quebra em
 * silêncio, semanas depois. Só um teste que observe a ORDEM a segura.
 */

const audit = vi.fn(async () => {});
const garantirLeadDaConversa = vi.fn(async () => ({ criado: true, leadId: "lead-1" }) as never);

vi.mock("@/lib/audit", () => ({ audit: (...a: unknown[]) => audit(...(a as [])) }));
vi.mock("@/lib/leads/nascimento-do-lead", () => ({
  garantirLeadDaConversa: (...a: unknown[]) => garantirLeadDaConversa(...(a as [])),
}));
vi.mock("@/lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("@/lib/dev/kick-local-pipeline", () => ({
  acelerarPipelineDeEventos: vi.fn(async () => {}),
  kickLocalPipeline: vi.fn(async () => {}),
}));

/** A sequência do que ACONTECEU — é o que os casos de ordem inspecionam. */
let sequencia: string[] = [];
let updateErro: { message: string } | null = null;
let rpcErro: { message: string } | null = null;
let ultimoUpdate: Record<string, unknown> | null = null;
let ultimaRpc: Record<string, unknown> | null = null;
/** TODAS as chamadas de RPC, na ordem, com o NOME da função. */
let rpcChamadas: Array<{ nome: string; args: Record<string, unknown> }> = [];

/** Imita o builder do PostgREST: encadeável, o efeito acontece no `await`. */
function cadeia(rotulo: string): Record<string, unknown> {
  return new Proxy(
    {},
    {
      get(_t, prop) {
        if (prop === "then") {
          return (resolve: (v: unknown) => void) => {
            sequencia.push(rotulo);
            return Promise.resolve({ error: updateErro }).then(resolve);
          };
        }
        return () => cadeia(rotulo);
      },
    },
  ) as Record<string, unknown>;
}

const admin = {
  from(tabela: string) {
    return {
      update(payload: Record<string, unknown>) {
        ultimoUpdate = payload;
        return cadeia(`update:${tabela}`);
      },
    };
  },
  async rpc(nome: string, args: Record<string, unknown>) {
    rpcChamadas.push({ nome, args });
    ultimaRpc = args;
    sequencia.push(`rpc:${args.p_event_type ?? nome}`);
    return { error: rpcErro };
  },
} as never;

const ENTRADA: EntradaDeMensagem = {
  organizationId: "org-1",
  contactId: "contato-1",
  conversationId: "conversa-1",
  messageId: "msg-1",
  channelSessionId: "sessao-1",
  texto: "oi, tudo bem?",
  nomeDoContato: "Cliente",
  requestId: "req-1",
  origem: "canal_de_teste",
};

async function rodar(over: Partial<EntradaDeMensagem> = {}) {
  const { aplicarEfeitosPosEntrada } = await import("@/lib/channels/pos-entrada");
  await aplicarEfeitosPosEntrada(admin, { ...ENTRADA, ...over });
}

beforeEach(() => {
  sequencia = [];
  updateErro = null;
  rpcErro = null;
  ultimoUpdate = null;
  ultimaRpc = null;
  rpcChamadas = [];
  audit.mockClear();
  garantirLeadDaConversa.mockClear();
  garantirLeadDaConversa.mockResolvedValue({ criado: true, leadId: "lead-1" } as never);
  vi.mocked(acelerarPipelineDeEventos).mockClear();
});

describe("a ordem dos três efeitos", () => {
  it("opt-out acontece ANTES do nascimento do lead", async () => {
    // Esta é a razão de o arquivo existir. `garantirLeadDaConversa` RELÊ o
    // contato e recusa criar card para bloqueado — mas só se o bloqueio já
    // estiver gravado. Ao contrário, quem acabou de pedir para sair vira
    // oportunidade nova no funil, e ninguém olha um card para descobrir isso.
    let leadViuASequencia: string[] = [];
    garantirLeadDaConversa.mockImplementation(async () => {
      leadViuASequencia = [...sequencia];
      return { criado: true, leadId: "lead-1" } as never;
    });

    await rodar({ texto: "PARAR" });

    expect(leadViuASequencia, "o lead nasceu antes de o opt-out ser gravado").toContain(
      "update:contacts",
    );
  });

  it("o lead nasce ANTES de o agente ser acordado", async () => {
    // O turno do agente resolve o lead ativo do contato. Despachar primeiro faz
    // o primeiro turno rodar sem lead — exatamente o buraco que esta peça fecha.
    let leadJaTinhaNascido = false;
    garantirLeadDaConversa.mockImplementation(async () => {
      leadJaTinhaNascido = !sequencia.includes("rpc:ai_agent.dispatch_requested");
      return { criado: true, leadId: "lead-1" } as never;
    });

    await rodar();

    expect(leadJaTinhaNascido, "o despacho saiu antes do lead").toBe(true);
    expect(sequencia).toContain("rpc:ai_agent.dispatch_requested");
  });
});

describe("opt-out", () => {
  it("bloqueia o contato quando a mensagem pede para sair", async () => {
    await rodar({ texto: "quero PARAR de receber" });
    expect(ultimoUpdate).toMatchObject({ is_blocked: true, blocked_reason: "stop_keyword" });
  });

  it("NÃO bloqueia quem só escreveu uma palavra parecida", async () => {
    // Sem as bordas `\b`, "PARARÁ" e "SAIRÁ" bloqueariam o contato — e o cliente
    // deixaria de receber sem ter pedido nada. É o falso positivo que custa mais
    // caro dos dois, porque some em silêncio.
    await rodar({ texto: "amanhã ele sairá do escritório e pararão as obras" });
    expect(sequencia, "bloqueou por uma palavra que só CONTÉM o termo").not.toContain(
      "update:contacts",
    );
  });

  it.each([
    "tem como parar a dor?",
    "posso sair antes das 15h?",
    "preciso sair mais cedo da consulta",
    "quero parar o tratamento por enquanto",
    "dá pra parar o sangramento em casa?",
  ])("NÃO bloqueia quem usa a palavra falando de outra coisa: %s", async (texto) => {
    // A palavra ISOLADA não é o sinal — a INTENÇÃO de parar de receber mensagem é.
    // Medido numa clínica: "tem como parar a dor?" bloqueava o paciente na ingestão,
    // antes do modelo, e todo envio seguinte era vetado. Ele sumia sem ninguém ver.
    await rodar({ texto });
    expect(sequencia, `bloqueou "${texto}", que não é pedido de descadastro`).not.toContain(
      "update:contacts",
    );
  });

  it.each([
    "pode parar de mandar mensagem",
    "para de me mandar isso",
    "não quero mais receber nada de vocês",
    "me tira dessa lista",
    "quero cancelar a inscrição",
  ])("bloqueia o pedido de descadastro escrito por extenso: %s", async (texto) => {
    // O outro lado do mesmo defeito: a regex antiga só via a palavra solta, então
    // "não quero mais receber" — opt-out inequívoco — passava batido.
    await rodar({ texto });
    expect(ultimoUpdate, `não bloqueou "${texto}"`).toMatchObject({
      is_blocked: true,
      blocked_reason: "stop_keyword",
    });
  });

  it("mensagem sem texto não bloqueia ninguém", async () => {
    await rodar({ texto: null });
    expect(sequencia).not.toContain("update:contacts");
  });

  it("registra a auditoria do bloqueio", async () => {
    // É a linha que prova, depois, que o pedido chegou e foi respeitado.
    await rodar({ texto: "STOP" });
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "contact.blocked", organizationId: "org-1" }),
    );
  });

  it("falha ao gravar o bloqueio NÃO impede o resto da ingestão", async () => {
    // A mensagem já está gravada. Derrubar aqui devolveria 500 ao provider, que
    // reenviaria tudo — trocaria um efeito faltando por uma tempestade.
    updateErro = { message: "banco indisponível" };
    await rodar({ texto: "PARAR" });
    expect(garantirLeadDaConversa).toHaveBeenCalled();
    expect(sequencia).toContain("rpc:ai_agent.dispatch_requested");
  });
});

describe("despacho do agente", () => {
  it("emite com o payload que o consumidor lê, campo a campo", async () => {
    // O consumidor é UM só. Um payload por canal faria o worker adivinhar de
    // quem veio.
    await rodar();
    expect(ultimaRpc).toMatchObject({
      p_event_type: "ai_agent.dispatch_requested",
      p_entity_kind: "message",
      p_entity_id: "msg-1",
      p_organization_id: "org-1",
      p_payload: {
        organization_id: "org-1",
        conversation_id: "conversa-1",
        contact_id: "contato-1",
        channel_session_id: "sessao-1",
        inbound_message_id: "msg-1",
      },
    });
  });

  it("sem id de mensagem NÃO despacha", async () => {
    // Reentrega não gera linha nova. Despachar sem id faria o worker buscar uma
    // mensagem que não existe e marcar falha numa ingestão perfeita.
    await rodar({ messageId: null });
    expect(sequencia).not.toContain("rpc:ai_agent.dispatch_requested");
  });

  it("falha do emit não derruba a ingestão", async () => {
    rpcErro = { message: "rpc fora do ar" };
    await expect(rodar()).resolves.toBeUndefined();
  });
});

describe("nascimento do lead", () => {
  it("leva o nome do contato para batizar o card", async () => {
    await rodar({ nomeDoContato: "Marcela" });
    expect(garantirLeadDaConversa).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ nomeDoContato: "Marcela", conversationId: "conversa-1" }),
    );
  });

  it("exceção no nascimento não impede o despacho", async () => {
    garantirLeadDaConversa.mockRejectedValue(new Error("funil não configurado") as never);
    await rodar();
    expect(sequencia).toContain("rpc:ai_agent.dispatch_requested");
  });
});

/**
 * A fiação. Os casos acima provam que o passo compartido FAZ a coisa certa;
 * estes provam que os dois canais o CHAMAM — que é o defeito original.
 */
describe("os dois canais usam o mesmo passo", () => {
  const ZERNIO = readFileSync("lib/channels/zernio/ingest.ts", "utf8");
  const WAHA = readFileSync("lib/waha/ingest.ts", "utf8");
  const META = readFileSync("lib/channels/meta/ingest.ts", "utf8");

  it("o canal intermediado chama nos DOIS caminhos de inserção", () => {
    // A ingestão resolve a conversa por dois caminhos — thread conhecida e
    // âncora — e o primeiro é o mais comum. Chamar só no segundo deixaria a
    // maioria das mensagens sem nenhum dos três efeitos.
    const chamadas = [...ZERNIO.matchAll(/await efeitosDaEntrada\(/g)];
    expect(chamadas.length, "faltou o passo em um dos caminhos").toBe(2);
  });

  it("o canal intermediado só aplica os efeitos na ENTRADA", () => {
    // O eco de um envio nosso não pede para sair nem abre demanda.
    expect(ZERNIO).toMatch(/if \(msg\.direction !== "inbound"\) return;/);
  });

  it("o canal por QR delega no compartilhado em vez de reimplementar", () => {
    expect(WAHA).toMatch(/await aplicarEfeitosPosEntrada\(admin, \{/);
  });

  it("o canal oficial também acorda o follow-up no mesmo passo", () => {
    expect(META).toMatch(/await aplicarEfeitosPosEntrada\(admin, \{/);
  });

  it("e não guarda mais uma cópia privada da regra de opt-out", () => {
    // Duas cópias divergem na primeira vez que alguém acrescentar um termo — e
    // a que diverge é sempre a que ninguém lembra que existe.
    expect(WAHA, "o canal por QR voltou a ter regex própria de STOP").not.toMatch(
      /STOP\|PARAR\|SAIR\|UNSUBSCRIBE/,
    );
  });

  it("acorda o follow-up do contato ANTES do drain genérico", async () => {
    await rodar();
    expect(acelerarPipelineDeEventos).toHaveBeenCalledWith(
      admin,
      expect.objectContaining({
        organizationId: "org-1",
        contactId: "contato-1",
        messageId: "msg-1",
        texto: "oi, tudo bem?",
      }),
    );
  });

  it("avança o follow-up ANTES de acordar o agente", async () => {
    vi.mocked(acelerarPipelineDeEventos).mockImplementation(async () => {
      sequencia.push("acelerar-followup");
    });
    await rodar();
    const followup = sequencia.indexOf("acelerar-followup");
    const agente = sequencia.indexOf("rpc:ai_agent.dispatch_requested");
    expect(followup).toBeGreaterThanOrEqual(0);
    expect(agente).toBeGreaterThan(followup);
  });

  it("o vocabulário do opt-out vive num lugar só", () => {
    // O lugar mudou — de uma regex exportada daqui para o módulo de decisão
    // `lib/opt-out/deteccao.ts` — porque o runtime tinha a própria regra e a
    // divergência entre as duas era o defeito: a daqui, que grava o bloqueio,
    // era a mais grosseira das duas.
    const ingestao = readFileSync("lib/channels/pos-entrada.ts", "utf8");
    expect(ingestao).toMatch(/from "@\/lib\/opt-out\/deteccao"/);
    expect(ingestao, "a ingestão voltou a ter regra própria de opt-out").not.toMatch(
      /STOP\|PARAR\|SAIR\|UNSUBSCRIBE/,
    );
  });
});


/**
 * ─── A ORIGEM DA PÁGINA, NA CHEGADA PELO WHATSAPP (#924) ───────────────────
 *
 * Quem clica num anúncio e cai numa landing page chega ao WhatsApp com o texto
 * pré-preenchido do `wa.me`. Quem clica num anúncio que vai direto para o
 * WhatsApp chega com "Quero saber mais sobre X" -- e esse caso já tem atribuição
 * (a plataforma e o id do anúncio vêm no contexto do canal).
 *
 * A origem de SITE não tem esse transporte: o `wa.me` abre o app pelo sistema
 * operacional, sem cookie, sem referrer e sem sessão. A única coisa que
 * atravessa a fronteira é o TEXTO da primeira mensagem. Antes deste passo as
 * UTMs morriam na página, e a atribuição de quem veio do site ficava em branco.
 *
 * ─── Por que a POSIÇÃO do passo é vigiada aqui ──────────────────────────────
 *
 * O card COPIA a origem do contato no nascimento. Estampar depois do passo do
 * lead deixaria o card com a origem de sempre e o dado só no contato — que é
 * justamente onde ninguém olha. Opt-out continua em PRIMEIRO (LGPD: quem pediu
 * para sair tem de estar bloqueado antes de virar oportunidade).
 *
 * ─── O que este passo NÃO faz ────────────────────────────────────────────────
 *
 * Não sobrescreve primeiro toque (a guarda é da
 * `fn_estampar_atribuicao_de_anuncio`, no banco, e não é re-medida aqui), não
 * autoriza IA e não abre demanda. Falha para dentro, como os outros.
 */
describe("a origem da página que veio no texto", () => {
  /**
   * O contrato `[dk1:<base64url(JSON)>]` escrito AQUI de forma independente, com
   * o Buffer do Node. Se o codificador do lib divergir deste formato, este
   * arquivo continua medindo o que importa: o que a ingestão aceita.
   */
  const marcador = (utm: Record<string, string>) =>
    `[dk1:${Buffer.from(JSON.stringify(utm), "utf8").toString("base64url")}]`;

  const CODIGO = marcador({
    utm_source: "instagram",
    utm_medium: "social",
    utm_campaign: "pesquisa-preco",
    gclid: "Cj0KCQjw",
  });

  const nomesDeRpc = () => rpcChamadas.map((c) => c.nome);
  const indiceDoRpc = (nome: string) => rpcChamadas.findIndex((c) => c.nome === nome);

  it("estampa a origem no contato ANTES do card nascer", async () => {
    garantirLeadDaConversa.mockImplementationOnce(async () => {
      sequencia.push("lead:nascimento");
      return { criado: true, leadId: "lead-1" } as never;
    });

    await rodar({ texto: `oi! vi voces no site ${CODIGO}` });

    const i = indiceDoRpc("fn_estampar_atribuicao_de_anuncio");
    expect(i, "a origem da página não foi estampada no contato").toBeGreaterThanOrEqual(0);
    expect(
      sequencia.indexOf("lead:nascimento"),
      "o card nasceu antes da origem ser gravada",
    ).toBeGreaterThan(sequencia.indexOf("rpc:fn_estampar_atribuicao_de_anuncio"));
    expect(rpcChamadas[i]?.args).toMatchObject({
      p_contact: "contato-1",
      p_platform: "site",
      p_metadata: { ad_platform: "site", utm_source: "instagram", gclid: "Cj0KCQjw" },
    });
  });

  it("sem código no texto, nada é estampado", async () => {
    await rodar({ texto: "oi, tudo bem?" });
    expect(nomesDeRpc()).not.toContain("fn_estampar_atribuicao_de_anuncio");
  });

  it("marcador ilegível não estampa e não impede o card", async () => {
    await rodar({ texto: "oi [dk1:%%%%nao-e-carga%%%%]" });
    expect(nomesDeRpc()).not.toContain("fn_estampar_atribuicao_de_anuncio");
    expect(garantirLeadDaConversa).toHaveBeenCalled();
  });

  it("se o banco recusar a estampagem, os outros efeitos seguem", async () => {
    rpcErro = { message: "permission denied" };
    await rodar({ texto: `oi ${CODIGO}` });
    expect(nomesDeRpc()).toContain("fn_estampar_atribuicao_de_anuncio");
    expect(garantirLeadDaConversa).toHaveBeenCalled();
    expect(vi.mocked(acelerarPipelineDeEventos)).toHaveBeenCalled();
  });
});
