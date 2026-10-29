/**
 * O NASCIMENTO DA PROPOSTA DE CAMPO DO CARD (issue #3316).
 *
 * São DUAS as fronteiras que este arquivo confere, porque as duas já doeram em
 * produtos parecidos:
 *
 *  1. A da GRAVAÇÃO — `proporCamposDoNegocio` NUNCA toca em
 *     `crm_leads.custom_fields`. O dublê instrumenta o `update` de `crm_leads`
 *     e o teste o cobra: sem a fila de confirmação, um voucher com o hotel errado
 *     viraria card errado sem ninguém ver.
 *  2. A do FUNIL — a proposta é SÓ para `pipeline.settings.fields` (os campos do
 *     CARD, escopo `negocio`): chave fora do funil, campo de escopo `contato`,
 *     fora da lista de opções, fora do `padrao` (#2730) e sem trecho de origem
 *     não nascem — cada um com seu motivo, que é o que a ferramenta devolve ao
 *     modelo para ele aprender.
 *
 * O cliente fake de Supabase é o mesmo desenho de
 * `lib/contacts/proposta-de-dado.test.ts`: as recusas dependem de estado (o
 * negócio existe? o funil declara o campo? o valor já está no card?), e sem
 * dublê elas só seriam exercitáveis contra um banco — o que deixaria este
 * arquivo mudo na máquina de quem roda `pnpm test:unit` sem Docker.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";

import {
  confereCampoLido,
  proporCamposDoNegocio,
  propostaVencida,
  valorDoTipoAceitavel,
  vencePropostasDeCampo,
} from "./proposta-de-campos-por-documento";
import type { CustomFieldDef } from "@/lib/schemas/settings";

type Linha = Record<string, unknown>;

const ORG = "9a0b7e00-0000-4000-8000-000000000001";
const LEAD = "c2b0b7e0-0000-4000-8000-000000000003";
const PIPELINE = "d3b0b7e0-0000-4000-8000-000000000004";

/** Um funil de pós-venda de viagens — o cenário da issue. */
const FUNIL = {
  fields: [
    { key: "localizador", label: "Localizador", type: "text", padrao: "^[A-Z0-9]{6}$" },
    {
      key: "destino",
      label: "Destino",
      type: "select",
      options: [
        { value: "maceio-al", label: "Maceió (AL)" },
        { value: "gramado", label: "Gramado" },
      ],
    },
    { key: "ida", label: "Data de ida", type: "date" },
    { key: "valor_passagem", label: "Valor da passagem", type: "number" },
    // Escopo CONTATO (#2791): existe no funil, mas o valor mora na ficha.
    { key: "nome_passageiro", label: "Nome do passageiro", type: "text", escopo: "contato" },
  ],
};

/**
 * O mínimo que a régua encosta: lê o negócio, lê o funil e insere na fila.
 * Qualquer `update` em `crm_leads` é capturado — é a asserção de que nada grava
 * no card sem confirmação humana.
 */
function dbFalso(opcoes: {
  lead: Linha | null;
  settings?: unknown;
  erroNoInsert?: { code?: string };
  /**
   * A proposta PENDENTE que já ocupa a chave (o `23505` do índice único
   * parcial). Só é consultada no caminho de colisão: é lá que se distingue
   * "já existe" de "existe uma VENCIDA bloqueando".
   */
  propostaPendente?: Linha | null;
}) {
  const inseridas: Linha[] = [];
  const toquesNoCard: string[] = [];
  const propostasEncerradas: Linha[] = [];
  const db = {
    from(tabela: string) {
      if (tabela === "crm_leads") {
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                maybeSingle: async () => ({ data: opcoes.lead, error: null }),
              }),
            }),
          }),
          update: (patch: Linha) => {
            toquesNoCard.push(JSON.stringify(patch));
            return { eq: () => ({ eq: async () => ({ data: null, error: null }) }) };
          },
        };
      }
      if (tabela === "crm_pipelines") {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: async () => ({
                data: opcoes.settings === undefined || opcoes.settings === null ? null : { settings: opcoes.settings },
                error: null,
              }),
            }),
          }),
        };
      }
      return {
        // Leitura da proposta que bloqueia (caminho do 23505) e o UPDATE que a
        // encerra quando ela venceu.
        select: () => {
          const q = {
            eq: () => q,
            maybeSingle: async () => ({ data: opcoes.propostaPendente ?? null, error: null }),
          };
          return q;
        },
        update: (patch: Linha) => {
          const q = {
            eq: () => q,
            select: () => q,
            maybeSingle: async () => {
              propostasEncerradas.push(patch);
              return { data: { id: "encerrada" }, error: null };
            },
          };
          return q;
        },
        insert: (linha: Linha) => {
          inseridas.push(linha);
          return {
            select: () => ({
              single: async () => {
                // Com uma proposta vencida bloqueando, o banco libera a chave
                // depois que ela é encerrada: a SEGUNDA tentativa passa.
                const bloqueia =
                  opcoes.erroNoInsert && (inseridas.length === 1 || !opcoes.propostaPendente);
                return bloqueia
                  ? { data: null, error: opcoes.erroNoInsert }
                  : { data: { id: `proposta-${inseridas.length}` }, error: null };
              },
            }),
          };
        },
      };
    },
  };
  return { db: db as unknown as SupabaseClient, inseridas, toquesNoCard, propostasEncerradas };
}

const leadDoCard = (customFields: unknown): Linha => ({
  id: LEAD,
  pipeline_id: PIPELINE,
  custom_fields: customFields,
});

describe("a proposta NASCE na fila, e o card fica intocado", () => {
  it("cria a linha em lead_field_proposals com valor, anterior e trecho — e NÃO grava o card", async () => {
    const { db, inseridas, toquesNoCard } = dbFalso({ lead: leadDoCard({}), settings: FUNIL });

    const r = await proporCamposDoNegocio(db, {
      organizationId: ORG,
      leadId: LEAD,
      campos: [{ campo: "localizador", valor: "ABC123", trecho: "Localizador: ABC123 — confirmação da reserva" }],
      attachmentId: "e4c0b7e0-0000-4000-8000-000000000005",
    });

    expect(r.criadas, JSON.stringify(r)).toHaveLength(1);
    expect(r.recusadas).toHaveLength(0);
    expect(inseridas).toHaveLength(1);
    expect(inseridas[0]).toMatchObject({
      organization_id: ORG,
      lead_id: LEAD,
      campo: "localizador",
      valor_proposto: "ABC123",
      valor_anterior: null,
      attachment_id: "e4c0b7e0-0000-4000-8000-000000000005",
    });
    expect(String(inseridas[0]?.trecho)).toContain("ABC123");
    // A asserção da issue: SEM confirmação humana, zero escrita em
    // crm_leads.custom_fields. Nenhum update saiu contra o card.
    expect(toquesNoCard).toEqual([]);
  });

  it("o valor IGUAL ao que já está no card não vira proposta — nada a decidir", async () => {
    const { db, inseridas } = dbFalso({
      lead: leadDoCard({ localizador: "ABC123" }),
      settings: FUNIL,
    });

    const r = await proporCamposDoNegocio(db, {
      organizationId: ORG,
      leadId: LEAD,
      campos: [{ campo: "localizador", valor: "ABC123", trecho: "Localizador: ABC123" }],
    });

    expect(r).toEqual({ criadas: [], recusadas: [{ campo: "localizador", motivo: "valor_igual_ao_atual" }] });
    expect(inseridas).toHaveLength(0);
  });

  it("a proposta repetida do MESMO campo vira recusa, não linha nova", async () => {
    const { db, inseridas } = dbFalso({
      lead: leadDoCard({}),
      settings: FUNIL,
      erroNoInsert: { code: "23505" },
    });

    const r = await proporCamposDoNegocio(db, {
      organizationId: ORG,
      leadId: LEAD,
      campos: [{ campo: "localizador", valor: "ABC123", trecho: "Localizador: ABC123" }],
    });

    expect(r.criadas).toHaveLength(0);
    expect(r.recusadas).toEqual([{ campo: "localizador", motivo: "ja_existe_proposta" }]);
    expect(inseridas).toHaveLength(1); // o insert foi TENTADO; o banco barrou
  });

  it("⭐ 23505 de uma proposta VENCIDA não é idempotência: ela é encerrada e a nova nasce", async () => {
    // O caso real: o voucher é relido no dia seguinte ao vencimento. A linha
    // morta continua `pending` (ninguém varreu ainda) e ocupa o índice único
    // parcial. Sem este ramo, a pessoa via "ja_existe_proposta" para sempre e a
    // fila nunca nascia de novo.
    const { db, inseridas, propostasEncerradas } = dbFalso({
      lead: leadDoCard({}),
      settings: FUNIL,
      erroNoInsert: { code: "23505" },
      propostaPendente: {
        id: "vencida",
        status: "pending",
        expires_at: "2020-01-01T00:00:00.000Z",
      },
    });

    const r = await proporCamposDoNegocio(db, {
      organizationId: ORG,
      leadId: LEAD,
      campos: [{ campo: "localizador", valor: "ABC123", trecho: "Localizador: ABC123" }],
    });

    expect(r.recusadas).toEqual([]);
    expect(r.criadas).toHaveLength(1);
    // A vencida foi encerrada com o veredito certo, e o instante é o da decisão.
    expect(propostasEncerradas).toHaveLength(1);
    expect(propostasEncerradas[0]).toMatchObject({ status: "expired" });
    expect(inseridas).toHaveLength(2); // a segunda tentativa passou
  });

  it("23505 de uma proposta VIVA continua sendo idempotência — e nada é encerrado", async () => {
    const { db, propostasEncerradas } = dbFalso({
      lead: leadDoCard({}),
      settings: FUNIL,
      erroNoInsert: { code: "23505" },
      propostaPendente: {
        id: "viva",
        status: "pending",
        expires_at: new Date(Date.now() + 7 * 24 * 3600_000).toISOString(),
      },
    });

    const r = await proporCamposDoNegocio(db, {
      organizationId: ORG,
      leadId: LEAD,
      campos: [{ campo: "localizador", valor: "ABC123", trecho: "Localizador: ABC123" }],
    });

    expect(r.recusadas).toEqual([{ campo: "localizador", motivo: "ja_existe_proposta" }]);
    expect(propostasEncerradas).toHaveLength(0);
  });

  it("a mesma chave duas vezes no lote: a primeira vence, a segunda é recusada", async () => {
    const { db, inseridas } = dbFalso({ lead: leadDoCard({}), settings: FUNIL });

    const r = await proporCamposDoNegocio(db, {
      organizationId: ORG,
      leadId: LEAD,
      campos: [
        { campo: "localizador", valor: "ABC123", trecho: "Localizador: ABC123" },
        { campo: "localizador", valor: "XYZ789", trecho: "Localizador: XYZ789" },
      ],
    });

    expect(r.criadas).toHaveLength(1);
    expect(r.recusadas).toEqual([{ campo: "localizador", motivo: "ja_existe_proposta" }]);
    expect(inseridas).toHaveLength(1);
  });

  it("negócio que não existe nesta organização: recusa, sem proposta nenhuma", async () => {
    const { db, inseridas } = dbFalso({ lead: null, settings: FUNIL });

    const r = await proporCamposDoNegocio(db, {
      organizationId: ORG,
      leadId: LEAD,
      campos: [{ campo: "localizador", valor: "ABC123", trecho: "Localizador: ABC123" }],
    });

    expect(r.recusadas).toEqual([{ campo: "localizador", motivo: "negocio_nao_encontrado" }]);
    expect(inseridas).toHaveLength(0);
  });

  it("funil ilegível não vira 'fora do funil' — o motivo honesto é funil_sem_campos", async () => {
    const { db, inseridas } = dbFalso({ lead: leadDoCard({}), settings: null });

    const r = await proporCamposDoNegocio(db, {
      organizationId: ORG,
      leadId: LEAD,
      campos: [{ campo: "localizador", valor: "ABC123", trecho: "Localizador: ABC123" }],
    });

    expect(r.recusadas).toEqual([{ campo: "localizador", motivo: "funil_sem_campos" }]);
    expect(inseridas).toHaveLength(0);
  });
});

describe("a proposta é SÓ para os campos do funil (o card)", () => {
  it("chave que o funil não declara é recusada — nada propõe fora de pipeline.settings.fields", async () => {
    const { db, inseridas } = dbFalso({ lead: leadDoCard({}), settings: FUNIL });

    const r = await proporCamposDoNegocio(db, {
      organizationId: ORG,
      leadId: LEAD,
      campos: [{ campo: "nome_do_hotel", valor: "Playa", trecho: "Hotel Playa del Mar" }],
    });

    expect(r.criadas).toHaveLength(0);
    expect(r.recusadas).toEqual([{ campo: "nome_do_hotel", motivo: "campo_fora_do_funil" }]);
    expect(inseridas).toHaveLength(0);
  });

  it("campo de escopo CONTATO tem motivo próprio: o valor mora na ficha, não no card", async () => {
    const { db, inseridas } = dbFalso({ lead: leadDoCard({}), settings: FUNIL });

    const r = await proporCamposDoNegocio(db, {
      organizationId: ORG,
      leadId: LEAD,
      campos: [{ campo: "nome_passageiro", valor: "Maria Silva", trecho: "Passageiro: Maria Silva" }],
    });

    expect(r.recusadas).toEqual([{ campo: "nome_passageiro", motivo: "campo_do_contato" }]);
    expect(inseridas).toHaveLength(0);
  });
});

describe("sem trecho de origem a proposta não nasce", () => {
  it("recusa o valor lido sem trecho — a confirmação seria um ato de fé", async () => {
    const { db, inseridas } = dbFalso({ lead: leadDoCard({}), settings: FUNIL });

    const r = await proporCamposDoNegocio(db, {
      organizationId: ORG,
      leadId: LEAD,
      campos: [{ campo: "localizador", valor: "ABC123" }],
    });

    expect(r.recusadas).toEqual([{ campo: "localizador", motivo: "sem_trecho" }]);
    expect(inseridas).toHaveLength(0);
  });

  it("trecho em branco também não vale", async () => {
    const { db } = dbFalso({ lead: leadDoCard({}), settings: FUNIL });
    const r = await proporCamposDoNegocio(db, {
      organizationId: ORG,
      leadId: LEAD,
      campos: [{ campo: "localizador", valor: "ABC123", trecho: "   " }],
    });
    expect(r.recusadas[0]?.motivo).toBe("sem_trecho");
  });
});

describe("tipo, lista e padrao: a forma que passa e a que não passa", () => {
  it("select casa pelo value/label CANÔNICO, ignorando caixa e acento", async () => {
    const { db, inseridas } = dbFalso({ lead: leadDoCard({}), settings: FUNIL });

    const r = await proporCamposDoNegocio(db, {
      organizationId: ORG,
      leadId: LEAD,
      // O rótulo do funil, caixa alta e com acento — a régua compara termo a
      // termo normalizado (valor, rótulo, apelido), então casar é esperado.
      campos: [{ campo: "destino", valor: "MACEIÓ (AL)", trecho: "Destino: Maceió" }],
    });

    expect(r.criadas, JSON.stringify(r)).toHaveLength(1);
    expect(inseridas[0]?.valor_proposto).toBe("maceio-al");
  });

  it("select fora da lista é recusado — a sétima grafia não vira proposta", async () => {
    const { db, inseridas } = dbFalso({ lead: leadDoCard({}), settings: FUNIL });

    const r = await proporCamposDoNegocio(db, {
      organizationId: ORG,
      leadId: LEAD,
      campos: [{ campo: "destino", valor: "Recife", trecho: "Destino: Recife" }],
    });

    expect(r.recusadas).toEqual([{ campo: "destino", motivo: "fora_da_lista" }]);
    expect(inseridas).toHaveLength(0);
  });

  it("padrao (#2730): o localizador fora do formato é recusado com o motivo do PADRÃO", async () => {
    const { db } = dbFalso({ lead: leadDoCard({}), settings: FUNIL });

    const r = await proporCamposDoNegocio(db, {
      organizationId: ORG,
      leadId: LEAD,
      campos: [{ campo: "localizador", valor: "abc-1", trecho: "Localizador: abc-1" }],
    });

    expect(r.recusadas).toEqual([{ campo: "localizador", motivo: "fora_do_padrao" }]);
  });

  it("padrao inválido no funil fecha a porta com padrao_invalido — nunca deixa passar", () => {
    const def = { key: "localizador", label: "Localizador", type: "text", padrao: "^(" } as CustomFieldDef;
    const v = confereCampoLido(def, "ABC123");
    expect(v).toEqual({ ok: false, motivo: "padrao_invalido" });
  });

  it("data com forma mas sem calendário é recusada — o gatilho nunca alcançaria", () => {
    const def = { key: "ida", label: "Data de ida", type: "date" } as CustomFieldDef;
    expect(confereCampoLido(def, "2026-02-30")).toEqual({ ok: false, motivo: "valor_invalido" });
    expect(confereCampoLido(def, "2026-03-01")).toEqual({ ok: true, valor: "2026-03-01" });
  });

  it("número do voucher vira NÚMERO (1.234,56 → 1234.56); o que não é número é recusado", () => {
    const def = { key: "valor_passagem", label: "Valor", type: "number" } as CustomFieldDef;
    expect(valorDoTipoAceitavel(def, "R$ 1.234,56")).toEqual({ ok: true, valor: 1234.56 });
    expect(valorDoTipoAceitavel(def, "mil e duzentos")).toEqual({ ok: false, motivo: "valor_invalido" });
  });

  it("arquivo não é valor de texto: o campo file é recusado (o documento é o anexo)", () => {
    const def = { key: "voucher", label: "Voucher", type: "file" } as CustomFieldDef;
    expect(valorDoTipoAceitavel(def, "/storage/voucher.pdf")).toEqual({ ok: false, motivo: "valor_invalido" });
  });
});

describe("um lote de documento: o que nasce e o que não nasce, lado a lado", () => {
  it("as recusas não impedem as propostas válidas do MESMO documento", async () => {
    const { db, inseridas } = dbFalso({ lead: leadDoCard({}), settings: FUNIL });

    const r = await proporCamposDoNegocio(db, {
      organizationId: ORG,
      leadId: LEAD,
      campos: [
        { campo: "localizador", valor: "ABC123", trecho: "Localizador ABC123" },
        { campo: "nome_do_hotel", valor: "Playa", trecho: "Hotel Playa" },
        { campo: "destino", valor: "Recife", trecho: "Destino: Recife" },
        { campo: "ida", valor: "2026-03-01", trecho: "Ida: 01/03/2026" },
      ],
    });

    expect(r.criadas.map((c) => c.campo).sort()).toEqual(["ida", "localizador"]);
    expect(r.recusadas).toEqual([
      { campo: "nome_do_hotel", motivo: "campo_fora_do_funil" },
      { campo: "destino", motivo: "fora_da_lista" },
    ]);
    expect(inseridas).toHaveLength(2);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// A VARREDURA (consumidor de `expires_at`) e a régua do prazo
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Cliente mínimo para a varredura: `select().eq().eq().lt()` devolve as linhas
 * que casam DE VERDADE (o `.lt()` é aplicado), e `update().eq().eq()` marca.
 * Sem aplicar o filtro, "venceu as vencidas" passaria por construção.
 */
function dbDaVarredura(linhas: Linha[]) {
  const encerradas: string[] = [];
  const b: Record<string, unknown> = {
    select: () => b,
    eq: (coluna: string, valor: unknown) => {
      (b.filtros as ((l: Linha) => boolean)[]).push((l) => l[coluna] === valor);
      return b;
    },
    lt: (coluna: string, valor: unknown) => {
      (b.filtros as ((l: Linha) => boolean)[]).push((l) => String(l[coluna]) < String(valor));
      return b;
    },
    update: (patch: Linha) => {
      b.patch = patch;
      return b;
    },
    then: (ok: (r: { data: unknown; error: null }) => unknown) => {
      if (b.patch) {
        const alvo = linhas.filter((l) => (b.filtros as ((x: Linha) => boolean)[]).every((f) => f(l)));
        for (const l of alvo) {
          Object.assign(l, b.patch as Linha);
          encerradas.push(String(l.id));
        }
        return Promise.resolve({ data: null, error: null }).then(ok);
      }
      const data = linhas.filter((l) => (b.filtros as ((x: Linha) => boolean)[]).every((f) => f(l)));
      return Promise.resolve({ data, error: null }).then(ok);
    },
  };
  const cliente = {
    from: () => {
      b.filtros = [];
      delete b.patch;
      return b;
    },
  };
  return { cliente: cliente as unknown as SupabaseClient, encerradas, linhas };
}

describe("a régua do prazo: vencida é `expires_at <= agora`", () => {
  it("⭐ o instante exato do vencimento JÁ é vencido — o sinal casa com o `.gt()` da leitura", () => {
    const agora = new Date("2026-10-26T12:00:00.000Z");
    // Se um dos dois lados usasse `<`, a proposta deste instante apareceria numa
    // fila e sumiria na outra — e o defeito só apareceria no segundo exato.
    expect(propostaVencida({ expires_at: agora.toISOString() }, agora)).toBe(true);
    expect(propostaVencida({ expires_at: "2026-10-26T12:00:00.001Z" }, agora)).toBe(false);
  });

  it("data ilegível NÃO vence: apagar trabalho pendente por `NaN` seria pior", () => {
    expect(propostaVencida({ expires_at: "ontem" }, new Date())).toBe(false);
    expect(propostaVencida({ expires_at: null }, new Date())).toBe(false);
  });
});

describe("a VARREDURA vence só as pendentes que passaram do prazo", () => {
  const agora = new Date("2026-10-26T12:00:00.000Z");

  it("⭐ encerra as vencidas e NÃO toca nas vivas nem nas já decididas", async () => {
    const { cliente, linhas } = dbDaVarredura([
      { id: "vencida", organization_id: ORG, status: "pending", expires_at: "2026-10-20T00:00:00.000Z" },
      { id: "viva", organization_id: ORG, status: "pending", expires_at: "2026-11-01T00:00:00.000Z" },
      { id: "ja-decida", organization_id: ORG, status: "accepted", expires_at: "2020-01-01T00:00:00.000Z" },
      { id: "de-outra-org", organization_id: "outra", status: "pending", expires_at: "2020-01-01T00:00:00.000Z" },
    ]);

    const r = await vencePropostasDeCampo(cliente, ORG, agora);

    expect(r.vencidas).toBe(1);
    expect(linhas.map((l) => [l.id, l.status])).toEqual([
      ["vencida", "expired"],
      ["viva", "pending"],
      ["ja-decida", "accepted"],
      ["de-outra-org", "pending"],
    ]);
    // `decided_at` recebe o instante da VARREDURA (quando o sistema encerrou), e
    // o prazo que venceu continua legível em `expires_at`.
    expect(linhas[0]!.decided_at).toBe(agora.toISOString());
    expect(linhas[0]!.expires_at).toBe("2026-10-20T00:00:00.000Z");
  });

  it("é idempotente: a segunda passada não encontra nada", async () => {
    const { cliente, linhas } = dbDaVarredura([
      { id: "v", organization_id: ORG, status: "pending", expires_at: "2026-10-20T00:00:00.000Z" },
    ]);

    await vencePropostasDeCampo(cliente, ORG, agora);
    const segunda = await vencePropostasDeCampo(cliente, ORG, new Date("2026-10-27T12:00:00.000Z"));

    expect(segunda.vencidas).toBe(0);
    expect(linhas[0]!.status).toBe("expired");
  });
});
