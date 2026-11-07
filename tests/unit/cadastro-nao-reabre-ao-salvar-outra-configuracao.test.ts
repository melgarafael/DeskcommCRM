/**
 * ═══ SALVAR OUTRA CONFIGURAÇÃO NÃO REABRE O CADASTRO ════════════════════════
 *
 * Issue #4244. `platform_settings` é singleton (`id = 1`) e guarda `signup_mode`
 * junto com as outras escolhas da instalação. A leitura
 * (`lib/auth/politica-de-cadastro.ts`) obedece a esta precedência:
 *
 *     linha salva  >  `.env` (SIGNUP_MODE)  >  default do produto (`aberto`)
 *
 * Quando NÃO existe linha, quem responde é o `.env` — é assim que uma
 * instalação nasce fechada só por `SIGNUP_MODE=so_convite`, sem nunca ter aberto
 * `/admin/cadastro`. O defeito: os gravadores de OUTRAS configurações fazem
 * `upsert` na linha singleton sem citar `signup_mode`; o primeiro deles CRIA a
 * linha, e a coluna nasce com o default `'aberto'` (`supabase/baseline.sql`).
 * A partir daí a linha existe, vence o `.env`, e o cadastro reabre sozinho.
 *
 * ─── Como o dublê do banco prova isso ───────────────────────────────────────
 *
 * O dublê abaixo implementa as DUAS metades da semântica do PostgREST, porque é
 * a diferença entre elas que produz o defeito:
 *
 *   - INSERT (linha ausente): as colunas não citadas recebem o DEFAULT da
 *     coluna — `signup_mode = 'aberto'`, o resto NULL;
 *   - UPDATE (linha presente): só as colunas citadas mudam. É por isso que o
 *     defeito é de CRIAÇÃO, e não de sobrescrita, e é por isso que o conserto
 *     precisa semear a linha com o modo EM VIGOR antes do primeiro `upsert`.
 *
 * Cada caso lê o modo pelo caminho de PRODUÇÃO (`modoDeCadastro`), e não pelo
 * dublê: o que importa não é o que foi gravado, é se `/signup` continua fechado.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

// ─── O `.env` desta instalação: fechada, e nunca ninguém salvou o cadastro ──
const envMock = vi.hoisted(() => ({
  SIGNUP_MODE: "so_convite",
  WAHA_WEBHOOK_REQUIRE_SIGNATURE: "false",
  AI_BUDGET_ENFORCEMENT: "on",
  DISCLOSURE_MODE: "inject",
  PROMISE_SEMANTIC_ENABLED: "true",
  IA_DESTINOS_INTERNOS_PERMITIDOS: "",
}));
vi.mock("@/lib/env", () => ({ env: envMock }));

vi.mock("@/lib/logger", () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

/**
 * A tabela `platform_settings` de verdade: uma linha (ou nenhuma), com os
 * DEFAULTS da coluna aplicados no INSERT. `escritas` guarda a ordem, porque a
 * semente tem de vir ANTES do upsert da configuração.
 */
const banco = vi.hoisted(() => ({
  linha: null as Record<string, unknown> | null,
  escritas: [] as Array<{
    valores: Record<string, unknown>;
    opcoes: { onConflict?: string; ignoreDuplicates?: boolean } | undefined;
  }>,
  falharProximoUpsert: false,
}));

/** `supabase/baseline.sql`: `signup_mode text not null default 'aberto'`. O resto nasce NULL. */
const DEFAULTS_DA_COLUNA: Record<string, unknown> = {
  id: 1,
  signup_mode: "aberto",
  orcamento_de_ia: null,
  exigir_assinatura_no_webhook: null,
  divulgacao_de_pagamento: null,
  promessa_semantica: null,
  molde_de_ia_org_id: null,
  internal_destinations: null,
  updated_by: null,
};

function recorte(linha: Record<string, unknown> | null, colunas: string) {
  if (linha === null) return null;
  const pedidas = colunas.split(",").map((c) => c.trim());
  return Object.fromEntries(pedidas.map((c) => [c, linha[c] ?? null]));
}

function cliente() {
  return {
    from(tabela: string) {
      if (tabela !== "platform_settings") throw new Error(`tabela inesperada: ${tabela}`);
      return {
        select(colunas: string) {
          const resposta = async () => ({ data: recorte(banco.linha, colunas), error: null });
          return {
            eq: () => ({
              abortSignal: () => ({ maybeSingle: resposta }),
              maybeSingle: resposta,
            }),
          };
        },
        upsert: async (
          valores: Record<string, unknown>,
          opcoes?: { onConflict?: string; ignoreDuplicates?: boolean },
        ) => {
          banco.escritas.push({ valores, opcoes });
          if (banco.falharProximoUpsert) {
            banco.falharProximoUpsert = false;
            return { error: { code: "57014", message: "canceling statement due to statement timeout" } };
          }
          if (banco.linha === null) {
            // INSERT: o que não veio no corpo nasce com o DEFAULT da coluna.
            banco.linha = { ...DEFAULTS_DA_COLUNA, ...valores };
          } else if (!opcoes?.ignoreDuplicates) {
            // UPDATE: só as colunas citadas — as outras ficam como estão.
            banco.linha = { ...banco.linha, ...valores };
          }
          return { error: null };
        },
      };
    },
  };
}

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => cliente() }));

import {
  esquecerModoDeCadastro,
  gravarModoDeCadastro,
  modoDeCadastro,
} from "@/lib/auth/politica-de-cadastro";
import { gravarDestinosInternos } from "@/lib/automation/destinos-internos-autorizados";
import { gravarComportamentoDaInstalacao } from "@/lib/instalacao/comportamento-servidor";
import { gravarMoldeDeIa } from "@/lib/instalacao/molde-de-ia-servidor";

const COMPORTAMENTO = {
  orcamento_de_ia: "off",
  exigir_assinatura_no_webhook: true,
  divulgacao_de_pagamento: "veto",
  promessa_semantica: false,
} as const;

/** Instalação que nunca salvou nada: sem linha, e o `.env` manda. */
function instalacaoNova() {
  banco.linha = null;
  banco.escritas = [];
  banco.falharProximoUpsert = false;
  esquecerModoDeCadastro();
}

beforeEach(() => {
  vi.clearAllMocks();
  envMock.SIGNUP_MODE = "so_convite";
  instalacaoNova();
});

describe("os três gravadores que não falam de signup_mode (#4244)", () => {
  const gravadores: Array<[string, () => Promise<boolean>]> = [
    ["comportamento (/admin/sistema)", () => gravarComportamentoDaInstalacao({ ...COMPORTAMENTO }, "u1")],
    ["molde de IA (/admin/sistema)", () => gravarMoldeDeIa(cliente() as never, "org-molde", "u1")],
    ["destinos internos (/admin/destinos-internos)", () => gravarDestinosInternos(["https://93.184.216.34/hook"], "u1")],
  ];

  for (const [nome, gravar] of gravadores) {
    it(`${nome}: salvar NÃO reabre o cadastro fechado pelo .env`, async () => {
      // A porta está fechada antes de salvar: sem linha, vale o `.env`.
      await expect(modoDeCadastro()).resolves.toBe("so_convite");

      await expect(gravar()).resolves.toBe(true);

      // O banco envelhece: nova requisição/novo processo (o memo de 30 s some).
      esquecerModoDeCadastro();
      await expect(modoDeCadastro()).resolves.toBe("so_convite");
      expect(banco.linha?.signup_mode).toBe("so_convite");
    });
  }

  it("a semente vem ANTES do upsert, e não sobrescreve linha existente", async () => {
    banco.linha = { ...DEFAULTS_DA_COLUNA, signup_mode: "so_convite" };

    await expect(gravarComportamentoDaInstalacao({ ...COMPORTAMENTO }, "u1")).resolves.toBe(true);

    expect(banco.escritas.map((e) => e.opcoes?.ignoreDuplicates ?? false)).toEqual([true, false]);
    expect(banco.linha?.signup_mode).toBe("so_convite");
    expect(banco.linha?.orcamento_de_ia).toBe("off");
  });

  it("linha já salva 'aberto' vence o .env: salvar outra configuração não fecha nada", async () => {
    // A precedência é linha > .env > default, nos DOIS sentidos. Um gravador de
    // outra configuração não pode "corrigir" a escolha de quem administra.
    banco.linha = { ...DEFAULTS_DA_COLUNA, signup_mode: "aberto" };

    await expect(gravarMoldeDeIa(cliente() as never, "org-molde", "u1")).resolves.toBe(true);

    esquecerModoDeCadastro();
    await expect(modoDeCadastro()).resolves.toBe("aberto");
  });

  it("semente recusada pelo banco ⇒ a gravação é recusada, nunca em silêncio", async () => {
    banco.falharProximoUpsert = true;

    await expect(gravarComportamentoDaInstalacao({ ...COMPORTAMENTO }, "u1")).resolves.toBe(false);

    // Sem a semente não houve upsert de configuração: a linha continua ausente,
    // e a próxima tentativa ainda pode semear direito.
    expect(banco.linha).toBeNull();
    expect(banco.escritas).toHaveLength(1);
    esquecerModoDeCadastro();
    await expect(modoDeCadastro()).resolves.toBe("so_convite");
  });
});

describe("/admin/cadastro continua sendo a tela que muda o modo", () => {
  it("fechar pelo .env e abrir pela tela: a linha salva vence", async () => {
    await expect(modoDeCadastro()).resolves.toBe("so_convite");

    await expect(gravarModoDeCadastro("aberto", "u1")).resolves.toBe(true);

    esperarLinhaComModo("aberto");
  });

  it("trocar para 'com_aprovacao' pela tela também vale", async () => {
    banco.linha = { ...DEFAULTS_DA_COLUNA, signup_mode: "so_convite" };

    await expect(gravarModoDeCadastro("com_aprovacao", "u1")).resolves.toBe(true);

    esperarLinhaComModo("com_aprovacao");
  });

  it("depois da tela, salvar OUTRA configuração preserva o modo escolhido", async () => {
    await gravarModoDeCadastro("so_convite", "u1");
    await gravarDestinosInternos([], "u1");

    esperarLinhaComModo("so_convite");
  });
});

/** O modo em vigor, lido do banco pelo caminho de produção. */
async function esperarLinhaComModo(modo: string) {
  esquecerModoDeCadastro();
  await expect(modoDeCadastro()).resolves.toBe(modo);
  expect(banco.linha?.signup_mode).toBe(modo);
}
