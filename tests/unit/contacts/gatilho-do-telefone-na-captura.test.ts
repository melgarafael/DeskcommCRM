import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * #3283 — A CAPTURA AUTOMÁTICA DE TELEFONE EMITE `contact.phone_added`.
 *
 * O PATCH da ficha emite o gatilho (`app/api/v1/contacts/_handler.ts`) desde a
 * #2812. O OUTRO caminho que faz a MESMA transição — o telefone que a captura
 * automática grava quando a ficha está sem número e a opção da organização está
 * ligada (`gravarTelefoneDeFichaVazia`, #2593) — ficava MUDO: a regra "Quando um
 * contato ganhar um telefone" não rodava por ali, sem run, sem erro e sem nada
 * na tela. Um gatilho que existe em um dos dois caminhos de um mesmo fato é a
 * promessa que o produto quebra sem avisar.
 *
 * Os dois caminhos são medidos AQUI, contra o MESMO dublê de `emit_event`, por
 * três razões que um caso isolado não dá:
 *
 *   1. o PAYLOAD é o do PATCH, sem campo novo: quem escreve a regra lê
 *      `{{phone_number}}` nos dois, e um payload "melhorado" com nome próprio
 *      faria a regra funcionar num caminho e não no outro;
 *   2. a ORDEM (grava, depois anuncia) é a mesma nos dois — emitir antes
 *      entrega à regra um contato ainda sem número, e `checarGuardasDeContato`
 *      mata com `no_phone` sem nova tentativa: o defeito é MUDO;
 *   3. os DESFECHOS que NÃO são ganho de telefone (troca, corrida perdida, erro
 *      de banco, opção desligada) continuam sem emitir nada. Um evento a mais
 *      enche a fila de automação com o que não aconteceu.
 *
 * O dublê do `@/lib/supabase/admin` é o mesmo dos dois caminhos porque o
 * `contact.phone_added` é reservado ao servidor pelo `emit_event` (0670:
 * `auth.uid()` não nulo → 42501) — quem o emite é o client de serviço.
 */

const auditSpy = vi.fn(async (_entrada: unknown) => undefined);
vi.mock("@/lib/audit", () => ({
  audit: auditSpy,
  isServiceRoleConfigured: () => false,
  hashEmail: (e: string) => e,
}));

/** Ordem GLOBAL das escritas observadas: o UPDATE e o emit caem aqui em sequência. */
let ordem: string[];
/** Cada `emit_event` mandado pelos dois caminhos, com o payload — o que se afirma. */
let emitidos: Array<Record<string, unknown>>;

const adminFalso = {
  rpc: (fn: string, args: Record<string, unknown>) => {
    expect(fn).toBe("emit_event");
    ordem.push("emit:" + String(args.p_event_type));
    emitidos.push(args);
    return { then: (r: (v: unknown) => unknown) => r({ error: null }) };
  },
};

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => adminFalso,
}));

const ORG = "9a0b7e00-0000-4000-8000-000000000001";
const CONTATO = "b1a0b7e0-0000-4000-8000-000000000002";
const USUARIO = "b1a0b7e0-0000-4000-8000-0000000000a1";
/** O negócio ABERTO da pessoa — onde o rastro do telefone é pendurado. */
const LEAD = "c2b0b7e0-0000-4000-8000-000000000003";
const PIPELINE = "d3b0b7e0-0000-4000-8000-000000000004";

/** O E.164 do número que a captura grava — o MESMO literal dos dois caminhos. */
const TELEFONE = "+5511911112222";

type Linha = Record<string, unknown>;

/** Os eventos de telefone emitidos, na ordem em que saíram. */
const telefoneEmitidos = () =>
  emitidos.filter((e) => e.p_event_type === "contact.phone_added");

beforeEach(() => {
  auditSpy.mockClear();
  ordem = [];
  emitidos = [];
});

// ---------------------------------------------------------------------------
// O CAMINHO DA CAPTURA AUTOMÁTICA
// ---------------------------------------------------------------------------

/**
 * O dublê do `proporDadoDoContato`: a ficha do contato, o interruptor da
 * organização, o roteamento contato→negócio do rastro e as três escritas
 * possíveis (o UPDATE condicional, o INSERT da proposta e a atividade). Ele
 * precisa enxergar qual delas aconteceu — é a prova dos casos que NÃO emitem.
 */
function dbDaCaptura(
  contato: Linha,
  opcao: {
    linhasAtualizadas?: number;
    erroNoUpdate?: { code?: string; message: string };
    settings?: unknown;
  } = {},
) {
  const atualizacoes: Array<{ patch: Linha; filtros: Record<string, unknown> }> = [];
  const inseridas: Linha[] = [];

  const db = {
    from(tabela: string) {
      if (tabela === "contacts") {
        return {
          select: () => {
            const cadeia = {
              eq: () => cadeia,
              maybeSingle: async () => ({ data: contato, error: null }),
            };
            return cadeia;
          },
          update: (patch: Linha) => {
            const filtros: Record<string, unknown> = {};
            const cadeia = {
              eq: (coluna: string, valor: unknown) => {
                filtros[coluna] = valor;
                return cadeia;
              },
              is: (coluna: string, valor: unknown) => {
                filtros[`${coluna} IS`] = valor;
                return cadeia;
              },
              select: async () => {
                ordem.push("update:contacts");
                atualizacoes.push({ patch, filtros });
                if (opcao.erroNoUpdate) return { data: null, error: opcao.erroNoUpdate };
                const travou = filtros["phone_number IS"] === null;
                const linhas = travou ? (opcao.linhasAtualizadas ?? 1) : 0;
                return { data: linhas > 0 ? [{ id: contato.id }] : [], error: null };
              },
            };
            return cadeia;
          },
        };
      }
      if (tabela === "organizations") {
        return {
          select: () => {
            const cadeia = {
              eq: () => cadeia,
              maybeSingle: async () => ({ data: { settings: opcao.settings ?? null }, error: null }),
            };
            return cadeia;
          },
        };
      }
      if (tabela === "crm_leads") {
        return {
          select: () => {
            const cadeia = {
              // O roteamento contato→negócio é aguardado DIRETO (`Promise.all`),
              // sem `maybeSingle`: o último `eq` devolve a promessa de verdade.
              eq: () => ({
                eq: async () => ({
                  data: [
                    {
                      id: LEAD,
                      organization_id: ORG,
                      pipeline_id: PIPELINE,
                      status: "open",
                      last_activity_at: null,
                      created_at: "2026-10-01T00:00:00.000Z",
                    },
                  ],
                  error: null,
                }),
              }),
            };
            return cadeia;
          },
        };
      }
      if (tabela === "crm_pipelines") {
        return {
          select: () => {
            const cadeia = {
              eq: () => cadeia,
              limit: () => cadeia,
              maybeSingle: async () => ({ data: { id: PIPELINE }, error: null }),
            };
            return cadeia;
          },
        };
      }
      if (tabela === "crm_lead_activities") {
        return { insert: async () => ({ error: null }) };
      }
      return {
        insert: (linha: Linha) => {
          inseridas.push(linha);
          return {
            select: () => ({ single: async () => ({ data: { id: "proposta-1" }, error: null }) }),
          };
        },
      };
    },
  };
  return { db: db as never, atualizacoes, inseridas };
}

const FICHA_VAZIA: Linha = {
  id: CONTATO,
  is_anonymized: false,
  email: null,
  name: null,
  phone_number: null,
  birthdate: null,
  consent: {},
};

/** O `settings` de quem LIGOU a opção — o único estado em que a captura grava. */
const OPCAO_LIGADA = { crm: { telefone_de_ficha_vazia: true } };

async function capturar(
  valor = "(11) 91111-2222",
  opcao: Parameters<typeof dbDaCaptura>[1] = { settings: OPCAO_LIGADA },
  contato: Linha = FICHA_VAZIA,
) {
  const { proporDadoDoContato } = await import("@/lib/contacts/proposta-de-dado");
  const falso = dbDaCaptura({ ...contato }, opcao);
  const r = await proporDadoDoContato(falso.db, {
    organizationId: ORG,
    contactId: CONTATO,
    campo: "phone_number",
    valor,
    trecho: `meu número é ${valor}`,
  });
  return { r, ...falso };
}

describe("captura automática — o gatilho que faltava (#3283)", () => {
  it("o instrumento está vivo — sem isto, todo caso abaixo passa medindo nada", async () => {
    await capturar();
    expect(telefoneEmitidos().length, "nenhum emit foi observado").toBeGreaterThan(0);
  });

  it("⭐ a ficha sem número que a captura grava → emite UMA vez, com o número no payload", async () => {
    const { r } = await capturar();

    // O desfecho da ESCRITA continua o mesmo: gravou sozinho, não virou fila.
    expect(r).toEqual({ criada: false, motivo: "aplicado_automaticamente", telefone: TELEFONE });

    const eventos = telefoneEmitidos();
    expect(eventos).toHaveLength(1);
    expect(eventos[0]).toMatchObject({
      p_event_type: "contact.phone_added",
      p_entity_kind: "contact",
      p_entity_id: CONTATO,
      p_payload: { phone_number: TELEFONE },
      p_organization_id: ORG,
    });
    // O PAYLOAD é o do PATCH, chave por chave: a regra escrita numa tela lê o
    // mesmo `{{phone_number}}` nos dois caminhos.
    expect(Object.keys(eventos[0]!.p_payload as Linha)).toEqual(["phone_number"]);
    // O ATOR diz que quem gravou foi a captura automática — não uma pessoa e
    // não uma regra.
    expect(eventos[0]!.p_metadata).toMatchObject({
      actor_kind: "system",
      source: "telefone-de-ficha-vazia",
    });
  });

  it("⭐ o evento sai DEPOIS do UPDATE que grava o número", async () => {
    await capturar();

    expect(ordem).toContain("update:contacts");
    expect(ordem).toContain("emit:contact.phone_added");
    expect(
      ordem.indexOf("update:contacts"),
      "o emit veio ANTES da gravação — a regra leria a ficha ainda sem o número, e `checarGuardasDeContato` a mataria com `no_phone`",
    ).toBeLessThan(ordem.indexOf("emit:contact.phone_added"));
  });

  it("o evento NÃO leva `caused_by_rule`: a regra que ele acorda tem de rodar", async () => {
    await capturar();

    const evento = telefoneEmitidos()[0]!;
    const metadata = evento.p_metadata as Linha;
    // O anti-laço do motor (`lib/automation/engine.ts`) pula evento com
    // `caused_by_rule` OU `request_id` prefixado `rule:`. A captura é um fato do
    // mundo, não uma regra falando consigo mesma: marcar isso aqui faria o
    // conserto nascer morto — o gatilho sairia e a regra seria pulada em
    // silêncio, que é o defeito que esta entrega existe para encerrar.
    expect(metadata.caused_by_rule).toBeUndefined();
    expect(String(metadata.request_id ?? "").startsWith("rule:")).toBe(false);
  });

  it("a corrida perdida (0 linhas) NÃO emite — e a informação vira proposta", async () => {
    const { r, inseridas, atualizacoes } = await capturar("(11) 91111-2222", {
      settings: OPCAO_LIGADA,
      linhasAtualizadas: 0,
    });

    expect(atualizacoes).toHaveLength(1);
    expect(telefoneEmitidos(), "anunciar uma gravação que o banco recusou").toHaveLength(0);
    expect(r.criada, JSON.stringify(r)).toBe(true);
    expect(inseridas).toHaveLength(1);
  });

  it("o erro de banco no UPDATE NÃO emite", async () => {
    const { r } = await capturar("(11) 91111-2222", {
      settings: OPCAO_LIGADA,
      erroNoUpdate: { code: "23505", message: "duplicate key value violates unique constraint" },
    });

    expect(telefoneEmitidos(), "o número é de OUTRO contato — nada foi gravado aqui").toHaveLength(0);
    expect(r.criada, JSON.stringify(r)).toBe(true);
  });

  it("com a opção DESLIGADA nem se grava nem se emite", async () => {
    const { atualizacoes } = await capturar("(11) 91111-2222", { settings: {} });

    expect(atualizacoes, "desligada, o cadastro não pode ser tocado").toHaveLength(0);
    expect(telefoneEmitidos()).toHaveLength(0);
  });

  it("quem JÁ tinha número não passou pela captura — e nada é emitido", async () => {
    await capturar("(11) 91111-2222", { settings: OPCAO_LIGADA }, {
      ...FICHA_VAZIA,
      phone_number: "+5511933334444",
    });

    expect(telefoneEmitidos()).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// O CAMINHO DO PATCH DA FICHA (o outro lado, no MESMO dublê)
// ---------------------------------------------------------------------------

/** O contato como ele está no banco ANTES do PATCH. */
let estadoAtual: Linha;

/**
 * O client de mentira do `patchContactHandler`: um SELECT de pré-condição, um
 * UPDATE com retorno e `rpc` para o `contact.updated`. O `contact.phone_added`
 * sai pelo `createAdminClient()`, mockado no topo — é o mesmo dublê que o
 * caminho da captura usa.
 */
function clienteDoPatch(): unknown {
  return {
    from: () => ({
      select: () => {
        const cadeia = {
          eq: () => cadeia,
          maybeSingle: async () => ({ data: estadoAtual, error: null }),
        };
        return cadeia;
      },
      update: (patch: Linha) => {
        const cadeia = {
          eq: () => cadeia,
          select: () => cadeia,
          maybeSingle: async () => {
            ordem.push("update:contacts");
            return { data: { ...estadoAtual, ...patch }, error: null };
          },
        };
        return cadeia;
      },
    }),
    rpc: (_fn: string, args: Record<string, unknown>) => {
      ordem.push("emit:" + String(args.p_event_type));
      emitidos.push(args);
      return { then: (r: (v: unknown) => unknown) => r({ error: null }) };
    },
  };
}

async function patch(input: Linha): Promise<Linha> {
  const { patchContactHandler } = await import("@/app/api/v1/contacts/_handler");
  return (await patchContactHandler(
    clienteDoPatch() as never,
    { organization_id: ORG, actor: { type: "user", id: USUARIO }, requestId: "req-1" },
    CONTATO,
    input as never,
  )) as unknown as Linha;
}

describe("o PATCH da ficha segue emitindo o MESMO gatilho", () => {
  beforeEach(() => {
    estadoAtual = {
      id: CONTATO,
      organization_id: ORG,
      is_anonymized: false,
      tags: [],
      email: "cliente@exemplo.com",
      phone_number: null,
      name: "Cliente",
      display_name: "Cliente",
      consent: {},
    };
  });

  it("⭐ ficha sem número que ganha um → emite UMA vez, com o payload do PATCH (sem campo novo)", async () => {
    await patch({ phone_number: TELEFONE });

    const eventos = telefoneEmitidos();
    expect(eventos).toHaveLength(1);
    expect(eventos[0]).toMatchObject({
      p_event_type: "contact.phone_added",
      p_entity_kind: "contact",
      p_entity_id: CONTATO,
      p_payload: { phone_number: TELEFONE },
      p_organization_id: ORG,
    });
    // A MESMA régua do caminho da captura: um payload só com `phone_number`.
    expect(Object.keys(eventos[0]!.p_payload as Linha)).toEqual(["phone_number"]);
    // O ator do PATCH é o de sempre — pessoa, com o request do turno.
    expect(eventos[0]!.p_metadata).toMatchObject({ actor_type: "user", request_id: "req-1" });
  });

  it("⭐ o evento do PATCH também sai DEPOIS do UPDATE", async () => {
    await patch({ phone_number: TELEFONE });

    expect(ordem).toContain("update:contacts");
    expect(ordem.indexOf("update:contacts")).toBeLessThan(
      ordem.indexOf("emit:contact.phone_added"),
    );
  });

  it("quem JÁ tinha número (troca) e quem PERDE o número → NADA sai", async () => {
    estadoAtual.phone_number = "+5511933334444";
    await patch({ phone_number: TELEFONE });
    expect(telefoneEmitidos()).toHaveLength(0);

    await patch({ phone_number: null });
    expect(telefoneEmitidos()).toHaveLength(0);
  });
});
