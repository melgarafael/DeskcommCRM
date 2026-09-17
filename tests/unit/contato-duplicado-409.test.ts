/**
 * Fatia S1 da issue #852: telefone já cadastrado deixou de ser 500.
 *
 * `POST /api/v1/contacts` normaliza o telefone e tenta o insert. O índice
 * parcial `uniq_contacts_org_phone` (organization_id, phone_number) barra o
 * número repetido com 23505 — e o handler devolvia `internal_error`, então a
 * tela nem sabia que o cadastro já existia, muito menos qual era. Agora a
 * resposta é 409 `contact_exists` com `details.contact_id`, sempre do contato
 * vivo da MESMA organização (o id nunca vem do corpo da requisição).
 *
 * O cliente falso abaixo simula o índice de verdade: mesmo telefone (comparado
 * pela forma canônica, como o Postgres compara a coluna já gravada) na mesma
 * organização estoura; em outra organização, passa.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import type { HandlerCtx } from "@/lib/api/handlers/types";
import { requireRole } from "@/lib/auth/require-role";
import { canonicalPhoneBR, phoneLookupVariants } from "@/lib/channels/phone-variants";
import { createClient } from "@/lib/supabase/server";

const auditSpy = vi.fn(async () => undefined);

vi.mock("@/lib/audit", () => ({
  audit: auditSpy,
  isServiceRoleConfigured: () => false,
  hashEmail: (e: string) => e,
}));

// Só as fronteiras da rota são dubladas — sessão, cookie e o guarda de
// acompanhamento. O handler e o `fail()` que monta o corpo são os de verdade.
vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn(async () => null) }));

const ORG = "c05e7a00-0000-4000-8000-000000000001";
const OUTRA_ORG = "c05e7a00-0000-4000-8000-000000000002";
const EXISTENTE = "c05e7a00-0000-4000-8000-0000000000c1";
const NOVO = "c05e7a00-0000-4000-8000-0000000000c2";
const USUARIO = "c05e7a00-0000-4000-8000-0000000000a1";
const TELEFONE = "(32) 98479-3302";

interface LinhaContato {
  id: string;
  organization_id: string;
  phone_number: string | null;
  is_merged_into?: string | null;
}

interface OpcoesFake {
  /** O que já está gravado na tabela antes do POST. */
  contatos?: LinhaContato[];
  /** Erro cru do INSERT, no lugar do simulador do índice (ex.: e-mail, CPF, FK). */
  falhaDoInsert?: { code: string; message: string } | null;
}

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

const buscas: Array<{ tabela: string; filtros: Array<[string, unknown]> }> = [];
const inserts: Array<Record<string, unknown>> = [];

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

function cadeiaDeContatos(opts?: OpcoesFake, gravados: LinhaContato[] = []): Cadeia {
  const filtros: Array<[string, unknown]> = [];
  let variantes: string[] = [];
  let limite: number | null = null;
  let linhaDoInsert: Record<string, unknown> | null = null;

  const erroDeIndex = (linha: Record<string, unknown>) => {
    if (opts?.falhaDoInsert) return opts.falhaDoInsert;
    const telefone = typeof linha.phone_number === "string" ? linha.phone_number : null;
    if (!telefone) return null;
    const repetido = gravados.some(
      (c) =>
        c.organization_id === linha.organization_id &&
        !c.is_merged_into &&
        canonicalPhoneBR(c.phone_number ?? "") === canonicalPhoneBR(telefone),
    );
    return repetido
      ? {
          code: "23505",
          message: 'duplicate key value violates unique constraint "uniq_contacts_org_phone"',
        }
      : null;
  };

  const cadeia: Cadeia = {
    select: () => cadeia,
    insert: (linha) => {
      linhaDoInsert = linha;
      inserts.push(linha);
      return cadeia;
    },
    update: () => cadeia,
    eq: (coluna, valor) => {
      filtros.push([coluna, valor]);
      return cadeia;
    },
    in: (coluna, valores) => {
      filtros.push([coluna, valores]);
      variantes = Array.isArray(valores) ? (valores as string[]) : [];
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
    maybeSingle: async () => ({ data: null, error: null }),
    single: async () => {
      if (!linhaDoInsert) return { data: null, error: null };
      const error = erroDeIndex(linhaDoInsert);
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
      buscas.push({ tabela: "contacts", filtros });
      const daOrg = filtros.find(([coluna]) => coluna === "organization_id")?.[1];
      const soVivos = filtros.some(([coluna]) => coluna === "is_merged_into");
      const achados = gravados
        .filter((c) => c.organization_id === daOrg)
        .filter((c) => !soVivos || !c.is_merged_into)
        .filter((c) => variantes.length === 0 || variantes.includes(c.phone_number ?? ""))
        .map((c) => ({ id: c.id, phone_number: c.phone_number }));
      return resolve({ data: limite === null ? achados : achados.slice(0, limite), error: null });
    },
  };
  return cadeia;
}

function clienteFalso(opts?: OpcoesFake): unknown {
  return {
    from: (tabela: string) =>
      tabela === "contacts"
        ? cadeiaDeContatos(opts, [...(opts?.contatos ?? [])])
        : cadeiaQualquer(tabela),
    rpc: () => ({ then: (r: (v: unknown) => unknown) => r({ error: null }) }),
  };
}

function ctxFalso(organizationId = ORG): HandlerCtx {
  return { organization_id: organizationId, actor: { type: "user", id: USUARIO }, requestId: "req-1" };
}

function criar(cliente: unknown, entrada: Record<string, unknown> = { name: "Ana" }) {
  return import("@/app/api/v1/contacts/_handler").then(({ createContactHandler }) =>
    createContactHandler(cliente as never, ctxFalso(), {
      phone_number: TELEFONE,
      ...entrada,
    } as never),
  );
}

async function erroDe(promessa: Promise<unknown>): Promise<Record<string, unknown>> {
  try {
    await promessa;
  } catch (e) {
    return e as unknown as Record<string, unknown>;
  }
  throw new Error("esperava que o handler falhasse, e ele resolveu");
}

const contatoDaOrg = (organization_id: string): LinhaContato => ({
  id: EXISTENTE,
  organization_id,
  phone_number: canonicalPhoneBR(TELEFONE),
});

describe("createContactHandler — telefone repetido (fatia S1 da #852)", () => {
  beforeEach(() => {
    auditSpy.mockClear();
    buscas.length = 0;
    inserts.length = 0;
  });

  it("telefone que já existe na organização: 409 contact_exists com o id de quem já estava lá", async () => {
    const erro = await erroDe(criar(clienteFalso({ contatos: [contatoDaOrg(ORG)] })));

    expect(erro).toMatchObject({
      status: 409,
      code: "contact_exists",
      details: { contact_id: EXISTENTE },
    });

    // O telefone vai para o insert na forma canônica e a releitura repete o
    // filtro por organização: sem ele, contato de OUTRA org seria oferecido.
    expect(inserts[0]?.phone_number).toBe(canonicalPhoneBR(TELEFONE));
    expect(buscas).toEqual([
      {
        tabela: "contacts",
        filtros: [
          ["organization_id", ORG],
          ["phone_number", phoneLookupVariants(TELEFONE)],
          ["is_merged_into", null],
        ],
      },
    ]);
    // Nada foi criado: não há audit de `contact.created` para um cadastro que
    // não passou.
    expect(auditSpy).not.toHaveBeenCalledWith(expect.objectContaining({ action: "contact.created" }));
  });

  it("mesmo telefone em OUTRA organização: cria normalmente", async () => {
    const out = (await criar(clienteFalso({ contatos: [contatoDaOrg(OUTRA_ORG)] }))) as {
      contact: { id: string };
      action: string;
    };

    expect(out.action).toBe("created");
    expect(out.contact.id).toBe(NOVO);
    // Caminho feliz não relê contato: a busca por telefone só existe depois do
    // 23505 (o primeiro teste trava os filtros exatos dela). Aqui o valor da
    // asserção é o oposto — garantir que criar contato novo não ganha consulta
    // extra.
    expect(buscas).toEqual([]);
    expect(auditSpy).toHaveBeenCalledWith(
      expect.objectContaining({ action: "contact.created", organizationId: ORG }),
    );
  });

  it("23505 sem nenhum contato vivo com aquele telefone: continua 500, sem inventar 409", async () => {
    // Conflito de outra trava única da tabela (e-mail/CPF): o 23505 não diz qual
    // índice bateu, então quem decide é a releitura do telefone.
    const erro = await erroDe(
      criar(clienteFalso({ falhaDoInsert: { code: "23505", message: "uniq_contacts_org_email" } })),
    );

    expect(erro).toMatchObject({ status: 500, code: "internal_error" });
    expect(erro.details).toBeUndefined();
  });

  it("23505 cru: se existe contato vivo com o telefone, o estado já garante a trava de telefone", async () => {
    // O Postgres nomeia UM dos índices violados; o estado (contato vivo com o
    // mesmo telefone na mesma org) implica que a trava de telefone está lá de
    // qualquer jeito — por isso a resposta não depende do texto do erro.
    const erro = await erroDe(
      criar(
        clienteFalso({
          contatos: [contatoDaOrg(ORG)],
          falhaDoInsert: { code: "23505", message: 'duplicate key value violates unique constraint "contacts_pkey"' },
        }),
      ),
    );

    expect(erro).toMatchObject({ status: 409, code: "contact_exists", details: { contact_id: EXISTENTE } });
  });

  it("erro de outra natureza (23503) mantém o desfecho de antes", async () => {
    const erro = await erroDe(
      criar(clienteFalso({ falhaDoInsert: { code: "23503", message: "fk de organização" } })),
    );

    expect(erro).toMatchObject({ status: 500, code: "internal_error" });
    // Não é 23505: nem chega a procurar contato pelo telefone.
    expect(buscas).toEqual([]);
  });
});

/**
 * Os casos acima chamam `createContactHandler` direto, e por isso não enxergam
 * a metade do conserto que mora na rota: o `catch` de `POST` precisa repassar
 * `err.details` ao `fail()`. Sem esse repasse, o handler lança o 409 com o
 * `contact_id` e o cliente recebe `{ error: { code, message } }` — o id some
 * no caminho. Medido na revisão do PR: devolver a rota à versão da base deixava
 * verdes os 7 arquivos / 38 casos rodados. Este caso atravessa `POST` de
 * verdade e lê o corpo que a tela lê.
 */
describe("POST /api/v1/contacts — o 409 chega inteiro ao corpo da resposta", () => {
  // A rota valida E.164; a forma canônica dele é a que o índice guarda.
  const TELEFONE_E164 = "+5532984793302";

  beforeEach(() => {
    vi.mocked(requireRole).mockResolvedValue({
      ok: true,
      user: {
        id: USUARIO,
        email: "agente@example.com",
        full_name: null,
        avatar_url: null,
        is_platform_admin: false,
        idioma: "pt-BR" as const,
        organizations: [{ organization_id: ORG, organization_name: "Org", role: "agent" }],
      },
      org: { orgId: ORG, name: "Org", role: "agent" },
    });
  });

  it("telefone repetido: status 409, error.code contact_exists e error.details.contact_id do contato existente", async () => {
    vi.mocked(createClient).mockResolvedValue(
      clienteFalso({
        contatos: [{ id: EXISTENTE, organization_id: ORG, phone_number: canonicalPhoneBR(TELEFONE_E164) }],
      }) as never,
    );
    const { POST } = await import("@/app/api/v1/contacts/route");

    const res = await POST(
      new NextRequest("http://localhost/api/v1/contacts", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "Ana", phone_number: TELEFONE_E164 }),
      }),
    );

    expect(res.status).toBe(409);
    const corpo = (await res.json()) as {
      error: { code: string; message: string; details?: Record<string, unknown> };
    };
    expect(corpo.error.code).toBe("contact_exists");
    expect(corpo.error.details).toEqual({ contact_id: EXISTENTE });
    // É esta frase que o toast mostra: `contact_exists` não tem entrada própria
    // em `components/feedback/ApiErrorToast.tsx`, então passa o texto da rota.
    expect(corpo.error.message).toBe("Já existe um contato com este telefone.");
  });
});
