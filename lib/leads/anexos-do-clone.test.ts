// @vitest-environment node
/**
 * #4544 — A CÓPIA DOS ANEXOS DO CARD CLONADO É IDEMPOTENTE.
 *
 * O card criado em outro funil leva os anexos do card de origem (PR #4569). Esta
 * fatia fecha o que faltava depois dele: **repetir a cópia não duplica**, e é
 * isso que permite à automação tentar de novo no card que já existe — sem
 * idempotência, a guarda de continuação respondia `ja_existia` e uma falha de
 * Storage na primeira execução deixava o voucher fora do card de pós-venda para
 * sempre.
 *
 * Os quatro casos que a issue pede:
 *
 *   A1  o card novo fica com os MESMOS anexos (nome, tipo, tamanho, campo), em
 *       caminho PRÓPRIO — o do destino, não o da origem;
 *   A2  origem sem anexo não quebra nada (e não copia nada);
 *   A3  rodar DUAS vezes não duplica: a segunda só conta `jaEstavam`;
 *   A4  o card de ORIGEM continua com os seus, no mesmo caminho.
 *
 * O `copiarObjeto` é injetado para o teste medir o PAR origem→destino sem falar
 * com o bucket; em produção ele é `createAdminClient().storage...copy`.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => {
    throw new Error("o teste injeta o copiador; o cliente de serviço não deve ser tocado");
  },
}));

import { copiarAnexosDoClone, type CopiarObjetoDoStorage } from "@/lib/leads/anexos-do-clone";

const ORG = "22222222-2222-4222-8222-222222222222";
const ORIGEM = "11111111-1111-4111-8111-111111111111";
const DESTINO = "33333333-3333-4333-8333-333333333333";

type Linha = Record<string, unknown>;

function apolice(over: Linha = {}): Linha {
  return {
    id: "anexo-apolice",
    organization_id: ORG,
    lead_id: ORIGEM,
    field_key: "voucher",
    file_name: "apolice.pdf",
    file_size: 184320,
    mime_type: "application/pdf",
    storage_path: `${ORG}/leads/${ORIGEM}/voucher/anexo-apolice.pdf`,
    created_by: null,
    ...over,
  };
}

function voucher(over: Linha = {}): Linha {
  return {
    id: "anexo-voucher",
    organization_id: ORG,
    lead_id: ORIGEM,
    field_key: "voucher",
    file_name: "voucher-hotel.jpeg",
    file_size: 90210,
    mime_type: "image/jpeg",
    storage_path: `${ORG}/leads/${ORIGEM}/voucher/anexo-voucher.jpeg`,
    created_by: null,
    ...over,
  };
}

/**
 * O dublê do client: aplica `eq`, projeta o `select` e grava o `insert`. Nada
 * além do que `copiarAnexosDoClone` usa — um stub que ignorasse os filtros
 * deixaria "leu os anexos da organização errada" passar.
 */
function banco(anexos: Linha[], opts: { erroNoInsert?: { code: string; message: string } } = {}) {
  const tabelas: Record<string, Linha[]> = { crm_lead_attachments: anexos };
  const inseridos: Linha[] = [];

  function from(tabela: string) {
    const filtros: Array<[string, unknown]> = [];
    let operacao: "select" | "insert" = "select";
    let novo: Linha | null = null;
    const linhas = () => (tabelas[tabela] ??= []);
    const casam = () => linhas().filter((l) => filtros.every(([c, v]) => l[c] === v));

    const b = {
      select: () => b,
      eq: (coluna: string, valor: unknown) => {
        filtros.push([coluna, valor]);
        return b;
      },
      order: () => b,
      insert: (linha: Linha) => {
        operacao = "insert";
        novo = linha;
        return b;
      },
      then: (ok: (v: unknown) => unknown, falha: (e: unknown) => unknown) => {
        if (operacao === "insert" && novo) {
          if (opts.erroNoInsert) {
            return Promise.resolve({ data: null, error: opts.erroNoInsert }).then(ok, falha);
          }
          linhas().push(novo);
          inseridos.push(novo);
          return Promise.resolve({ data: null, error: null }).then(ok, falha);
        }
        return Promise.resolve({ data: casam(), error: null }).then(ok, falha);
      },
    };
    return b;
  }

  // `tabelas` volta tipado com a tabela que o teste inspeciona: com
  // `noUncheckedIndexedAccess` um `Record<string, Linha[]>` daria
  // `Linha[] | undefined` em cada leitura.
  return {
    client: { from } as never,
    inseridos,
    tabelas: tabelas as { crm_lead_attachments: Linha[] },
  };
}

function copiador(erro?: string) {
  const copias: Array<[string, string]> = [];
  const fn: CopiarObjetoDoStorage = async (de, para) => {
    if (erro) return { error: { message: erro } };
    copias.push([de, para]);
    return { error: null };
  };
  return { fn, copias };
}

const args = { organizationId: ORG, origemLeadId: ORIGEM, destinoLeadId: DESTINO };

describe("copiarAnexosDoClone — idempotência da cópia (#4544)", () => {
  it("A1: o card novo fica com os MESMOS anexos, em caminho do DESTINO", async () => {
    const db = banco([apolice(), voucher()]);
    const copia = copiador();

    const resultado = await copiarAnexosDoClone(db.client, args, copia.fn);

    expect(resultado).toEqual({ copiados: 2, falhas: 0, jaEstavam: 0 });
    expect(db.inseridos).toHaveLength(2);

    const [primeira, segunda] = db.inseridos;
    expect(primeira).toMatchObject({
      organization_id: ORG,
      lead_id: DESTINO,
      field_key: "voucher",
      file_name: "apolice.pdf",
      file_size: 184320,
      mime_type: "application/pdf",
      // o vínculo com a linha de origem é o que torna a cópia repetível
      clonado_do_attachment_id: "anexo-apolice",
    });
    expect(segunda).toMatchObject({ file_name: "voucher-hotel.jpeg", clonado_do_attachment_id: "anexo-voucher" });

    // O caminho é do card NOVO — o check do banco recusaria o caminho da origem.
    for (const linha of db.inseridos) {
      expect(String(linha.storage_path)).toMatch(
        new RegExp(`^${ORG}/leads/${DESTINO}/voucher/[0-9a-f-]+\\.(pdf|jpeg)$`),
      );
    }
    // E o arquivo foi COPIADO no bucket, origem → destino (não apontado).
    expect(copia.copias).toHaveLength(2);
    expect(copia.copias.map(([de]) => de).sort()).toEqual(
      [apolice().storage_path, voucher().storage_path].sort(),
    );
  });

  it("A2: origem SEM anexo não quebra nada — e não copia nada", async () => {
    const db = banco([]);
    const copia = copiador();

    const resultado = await copiarAnexosDoClone(db.client, args, copia.fn);

    expect(resultado).toEqual({ copiados: 0, falhas: 0, jaEstavam: 0 });
    expect(db.inseridos).toEqual([]);
    expect(copia.copias).toEqual([]);
  });

  it("A3: rodar DUAS vezes não duplica — a segunda só conta o que já estava", async () => {
    const db = banco([apolice(), voucher()]);
    const copia = copiador();

    const primeira = await copiarAnexosDoClone(db.client, args, copia.fn);
    const segunda = await copiarAnexosDoClone(db.client, args, copia.fn);

    expect(primeira).toEqual({ copiados: 2, falhas: 0, jaEstavam: 0 });
    expect(segunda).toEqual({ copiados: 0, falhas: 0, jaEstavam: 2 });

    // Duas linhas na origem + duas no destino. Nada a mais.
    expect(db.tabelas.crm_lead_attachments).toHaveLength(4);
    expect(db.inseridos).toHaveLength(2);
    // E o bucket recebeu UMA cópia por arquivo, não duas.
    expect(copia.copias).toHaveLength(2);
  });

  it("A4: o card de ORIGEM continua com os seus, no caminho de sempre", async () => {
    const db = banco([apolice()]);
    const copia = copiador();

    await copiarAnexosDoClone(db.client, args, copia.fn);

    const daOrigem = db.tabelas.crm_lead_attachments.filter((l) => l.lead_id === ORIGEM);
    expect(daOrigem).toHaveLength(1);
    expect(daOrigem[0]).toMatchObject({
      id: "anexo-apolice",
      storage_path: `${ORG}/leads/${ORIGEM}/voucher/anexo-apolice.pdf`,
    });
  });

  it("corrida perdida (23505 do índice único) conta como 'já estava', não como falha", async () => {
    const db = banco([apolice()], {
      erroNoInsert: { code: "23505", message: "duplicate key value violates unique constraint" },
    });
    const copia = copiador();

    const resultado = await copiarAnexosDoClone(db.client, args, copia.fn);

    expect(resultado).toEqual({ copiados: 0, falhas: 0, jaEstavam: 1 });
  });

  it("falha do Storage conta a falha e não grava linha daquele arquivo", async () => {
    const db = banco([apolice()]);
    const copia = copiador("storage: objeto não encontrado");

    const resultado = await copiarAnexosDoClone(db.client, args, copia.fn);

    expect(resultado).toEqual({ copiados: 0, falhas: 1, jaEstavam: 0 });
    expect(db.inseridos).toEqual([]);
  });
});
