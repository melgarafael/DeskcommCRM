/**
 * #4871 (F2 do #3868) — os PORTÕES DE BIBLIOTECA recebem a empresa.
 *
 * `seModuloB2bDesligado`, `seSetoresDesligado` e `seAvisosDesligado` decidiam só
 * pela instalação. Agora recebem a organização como parámetro OPCIONAL: quem tem
 * a empresa em mãos a passa e a decisão é a de `moduloLigado` — linha da empresa
 * vence, ausência herda a instalação, instalação desligada é teto, leitura que
 * falha fecha. Quem chama como antes (dois argumentos) vê o comportamento de
 * sempre.
 *
 * O banco aqui é o real? Não: `createAdminClient` é trocado por um fake que
 * responde `platform_config`, `organization_modules` e `modulos_instalados`, e a
 * DECISÃO que roda é a de verdade (`lib/instalacao/modulos.ts`) — o teste mede o
 * portão inteiro, não um mock do portão.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";

const cena = vi.hoisted(() => ({
  /** Linhas de `platform_config` — as flags da INSTALAÇÃO. */
  flags: [] as Array<{ chave: string; valor: string }>,
  /** Linhas de `organization_modules` — a EXCEÇÃO da empresa. */
  linhas: [] as Array<{ modulo: string; estado: string }>,
  /** A leitura da empresa falhou (policy, rede, tabela ausente). */
  falhaDaEmpresa: false,
}));

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => {
    const from = (tabela: string) => {
      const resposta = (): Promise<{ data: unknown; error: unknown }> => {
        if (tabela === "platform_config") return Promise.resolve({ data: cena.flags, error: null });
        if (tabela === "organization_modules") {
          return cena.falhaDaEmpresa
            ? Promise.resolve({ data: null, error: { code: "42501", message: "negado" } })
            : Promise.resolve({ data: cena.linhas, error: null });
        }
        return Promise.resolve({ data: [], error: null });
      };
      const builder: Record<string, unknown> = {};
      builder.select = () => builder;
      builder.in = () => builder;
      builder.eq = () => builder;
      builder.then = (ok: (v: unknown) => unknown, bad?: (e: unknown) => unknown) =>
        resposta().then(ok, bad);
      return builder;
    };
    return { from } as unknown as SupabaseClient;
  },
}));

import { seSetoresDesligado } from "@/lib/atendimento/setores-modulo";
import { seAvisosDesligado } from "@/lib/avisos/modulo";
import { seModuloB2bDesligado } from "@/lib/crm-b2b/route-helpers";

interface Portao {
  readonly nome: "crm_b2b" | "setores" | "avisos";
  readonly chave: string;
  readonly chamar: (organizacaoId?: string | null) => Promise<Response | null>;
}

const PORTOES: readonly Portao[] = [
  {
    nome: "crm_b2b",
    chave: "MODULO_CRM_B2B",
    chamar: (org) => seModuloB2bDesligado("req-4871", org),
  },
  {
    nome: "setores",
    chave: "MODULO_SETORES",
    chamar: (org) => seSetoresDesligado("req-4871", org),
  },
  {
    nome: "avisos",
    chave: "MODULO_AVISOS",
    chamar: (org) => seAvisosDesligado("req-4871", org),
  },
];

const EMPRESA = "11111111-1111-4111-8111-111111111111";

/** A instalação e a linha da empresa, como o banco devolveria. */
function cenario(instalacao: boolean, linha?: "ligado" | "desligado", portao?: Portao) {
  cena.flags = instalacao && portao ? [{ chave: portao.chave, valor: "ligado" }] : [];
  cena.linhas = linha && portao ? [{ modulo: portao.nome, estado: linha }] : [];
  cena.falhaDaEmpresa = false;
}

beforeEach(() => {
  cena.flags = [];
  cena.linhas = [];
  cena.falhaDaEmpresa = false;
});

describe.each(PORTOES)("$nome — o portão recebe a empresa (#4871)", (portao) => {
  it("instalação ligada + empresa ligada → passa", async () => {
    cenario(true, "ligado", portao);
    expect(await portao.chamar(EMPRESA)).toBeNull();
  });

  it("instalação ligada + empresa DESLIGADA → 404 (a linha da empresa vence)", async () => {
    cenario(true, "desligado", portao);
    const res = await portao.chamar(EMPRESA);
    expect(res).not.toBeNull();
    expect(res?.status).toBe(404);
    await expect(res?.json()).resolves.toMatchObject({ error: { code: "not_found" } });
  });

  it("instalação DESLIGADA + empresa ligada → 404 (a instalação é teto)", async () => {
    cenario(false, "ligado", portao);
    expect((await portao.chamar(EMPRESA))?.status).toBe(404);
  });

  it("empresa sem linha → herda a instalação ligada e passa", async () => {
    cenario(true, undefined, portao);
    expect(await portao.chamar(EMPRESA)).toBeNull();
  });

  it("falha de leitura da empresa → 404 (nega)", async () => {
    cenario(true, "ligado", portao);
    cena.falhaDaEmpresa = true;
    expect((await portao.chamar(EMPRESA))?.status).toBe(404);
  });

  it("consumidor antigo, sem a empresa: continua só a instalação (a linha da empresa não o barra)", async () => {
    // É a prova do parâmetro OPCIONAL: 24 + 1 chamadores de rota perguntam
    // antes de saber de que empresa é a requisição. Comportamento de HOJE.
    cenario(true, "desligado", portao);
    expect(await portao.chamar()).toBeNull();
    expect(await portao.chamar(null)).toBeNull();
  });

  it("consumidor antigo, sem a empresa: instalação desligada continua barrando", async () => {
    cenario(false, "ligado", portao);
    expect((await portao.chamar())?.status).toBe(404);
  });
});

describe("quem aplica a empresa — o único chamador com ela antes do portão", () => {
  it("o filtro por setor da lista de tarefas passa a organização que já recebeu", () => {
    const rota = readFileSync("app/api/v1/tasks/route.ts", "utf8");
    expect(rota).toContain("seSetoresDesligado(requestId, organizationId)");
  });
});
