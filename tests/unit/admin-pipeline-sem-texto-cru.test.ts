import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A CONFIGURAÇÃO DO FUNIL NÃO DEVOLVE O ERRO DO POSTGRES PARA O TOAST (#3747).
 *
 * ─── O defeito que este arquivo prende ───────────────────────────────────────
 *
 * `updatePipelineConfig` tinha DOIS vazamentos, não um: o da issue (`:123`, a
 * gravação) e o da LEITURA logo acima — `if (readErr) return { ok: false,
 * error: readErr.message }`. O segundo é o mais provável de aparecer para quem
 * opera: é o que sai quando a sessão perde o grant ou a linha está travada, e
 * chegava ao toast como `permission denied for table crm_pipelines`.
 *
 * ─── O que os casos ⭐ medem ─────────────────────────────────────────────────
 *
 * Mesmo caminho de erro (a tela continua recebendo `{ ok: false, error }` — o
 * formulário não muda), mesmo toast, texto do mapeador; o cru inteiro no
 * `logger.error`. `JSON.stringify(resultado)` sem `error.message`, `constraint`,
 * `relation` nem `violates`.
 *
 * ─── Sabotagem que confirma que a cerca vigia ───────────────────────────────
 *
 * Devolver `{ ok: false, error: readErr.message }` (ou `error.message`) em
 * qualquer um dos dois pontos deixa o caso correspondente vermelho.
 */

const ORG = "33333333-3333-4333-8333-333333333333";
const PIPELINE = "ffffffff-0000-4000-8000-00000000000f";

const ERRO_DA_LEITURA = {
  code: "42501",
  message: 'permission denied for table "crm_pipelines"',
  details: null,
  hint: null,
};

const ERRO_DA_GRAVACAO = {
  code: "23514",
  message: 'new row for relation "crm_pipelines" violates check constraint "crm_pipelines_settings_check"',
  details: null,
  hint: null,
};

const h = vi.hoisted(() => ({
  erroDaLeitura: null as { code: string; message: string } | null,
  erroDaGravacao: null as { code: string; message: string } | null,
  gravacoes: 0,
}));

vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));
vi.mock("@/lib/impersonate/support", () => ({ supportWriteError: () => null }));
vi.mock("@/lib/auth/pode-administrar-empresa", () => ({ podeAdministrarEmpresa: () => true }));

vi.mock("@/lib/auth/server", () => ({
  loadAuthUser: async () => ({ id: "22222222-2222-4222-8222-222222222222", idioma: "pt-BR", support: null }),
  resolveActiveOrg: async () => ({ orgId: ORG, role: "admin" }),
  mfaEmDivida: async () => false,
}));

/** A leitura e a gravação usam o MESMO client de sessão, encadeado. */
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () => ({
            data: { vocabulary: null, settings: {}, organization_id: ORG },
            error: h.erroDaLeitura,
          }),
        }),
      }),
      update: (valores: Record<string, unknown>) => ({
        eq: async () => {
          h.gravacoes += 1;
          void valores;
          return { error: h.erroDaGravacao };
        },
      }),
    }),
  }),
}));

const VAZAMENTOS = ["error.message", "constraint", "relation", "violates"];

function semVazamento(resultado: unknown, erro: { message: string } | null) {
  const serializado = JSON.stringify(resultado);
  for (const proibido of VAZAMENTOS) expect(serializado.toLowerCase()).not.toContain(proibido);
  if (erro) expect(serializado).not.toContain(erro.message);
}

beforeEach(() => {
  h.erroDaLeitura = null;
  h.erroDaGravacao = null;
  h.gravacoes = 0;
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

describe("updatePipelineConfig", () => {
  it("⭐ falha na LEITURA: frase de permissão, sem o nome da tabela no toast", async () => {
    h.erroDaLeitura = ERRO_DA_LEITURA;

    const { updatePipelineConfig } = await import("@/app/actions/settings/updatePipelineConfig");
    const r = await updatePipelineConfig(PIPELINE, {});

    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("esperava recusa");
    expect(r.error).toBe("Sua conta não tem permissão para salvar esta configuração.");
    semVazamento(r, ERRO_DA_LEITURA);

    const log = vi.mocked(console.error).mock.calls.map((c) => String(c[0])).join("\n");
    expect(log).toContain("crm_pipelines");
    expect(log).toContain(PIPELINE);
  });

  it("⭐ falha na GRAVAÇÃO: a violação de CHECK cai na frase genérica de valor inválido", async () => {
    h.erroDaGravacao = ERRO_DA_GRAVACAO;

    const { updatePipelineConfig } = await import("@/app/actions/settings/updatePipelineConfig");
    const r = await updatePipelineConfig(PIPELINE, { vocabulary: { lead: "Contato" } });

    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("esperava recusa");
    expect(r.error).toBe("Um dos valores enviados não é aceito pelo servidor.");
    semVazamento(r, ERRO_DA_GRAVACAO);
    expect(h.gravacoes).toBe(1);
  });

  it("o caminho de sucesso continua devolvendo `{ ok: true }`", async () => {
    const { updatePipelineConfig } = await import("@/app/actions/settings/updatePipelineConfig");
    const r = await updatePipelineConfig(PIPELINE, { vocabulary: { lead: "Contato" } });

    expect(r).toEqual({ ok: true });
    expect(h.gravacoes).toBe(1);
  });
});
