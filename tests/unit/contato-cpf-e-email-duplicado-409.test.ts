/**
 * #3084 — CPF ou e-mail repetido deixou de ser 500.
 *
 * O telefone já virava 409 `contact_exists` (fatia S1 da #852). O CPF e o
 * e-mail têm a MESMA trava única na tabela (`uniq_contacts_org_cpf` sobre
 * `(organization_id, cpf_hash)`, `uniq_contacts_org_email` sobre
 * `(organization_id, email_normalized)`), mas o 23505 dos dois caía no
 * `internal_error` e a tela mostrava "erro interno" para um simples duplicado.
 *
 * O conserto distingue os índices pelo NOME que o driver do Postgres escreve no
 * 23505 e devolve o `contact_id` de quem já tem o dado — sempre relido com o
 * filtro por `organization_id` (o id nunca vem do corpo da requisição). O
 * telefone continua decidindo pela RELEITURA, sem olhar o texto do erro, como
 * já era.
 *
 * O cliente falso abaixo simula os três índices únicos da tabela: mesmo dado
 * (CPF pelo hash, e-mail por `lower(trim(...))`, telefone pela forma canônica)
 * na MESMA organização estoura; em outra organização, passa.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { HandlerCtx } from "@/lib/api/handlers/types";
import { canonicalPhoneBR } from "@/lib/channels/phone-variants";
import { hashCpf } from "@/lib/contacts/cpf";

const auditSpy = vi.fn(async () => undefined);

vi.mock("@/lib/audit", () => ({
  audit: auditSpy,
  isServiceRoleConfigured: () => false,
  hashEmail: (e: string) => e,
}));

const ORG = "d0849a00-0000-4000-8000-000000000001";
const OUTRA_ORG = "d0849a00-0000-4000-8000-000000000002";
const EXISTENTE = "d0849a00-0000-4000-8000-0000000000c1";
const NOVO = "d0849a00-0000-4000-8000-0000000000c2";
const USUARIO = "d0849a00-0000-4000-8000-0000000000a1";

const CPF = "529.982.247-25";
const CPF_HASH = hashCpf(CPF);
const EMAIL = "ana@example.com";

const INDICE_CPF = "uniq_contacts_org_cpf";
const INDICE_EMAIL = "uniq_contacts_org_email";

interface LinhaContato {
  id: string;
  organization_id: string;
  phone_number?: string | null;
  cpf_hash?: string | null;
  email?: string | null;
  is_merged_into?: string | null;
}

interface OpcoesFake {
  /** O que já está gravado na tabela antes da chamada. */
  contatos?: LinhaContato[];
  /** Erro cru do INSERT, no lugar do simulador dos índices. */
  falhaDoInsert?: { code: string; message: string } | null;
  /** Erro cru do UPDATE do PATCH, no lugar do simulador dos índices. */
  falhaDoUpdate?: { code: string; message: string } | null;
}

type Filtro = [string, unknown];

interface Cadeia {
  select: (colunas?: string, opcoes?: unknown) => Cadeia;
  insert: (linha: Record<string, unknown>) => Cadeia;
  update: (linha: Record<string, unknown>) => Cadeia;
  eq: (coluna: string, valor: unknown) => Cadeia;
  in: (coluna: string, valores: unknown) => Cadeia;
  is: (coluna: string, valor: unknown) => Cadeia;
  order: (coluna: string, opcoes?: unknown) => Cadeia;
  limit: (n: number) => Cadeia;
  single: () => Promise<{ data: unknown; error: unknown }>;
  maybeSingle: () => Promise<{ data: unknown; error: unknown }>;
  then: (resolve: (v: unknown) => unknown) => unknown;
}

const buscas: Array<{ filtros: Filtro[] }> = [];
const inserts: Array<Record<string, unknown>> = [];
const updates: Array<Record<string, unknown>> = [];

/** Cadeia de qualquer tabela que não seja `contacts`: responde vazio. */
function cadeiaQualquer(tabela: string): Cadeia {
  const cadeia: Cadeia = {
    select: () => cadeia,
    insert: () => cadeia,
    update: () => cadeia,
    eq: () => cadeia,
    in: () => cadeia,
    is: () => cadeia,
    order: () => cadeia,
    limit: () => cadeia,
    single: async () => ({ data: null, error: null }),
    maybeSingle: async () => ({ data: null, error: null }),
    then: (resolve) => resolve({ data: [], error: null, tabela }),
  };
  return cadeia;
}

/** Normalização do e-mail igual à coluna GENERATED (`lower(trim(email))`). */
function emailNormalizado(email: string | null | undefined): string | null {
  return typeof email === "string" ? email.trim().toLowerCase() : null;
}

function linhaCasaCom(linha: LinhaContato, filtros: Filtro[], variantes: string[] | null): boolean {
  for (const [coluna, valor] of filtros) {
    if (coluna === "organization_id" && linha.organization_id !== valor) return false;
    if (coluna === "id" && linha.id !== valor) return false;
    if (coluna === "cpf_hash" && linha.cpf_hash !== valor) return false;
    if (coluna === "email_normalized" && emailNormalizado(linha.email) !== valor) return false;
    if (coluna === "is_merged_into" && valor === null && linha.is_merged_into) return false;
  }
  if (variantes !== null && !variantes.includes(linha.phone_number ?? "")) return false;
  return true;
}

function cadeiaDeContatos(opts: OpcoesFake = {}): Cadeia {
  const gravados: LinhaContato[] = [...(opts.contatos ?? [])];
  const filtros: Filtro[] = [];
  let variantes: string[] | null = null;
  let limite: number | null = null;
  let operacao: "select" | "insert" | "update" = "select";
  let linhaDoInsert: Record<string, unknown> | null = null;
  let linhaDoUpdate: Record<string, unknown> | null = null;

  /** Simula os índices únicos parciais da tabela. */
  const erroDeIndex = (linha: Record<string, unknown>, doUpdate: boolean): { code: string; message: string } | null => {
    const forcar = doUpdate ? opts.falhaDoUpdate : opts.falhaDoInsert;
    if (forcar) return forcar;
    // A organização do UPDATE vem do filtro `.eq("organization_id", …)` do
    // próprio UPDATE (o patch não carrega a coluna); no INSERT vem da linha.
    const orgDoFiltro = filtros.find(([coluna]) => coluna === "organization_id")?.[1];
    const orgAlvo = (orgDoFiltro ?? linha.organization_id) as string | undefined;
    const naOrg = gravados.filter(
      (c) => c.organization_id === orgAlvo && !c.is_merged_into,
    );
    const cpf = typeof linha.cpf_hash === "string" ? linha.cpf_hash : null;
    if (cpf && naOrg.some((c) => c.cpf_hash === cpf)) {
      return { code: "23505", message: `duplicate key value violates unique constraint "${INDICE_CPF}"` };
    }
    const email = emailNormalizado(typeof linha.email === "string" ? linha.email : null);
    if (email && naOrg.some((c) => emailNormalizado(c.email) === email)) {
      return { code: "23505", message: `duplicate key value violates unique constraint "${INDICE_EMAIL}"` };
    }
    const telefone = typeof linha.phone_number === "string" ? linha.phone_number : null;
    if (telefone && naOrg.some((c) => (c.phone_number ?? "") === telefone)) {
      return {
        code: "23505",
        message: 'duplicate key value violates unique constraint "uniq_contacts_org_phone"',
      };
    }
    return null;
  };

  const filtradas = (): LinhaContato[] =>
    gravados.filter((c) => linhaCasaCom(c, filtros, variantes));

  const cadeia: Cadeia = {
    select: () => cadeia,
    insert: (linha) => {
      operacao = "insert";
      linhaDoInsert = linha;
      inserts.push(linha);
      return cadeia;
    },
    update: (linha) => {
      operacao = "update";
      linhaDoUpdate = linha;
      updates.push(linha);
      return cadeia;
    },
    eq: (coluna, valor) => {
      filtros.push([coluna, valor]);
      return cadeia;
    },
    in: (coluna, valores) => {
      filtros.push([coluna, valores]);
      variantes = Array.isArray(valores) ? (valores as string[]) : null;
      return cadeia;
    },
    is: (coluna, valor) => {
      filtros.push([coluna, valor]);
      return cadeia;
    },
    order: () => cadeia,
    limit: (n) => {
      limite = n;
      return cadeia;
    },
    maybeSingle: async () => {
      if (operacao === "update") {
        const error = erroDeIndex(linhaDoUpdate ?? {}, true);
        if (error) return { data: null, error };
        return { data: { ...(linhaDoUpdate ?? {}), id: EXISTENTE }, error: null };
      }
      // Pré-select do PATCH (e afins): devolve o contato filtrado, ou nulo.
      const encontrados = filtradas();
      return { data: encontrados[0] ?? null, error: null };
    },
    single: async () => {
      if (operacao !== "insert" || !linhaDoInsert) return { data: null, error: null };
      const error = erroDeIndex(linhaDoInsert, false);
      if (error) return { data: null, error };
      return {
        data: {
          ...linhaDoInsert,
          id: NOVO,
          created_at: "2026-01-01T00:00:00.000Z",
          updated_at: "2026-01-01T00:00:00.000Z",
        },
        error: null,
      };
    },
    then: (resolve) => {
      buscas.push({ filtros: [...filtros] });
      const achados = filtradas().map((c) => ({
        id: c.id,
        phone_number: c.phone_number ?? null,
        cpf_hash: c.cpf_hash ?? null,
        email: c.email ?? null,
      }));
      return resolve({ data: limite === null ? achados : achados.slice(0, limite), error: null });
    },
  };
  return cadeia;
}

function clienteFalso(opts: OpcoesFake = {}): unknown {
  return {
    from: (tabela: string) =>
      tabela === "contacts" ? cadeiaDeContatos(opts) : cadeiaQualquer(tabela),
    // `encrypt_cpf` devolve um ciphertext para o par cpf_hash/cpf_encrypted
    // existir (#2522); os demais RPCs (emit_event) só precisam não falhar.
    rpc: (nome: string) => ({
      then: (r: (v: unknown) => unknown) =>
        r({
          data: nome === "encrypt_cpf" ? new Uint8Array([1, 2, 3]) : null,
          error: null,
        }),
    }),
  };
}

function ctxFalso(organizationId = ORG): HandlerCtx {
  return {
    organization_id: organizationId,
    actor: { type: "user", id: USUARIO },
    requestId: "req-3084",
  };
}

async function erroDe(promessa: Promise<unknown>): Promise<Record<string, unknown>> {
  try {
    await promessa;
  } catch (e) {
    return e as unknown as Record<string, unknown>;
  }
  throw new Error("esperava que o handler falhasse, e ele resolveu");
}

async function criar(cliente: unknown, entrada: Record<string, unknown>): Promise<unknown> {
  const { createContactHandler } = await import("@/app/api/v1/contacts/_handler");
  return createContactHandler(cliente as never, ctxFalso(), entrada as never);
}

async function editar(cliente: unknown, entrada: Record<string, unknown>): Promise<unknown> {
  const { patchContactHandler } = await import("@/app/api/v1/contacts/_handler");
  return patchContactHandler(cliente as never, ctxFalso(), EXISTENTE, entrada as never);
}

beforeEach(() => {
  auditSpy.mockClear();
  buscas.length = 0;
  inserts.length = 0;
  updates.length = 0;
});

describe("#3084 — POST com CPF repetido vira 409 contact_exists", () => {
  it("CPF que já é de um contato vivo da organização: 409 com details.contact_id", async () => {
    const erro = await erroDe(
      criar(
        clienteFalso({ contatos: [{ id: EXISTENTE, organization_id: ORG, cpf_hash: CPF_HASH }] }),
        { name: "Ana", cpf: CPF },
      ),
    );

    expect(erro).toMatchObject({
      status: 409,
      code: "contact_exists",
      details: { contact_id: EXISTENTE },
      message: "Já existe um contato com este CPF.",
    });

    // O insert levou o hash do CPF; a releitura repetiu o filtro por organização
    // e por `is_merged_into` (o id NUNCA vem do corpo da requisição).
    expect(inserts[0]?.cpf_hash).toBe(CPF_HASH);
    const releitura = buscas.at(-1)!;
    expect(releitura.filtros).toEqual([
      ["organization_id", ORG],
      ["cpf_hash", CPF_HASH],
      ["is_merged_into", null],
    ]);
  });

  it("CONTROLE — o mesmo CPF em OUTRA organização não vira 409 daqui", async () => {
    // O índice não dispara em outra organização; forçamos o 23505 de CPF para
    // provar que é o FILTRO da releitura que impede o 409 indevido.
    const erro = await erroDe(
      criar(
        clienteFalso({
          contatos: [{ id: EXISTENTE, organization_id: OUTRA_ORG, cpf_hash: CPF_HASH }],
          falhaDoInsert: {
            code: "23505",
            message: `duplicate key value violates unique constraint "${INDICE_CPF}"`,
          },
        }),
        { name: "Ana", cpf: CPF },
      ),
    );

    expect(erro).toMatchObject({ status: 500, code: "internal_error" });
    expect(erro.details).toBeUndefined();
    expect(buscas.at(-1)!.filtros).toContainEqual(["organization_id", ORG]);
  });

  it("CONTROLE — 23505 de outra origem continua 500", async () => {
    const erro = await erroDe(
      criar(
        clienteFalso({
          contatos: [{ id: EXISTENTE, organization_id: ORG, cpf_hash: CPF_HASH }],
          falhaDoInsert: {
            code: "23505",
            message: 'duplicate key value violates unique constraint "contacts_pkey"',
          },
        }),
        { name: "Ana", cpf: CPF },
      ),
    );

    expect(erro).toMatchObject({ status: 500, code: "internal_error" });
  });

  it("CPF livre: cria normalmente", async () => {
    const out = (await criar(clienteFalso({ contatos: [] }), { name: "Ana", cpf: CPF })) as {
      action: string;
      contact: { id: string };
    };
    expect(out.action).toBe("created");
    expect(out.contact.id).toBe(NOVO);
  });
});

describe("#3084 — PATCH com e-mail repetido vira 409 contact_exists", () => {
  const linhaExistente: LinhaContato = {
    id: EXISTENTE,
    organization_id: ORG,
    email: "antigo@example.com",
  };

  it("e-mail que já é de outro contato: 409 com details.contact_id", async () => {
    const erro = await erroDe(
      editar(
        clienteFalso({
          contatos: [
            linhaExistente,
            { id: NOVO, organization_id: ORG, email: EMAIL },
          ],
        }),
        { email: EMAIL },
      ),
    );

    expect(erro).toMatchObject({
      status: 409,
      code: "contact_exists",
      details: { contact_id: NOVO },
      message: "Já existe um contato com este e-mail.",
    });

    // O PATCH grava por `email`; a releitura usa a coluna GENERATED
    // `email_normalized`, que é a que o índice vigia.
    expect(updates[0]?.email).toBe(EMAIL);
    expect(updates[0]?.email_normalized).toBeUndefined();
    expect(buscas.at(-1)!.filtros).toEqual([
      ["organization_id", ORG],
      ["email_normalized", EMAIL],
      ["is_merged_into", null],
    ]);
  });

  it("CONTROLE — o mesmo e-mail em OUTRA organização não vira 409 daqui", async () => {
    const erro = await erroDe(
      editar(
        clienteFalso({
          contatos: [
            linhaExistente,
            { id: NOVO, organization_id: OUTRA_ORG, email: EMAIL },
          ],
          falhaDoUpdate: {
            code: "23505",
            message: `duplicate key value violates unique constraint "${INDICE_EMAIL}"`,
          },
        }),
        { email: EMAIL },
      ),
    );

    expect(erro).toMatchObject({ status: 500, code: "internal_error" });
    expect(buscas.at(-1)!.filtros).toContainEqual(["organization_id", ORG]);
  });

  it("CONTROLE — 23505 de outra origem no UPDATE continua 500", async () => {
    const erro = await erroDe(
      editar(
        clienteFalso({
          contatos: [linhaExistente, { id: NOVO, organization_id: ORG, email: EMAIL }],
          falhaDoUpdate: {
            code: "23505",
            message: 'duplicate key value violates unique constraint "contacts_pkey"',
          },
        }),
        { email: EMAIL },
      ),
    );

    expect(erro).toMatchObject({ status: 500, code: "internal_error" });
  });

  it("e-mail livre: atualiza normalmente", async () => {
    const out = (await editar(clienteFalso({ contatos: [linhaExistente] }), {
      email: "novo@example.com",
    })) as { id: string };
    expect(out.id).toBe(EXISTENTE);
    expect(updates[0]?.email).toBe("novo@example.com");
  });
});

describe("#3084 — o telefone segue pelo caminho de sempre", () => {
  // O arquivo `contato-duplicado-409.test.ts` já trava o caso do telefone (a
  // fatia S1 da #852). Aqui só se prova que o conserto do CPF/e-mail não
  // desviou esse caminho: ele continua decidindo pela RELEITURA, não pelo nome
  // do índice — um 23505 que nem é de telefone ainda vira 409 porque o estado
  // (contato vivo com o mesmo número) implica a trava.
  it("23505 sem nome de telefone, mas com contato vivo de mesmo número: 409", async () => {
    const telefone = "+5532984793302";
    const erro = await erroDe(
      criar(
        clienteFalso({
          contatos: [
            { id: EXISTENTE, organization_id: ORG, phone_number: canonicalPhoneBR(telefone) },
          ],
          falhaDoInsert: {
            code: "23505",
            message: 'duplicate key value violates unique constraint "contacts_pkey"',
          },
        }),
        { name: "Ana", phone_number: telefone },
      ),
    );

    expect(erro).toMatchObject({
      status: 409,
      code: "contact_exists",
      details: { contact_id: EXISTENTE },
    });
  });
});

describe("#3084 — PATCH pela tela reenvia o telefone do próprio contato", () => {
  // O EditContactDialog manda o telefone junto com o e-mail. Se a releitura por
  // telefone viesse primeiro, ela acharia o PRÓPRIO contato e o 409 diria
  // "telefone" apontando para quem está sendo editado.
  it("e-mail de outro + telefone próprio: 409 de e-mail com o id do OUTRO", async () => {
    const telefone = canonicalPhoneBR("+5532984793302");
    const erro = await erroDe(
      editar(
        clienteFalso({
          contatos: [
            { id: EXISTENTE, organization_id: ORG, email: "antigo@example.com", phone_number: telefone },
            { id: NOVO, organization_id: ORG, email: EMAIL },
          ],
        }),
        { email: EMAIL, phone_number: "+5532984793302" },
      ),
    );
    expect(erro).toMatchObject({
      status: 409,
      code: "contact_exists",
      details: { contact_id: NOVO },
      message: "Já existe um contato com este e-mail.",
    });
  });

  it("telefone próprio + 23505 de índice desconhecido: 500, não 409 apontando para si", async () => {
    const telefone = canonicalPhoneBR("+5532984793302");
    const erro = await erroDe(
      editar(
        clienteFalso({
          contatos: [{ id: EXISTENTE, organization_id: ORG, phone_number: telefone }],
          falhaDoUpdate: {
            code: "23505",
            message: 'duplicate key value violates unique constraint "uq_contacts_grupo"',
          },
        }),
        { phone_number: "+5532984793302" },
      ),
    );
    expect(erro).toMatchObject({ status: 500, code: "internal_error" });
  });
});
