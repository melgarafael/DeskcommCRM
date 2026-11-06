/**
 * O NÚMERO DE AVISO QUE É DE UM MEMBRO DA EQUIPE — E QUE TAMBÉM É CLIENTE (#3900).
 *
 * ─── O defeito, na voz de quem pediu ────────────────────────────────────────
 *
 * Agência de viagens: a equipe viaja pela própria agência, então o WhatsApp
 * pessoal de cada atendente é TAMBÉM um contato do CRM. No modo `responsavel`
 * o aviso sai para esse número — e, ao confirmar `aviso_numero_de_cliente`, o
 * número virava INTERNO: quando ela mesma viajava e escrevia como cliente, a
 * mensagem não virava contato, conversa nem atendimento.
 *
 * ─── O que este arquivo mede ───────────────────────────────────────────────
 *
 * 1. A REGRA: destino em `responsavel` que é o WhatsApp de um membro ATIVO não
 *    é interno. `fixo` não muda — ali o número da empresa continua interno.
 * 2. O CORTE DA INGESTÃO: mensagem comum desse número NÃO é consumida, e é
 *    isso que a deixa virar contato e conversa como a de qualquer cliente.
 * 3. O QUE NÃO PODE CAIR JUNTO: comando `RESPONDER` continua sendo resposta de
 *    caso, o eco do envio continua cortado, e cliente comum que é destino do
 *    aviso continua sem entrar.
 *
 * ─── SABOTAGEM (prova de que os casos medem o que dizem medir) ─────────────
 *
 * · `destinoDoAvisoEhDeMembroDaEquipe` devolvendo `true` sempre → o caso do
 *   cliente comum cai (a mensagem dele passaria a entrar);
 * · tirar a exceção de `consumirComResultado` → os casos de entrada caem e a
 *   mensagem da atendente volta a sumir;
 * · tirar o `&& !comando` → o caso do `RESPONDER` cai (o comando vira mensagem
 *   de cliente e o caso nunca é respondido);
 * · aceitar `direction === "outbound"` na exceção → o caso do eco cai.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

import {
  destinoDoAvisoEhDeMembroDaEquipe,
  ehContatoDoNumeroInterno,
  ehNumeroInternoDeAviso,
  lerNumeroInternoDeAviso,
  limparCacheDoNumeroInterno,
} from "@/lib/escalacao/numero-interno-de-aviso";
import { consumirComResultado } from "@/lib/escalacao/resposta-whatsapp-ao-caso";

const ORG = "11111111-1111-4111-8111-111111111111";
const ORG_VIZINHA = "22222222-2222-4222-8222-222222222222";
const SESSION = "33333333-3333-4333-8333-333333333333";
const CONTATO = "44444444-4444-4444-8444-444444444444";
const CASE = "02920000-5555-4000-8000-000000000001";

/** O celular pessoal da atendente — cadastrado em `user_organizations` e contato. */
const NUMERO_DA_MEMBRO = "+5531998887777";
/** A outra grafia do nono dígito do MESMO número. */
const NUMERO_DA_MEMBRO_SEM_NOVE = "+553198887777";
/** Um cliente comum, que não é de ninguém da equipe. */
const NUMERO_DE_CLIENTE = "+5531977776666";

const mocks = vi.hoisted(() => ({
  send: vi.fn(async () => ({ externalId: "sent-ack" })),
  decide: vi.fn(async () => ({ liberado: true as const })),
  register: vi.fn(async () => undefined),
  config: vi.fn(async () => true),
  resolve: vi.fn(async () => ({ to: "+5531998887777" })),
  audit: vi.fn(async () => undefined),
}));

vi.mock("@/lib/audit", () => ({ audit: mocks.audit }));
vi.mock("@/lib/escalacao/aviso-ao-suporte.handler", () => ({
  criarTransporteDoAviso: async () => ({
    configurado: mocks.config,
    resolveDestino: mocks.resolve,
    envia: mocks.send,
  }),
}));
vi.mock("@/lib/agent-engine/pacing/ledger-supabase", () => ({
  criarPacingDoCanal: async () => ({ decide: mocks.decide, registraEnvio: mocks.register }),
}));
vi.mock("@/lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

/**
 * O banco, na forma mínima que as duas leituras usam: `config_aviso_de_caso`
 * pelo `maybeSingle` e `user_organizations` pelo builder aguardável (a leitura
 * é uma lista, não uma linha).
 */
function dbDeAviso(opcoes: {
  modo?: "fixo" | "responsavel" | null;
  destino?: string;
  whatsapps?: Array<string | null>;
  membrosAtivos?: boolean;
  enabled?: boolean;
}) {
  const destino = opcoes.destino ?? NUMERO_DA_MEMBRO;
  const leituras: string[] = [];
  /** `[tabela, coluna, valor]` de cada `.eq` — é por aqui que o filtro de organização é medido. */
  const filtros: Array<[string, string, unknown]> = [];
  const rpc = vi.fn(async (nome: string) => ({
    data: nome === "fn_responder_caso_por_whatsapp" ? "accepted" : null,
    error: null,
  }));

  const from = vi.fn((tabela: string) => {
    leituras.push(tabela);
    const resposta = () => {
      if (tabela === "config_aviso_de_caso") {
        return {
          data: {
            telefone_destino: destino,
            destino_jid: null,
            resposta_whatsapp_habilitada: opcoes.enabled ?? true,
            channel_session_id: SESSION,
            destino_modo: opcoes.modo === undefined ? "fixo" : opcoes.modo,
          },
          error: null,
        };
      }
      if (tabela === "user_organizations") {
        if (opcoes.membrosAtivos === false) return { data: [], error: null };
        return { data: (opcoes.whatsapps ?? []).map((w) => ({ whatsapp_e164: w })), error: null };
      }
      if (tabela === "contacts") {
        // O cinto de segurança pergunta pela ficha do contato.
        return { data: { phone_number: destino, wa_lid: null }, error: null };
      }
      return { data: null, error: null };
    };
    const builder: Record<string, unknown> = {};
    builder.select = () => builder;
    builder.eq = (coluna: string, valor: unknown) => {
      filtros.push([tabela, coluna, valor]);
      return builder;
    };
    builder.is = () => builder;
    builder.not = () => builder;
    builder.update = () => builder;
    builder.maybeSingle = async () => resposta();
    // O builder do PostgREST é aguardável: `await select()` devolve a lista.
    builder.then = (resolver: (x: unknown) => unknown, rejeitar?: (e: unknown) => unknown) =>
      Promise.resolve(resposta()).then(resolver, rejeitar);
    return builder;
  });

  return { rpc, from, db: { rpc, from } as unknown as SupabaseClient, leituras, filtros };
}

function entrada(texto: string | null, direcao: "inbound" | "outbound" = "inbound") {
  return {
    organizationId: ORG,
    channelSessionId: SESSION,
    identidade: { kind: "phone" as const, phone: NUMERO_DA_MEMBRO, lid: null },
    direction: direcao,
    texto,
    externalId: "msg-1",
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  limparCacheDoNumeroInterno();
  mocks.decide.mockResolvedValue({ liberado: true });
});

describe("destinoDoAvisoEhDeMembroDaEquipe — a regra pura", () => {
  const base = { destino: NUMERO_DA_MEMBRO, jid: null };

  it("responsavel + destino no WhatsApp do membro ⇒ o número NÃO é interno", () => {
    expect(
      destinoDoAvisoEhDeMembroDaEquipe({
        ...base,
        destinoModo: "responsavel",
        whatsappsDaEquipe: [NUMERO_DA_MEMBRO],
      }),
    ).toBe(true);
  });

  it("casa a OUTRA grafia do nono dígito — a mesma pessoa, dois cadastros", () => {
    // É o cadastro mais comum: o destino gravado com o 9 e o perfil sem (ou o
    // contrário). Comparar string crua erraria justamente aqui.
    expect(
      destinoDoAvisoEhDeMembroDaEquipe({
        ...base,
        destino: NUMERO_DA_MEMBRO_SEM_NOVE,
        destinoModo: "responsavel",
        whatsappsDaEquipe: [NUMERO_DA_MEMBRO],
      }),
    ).toBe(true);
  });

  it("em `fixo` o número da empresa continua interno — a exceção é do modo responsavel", () => {
    // Sem esta guarda, toda instalação com o número do plantão na lista de
    // membros perderia o corte que ela tem hoje.
    expect(
      destinoDoAvisoEhDeMembroDaEquipe({
        ...base,
        destinoModo: "fixo",
        whatsappsDaEquipe: [NUMERO_DA_MEMBRO],
      }),
    ).toBe(false);
    expect(
      destinoDoAvisoEhDeMembroDaEquipe({ ...base, whatsappsDaEquipe: [NUMERO_DA_MEMBRO] }),
    ).toBe(false);
  });

  it("destino que não é de ninguém da equipe continua interno", () => {
    expect(
      destinoDoAvisoEhDeMembroDaEquipe({
        ...base,
        destino: NUMERO_DE_CLIENTE,
        destinoModo: "responsavel",
        whatsappsDaEquipe: [NUMERO_DA_MEMBRO],
      }),
    ).toBe(false);
  });

  it("a lista não lida (null) não é exceção para ninguém", () => {
    expect(
      destinoDoAvisoEhDeMembroDaEquipe({
        ...base,
        destinoModo: "responsavel",
        whatsappsDaEquipe: null,
      }),
    ).toBe(false);
  });
});

describe("lerNumeroInternoDeAviso — o que a leitura quente carrega", () => {
  it("em `responsavel` lê o modo e os WhatsApps da equipe", async () => {
    const { db } = dbDeAviso({ modo: "responsavel", whatsapps: [NUMERO_DA_MEMBRO, null] });
    const cfg = await lerNumeroInternoDeAviso(db, ORG);
    expect(cfg.destinoModo).toBe("responsavel");
    expect(cfg.whatsappsDaEquipe).toEqual([NUMERO_DA_MEMBRO]);
  });

  it("em `fixo` NÃO consulta a equipe — quem nunca escolheu o modo novo não paga a leitura", async () => {
    const { db, leituras } = dbDeAviso({ modo: "fixo", whatsapps: [NUMERO_DA_MEMBRO] });
    await lerNumeroInternoDeAviso(db, ORG);
    expect(leituras).not.toContain("user_organizations");
  });

  it("a leitura continua por organização: as duas consultas filtram pela org de quem pergunta", async () => {
    // O dublê não separa tenants sozinho: o que se mede é o FILTRO que a consulta
    // leva. Sem o `.eq("organization_id", …)` em `user_organizations`, o membro de
    // uma organização viraria exceção na ingestão da outra.
    const { db, leituras, filtros } = dbDeAviso({ modo: "responsavel", whatsapps: [NUMERO_DA_MEMBRO] });
    await lerNumeroInternoDeAviso(db, ORG_VIZINHA);
    expect(leituras).toEqual(["config_aviso_de_caso", "user_organizations"]);
    for (const tabela of ["config_aviso_de_caso", "user_organizations"]) {
      expect(filtros).toContainEqual([tabela, "organization_id", ORG_VIZINHA]);
    }
    expect(filtros.filter(([, coluna, valor]) => coluna === "organization_id" && valor !== ORG_VIZINHA)).toEqual([]);
  });

  it("falha ao ler os membros NÃO inventa a exceção: o destino segue interno", async () => {
    // A exceção é uma AFIRMAÇÃO sobre quem é o número. Sem a leitura, ela não
    // pode ser feita — e o desfecho é o de hoje, com o log dizendo que a
    // exceção não pôde ser aplicada.
    const builder = {
      select: () => builder,
      eq: () => builder,
      is: () => builder,
      not: () => builder,
      maybeSingle: async () => ({
        data: {
          telefone_destino: NUMERO_DA_MEMBRO,
          destino_jid: null,
          resposta_whatsapp_habilitada: true,
          channel_session_id: SESSION,
          destino_modo: "responsavel",
        },
        error: null,
      }),
      then: (resolver: (x: unknown) => unknown) =>
        Promise.resolve({ data: null, error: { message: "boom" } }).then(resolver),
    };
    const db = { from: () => builder } as unknown as SupabaseClient;
    expect(
      await ehNumeroInternoDeAviso(db, ORG, { kind: "phone", phone: NUMERO_DA_MEMBRO, lid: null }),
    ).toBe(true);
  });
});

describe("ehContatoDoNumeroInterno — o cinto de segurança", () => {
  it("responsavel + destino de membro ⇒ NÃO é número interno", async () => {
    const { db } = dbDeAviso({ modo: "responsavel", whatsapps: [NUMERO_DA_MEMBRO] });
    expect(await ehContatoDoNumeroInterno(db, ORG, CONTATO)).toBe(false);
  });

  it("responsavel + destino de cliente comum ⇒ continua interno", async () => {
    const { db } = dbDeAviso({
      modo: "responsavel",
      destino: NUMERO_DE_CLIENTE,
      whatsapps: [NUMERO_DA_MEMBRO],
    });
    expect(await ehContatoDoNumeroInterno(db, ORG, CONTATO)).toBe(true);
  });

  it("`fixo` com o número do plantão ⇒ continua interno, como hoje", async () => {
    const { db } = dbDeAviso({ modo: "fixo", whatsapps: [NUMERO_DA_MEMBRO] });
    expect(await ehContatoDoNumeroInterno(db, ORG, CONTATO)).toBe(true);
  });
});

describe("consumirComResultado — o que a ingestão faz com a mensagem", () => {
  it("mensagem comum do número do membro NÃO é consumida: ela entra como cliente", async () => {
    // `consumed: false` é o que devolve a mensagem ao caminho normal do
    // ingestor, que segue para o upsert de contato e conversa. É o CORAÇÃO do
    // #3900: hoje esta mensagem é descartada.
    const { db } = dbDeAviso({ modo: "responsavel", whatsapps: [NUMERO_DA_MEMBRO] });
    const resultado = await consumirComResultado(db, entrada("oi, preciso remarcar minha viagem"));
    expect(resultado).toEqual({ consumed: false, result: null });
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it("cliente comum que é destino do aviso continua cortado", async () => {
    const { db } = dbDeAviso({
      modo: "responsavel",
      destino: NUMERO_DE_CLIENTE,
      whatsapps: [NUMERO_DA_MEMBRO],
    });
    const resultado = await consumirComResultado(
      db,
      {
        ...entrada("bom dia"),
        identidade: { kind: "phone", phone: NUMERO_DE_CLIENTE, lid: null },
      },
    );
    expect(resultado).toEqual({ consumed: true, result: null });
  });

  it("`fixo`: o número do plantão continua cortado, mesmo com ele na lista de membros", async () => {
    const { db } = dbDeAviso({ modo: "fixo", whatsapps: [NUMERO_DA_MEMBRO] });
    expect(await consumirComResultado(db, entrada("ok"))).toEqual({
      consumed: true,
      result: null,
    });
  });

  it("`RESPONDER` do número do membro continua sendo resposta de caso", async () => {
    const { db } = dbDeAviso({ modo: "responsavel", whatsapps: [NUMERO_DA_MEMBRO] });
    const resultado = await consumirComResultado(db, entrada(`RESPONDER ${CASE} resolvido`));
    expect(resultado).toEqual({ consumed: true, result: "accepted" });
    expect(mocks.send).toHaveBeenCalledTimes(1);
  });

  it("o ECO do envio continua cortado — o aviso não cria conversa consigo mesmo", async () => {
    const { db } = dbDeAviso({ modo: "responsavel", whatsapps: [NUMERO_DA_MEMBRO] });
    const resultado = await consumirComResultado(db, entrada("aviso de caso", "outbound"));
    expect(resultado).toEqual({ consumed: true, result: null });
  });

  it("a equipe sem número não abre exceção nenhuma", async () => {
    const { db } = dbDeAviso({ modo: "responsavel", whatsapps: [] });
    expect(await consumirComResultado(db, entrada("bom dia"))).toEqual({
      consumed: true,
      result: null,
    });
  });
});
