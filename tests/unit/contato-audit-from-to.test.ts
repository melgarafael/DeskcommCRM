import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * L-06 — AUDIT COM `from/to`, EXCEÇÃO "NENHUMA".
 *
 * A regra escrita no catálogo do produto exige, em toda mutação de
 * `contacts.email`, `phone_number`, `cpf` e `consent`, uma entrada em
 * `api_audit_log` com **who / what / which / when / from / to**.
 *
 * O handler gravava só `fields: ["email"]` — os NOMES dos campos alterados.
 * Quem quisesse saber QUAL e-mail foi substituído não tinha onde olhar, e essa é
 * exatamente a pergunta que a fila de confirmação (spec 17 §4b) precisa
 * responder: sem o valor anterior, um e-mail dito de brincadeira apaga o correto
 * e não há como voltar.
 *
 * Aqui e não no invariante de banco porque `audit()` cria o PRÓPRIO client admin
 * (lib/audit/index.ts:55) e o `vitest.db.config.ts` aponta o Supabase para uma
 * porta inalcançável de propósito — a linha nunca chegaria ao Postgres de teste.
 * O que se mede é o que o handler MANDA auditar.
 *
 * Grafia `old_`/`new_` seguindo `team.role_changed`
 * (app/api/v1/team/[user_id]/_shared.ts:93-94, com guarda em
 * `tests/unit/team-role-change.test.ts`). O repo tem mais de uma grafia para
 * este conceito; escolher a que já é vigiada evita criar mais uma.
 */

/**
 * Tipado com o parâmetro de verdade: `vi.fn(async () => undefined)` infere
 * `[]` como tupla de argumentos, e `mock.calls.at(-1)?.[0]` vira erro de tipo
 * ("tuple of length 0 has no element at index 0"). O espião precisa declarar o
 * que espia.
 */
const auditSpy = vi.fn(async (_entrada: { metadata?: Record<string, unknown> }) => undefined);

vi.mock("@/lib/audit", () => ({
  audit: auditSpy,
  isServiceRoleConfigured: () => false,
  hashEmail: (e: string) => e,
}));

const ORG = "c05e7a00-0000-4000-8000-000000000001";
const CONTATO = "c05e7a00-0000-4000-8000-0000000000c1";
const USUARIO = "c05e7a00-0000-4000-8000-0000000000a1";

/** O contato como ele está no banco ANTES do PATCH. */
let estadoAtual: Record<string, unknown>;

/**
 * Client de mentira, do tamanho exato do que `patchContactHandler` usa:
 * um SELECT de pré-condição, um UPDATE com retorno, e `rpc` para o evento.
 */
function clienteFalso(): unknown {
  return {
    from: () => ({
      select: () => { const chain = { eq: () => chain, maybeSingle: async () => ({ data: estadoAtual, error: null }) }; return chain; },
      update: (patch: Record<string, unknown>) => { const chain = { eq: () => chain, select: () => chain, maybeSingle: async () => ({ data: { ...estadoAtual, ...patch }, error: null }) }; return chain; },
    }),
    rpc: () => ({ then: (r: (v: unknown) => unknown) => r({ error: null }) }),
  };
}

async function patch(input: Record<string, unknown>): Promise<Record<string, unknown>> {
  const { patchContactHandler } = await import("@/app/api/v1/contacts/_handler");
  await patchContactHandler(
    clienteFalso() as never,
    { organization_id: ORG, actor: { type: "user", id: USUARIO }, requestId: "req-1" },
    CONTATO,
    input as never,
  );
  return auditSpy.mock.calls.at(-1)?.[0]?.metadata ?? {};
}

beforeEach(() => {
  auditSpy.mockClear();
  estadoAtual = {
    id: CONTATO,
    organization_id: ORG,
    is_anonymized: false,
    tags: [],
    email: "velho@exemplo.com",
    phone_number: "+5531988887777",
    name: "Nome Velho",
    display_name: "Velho",
    consent: {},
  };
});

describe("o handler MANDA auditar o par antes/depois", () => {
  it("o espião está ligado — sem isto, todo caso abaixo lê `{}` e passa medindo nada", async () => {
    // Controle positivo do instrumento. Se o mock de `@/lib/audit` deixasse de
    // interceptar (mudança de caminho do import, por exemplo), `metadata` viria
    // vazio e as asserções de "não tem old_x" abaixo passariam TODAS.
    await patch({ email: "novo@exemplo.com" });
    expect(auditSpy, "audit() precisa ter sido chamado").toHaveBeenCalled();
  });

  it("troca de e-mail leva o valor ANTERIOR e o NOVO", async () => {
    const m = await patch({ email: "novo@exemplo.com" });
    expect(m.old_email, "sem o `from`, ninguém sabe o que foi substituído").toBe("velho@exemplo.com");
    expect(m.new_email).toBe("novo@exemplo.com");
  });

  it("telefone e nome também — são os campos que a L-06 nomeia", async () => {
    const m = await patch({ phone_number: "+5531900001111", name: "Nome Novo" });
    expect(m.old_phone_number).toBe("+5531988887777");
    expect(m.new_phone_number).toBe("+5531900001111");
    expect(m.old_name).toBe("Nome Velho");
    expect(m.new_name).toBe("Nome Novo");
  });

  it("campo enviado com o MESMO valor não entra — audit é lido por humano", async () => {
    // Despejar todos os campos a cada PATCH afogaria a mudança que importa no
    // meio das que não aconteceram.
    const m = await patch({ email: "velho@exemplo.com", name: "Nome Novo" });
    expect(m).not.toHaveProperty("old_email");
    expect(m.new_name).toBe("Nome Novo");
  });

  it("campo NÃO enviado não entra", async () => {
    const m = await patch({ name: "Só o Nome" });
    expect(m).not.toHaveProperty("old_email");
    expect(m).not.toHaveProperty("old_phone_number");
  });

  it("consentimento registra QUAL finalidade mudou, não o jsonb cru", async () => {
    // O valor é um mapa de finalidades; o que se audita é qual delas foi tocada.
    // Copiar o objeto inteiro colocaria PII e histórico dentro do log.
    const m = await patch({
      consent: { transactional: { granted: true, granted_at: "2026-08-06T00:00:00Z" } },
    });
    expect(m.consent_scopes).toEqual(["transactional"]);
  });

  it("a lista de campos alterados continua lá — o novo não substitui o que existia", async () => {
    const m = await patch({ email: "novo@exemplo.com" });
    expect(m.fields).toContain("email");
  });
});
