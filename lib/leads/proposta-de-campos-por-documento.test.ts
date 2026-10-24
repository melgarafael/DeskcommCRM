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
  valorDoTipoAceitavel,
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
}) {
  const inseridas: Linha[] = [];
  const toquesNoCard: string[] = [];
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
        insert: (linha: Linha) => {
          inseridas.push(linha);
          return {
            select: () => ({
              single: async () =>
                opcoes.erroNoInsert
                  ? { data: null, error: opcoes.erroNoInsert }
                  : { data: { id: `proposta-${inseridas.length}` }, error: null },
            }),
          };
        },
      };
    },
  };
  return { db: db as unknown as SupabaseClient, inseridas, toquesNoCard };
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
