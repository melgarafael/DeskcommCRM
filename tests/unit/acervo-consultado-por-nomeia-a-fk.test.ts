/**
 * O SELO "CONSULTADO POR" MENTIA PARA O ACERVO INTEIRO (issue #2236).
 *
 * ## O defeito
 *
 * `app/app/ai/knowledge/sources/page.tsx` fazia
 * `.select("..., ai_agent_versions!inner(id, knowledge_source_ids)")` a partir
 * de `ai_agents`. Existem DUAS FK entre as duas tabelas —
 * `ai_agent_versions_agent_id_fkey` (as versões do agente) e
 * `ai_agents_published_version_id_fkey` (a publicada) — e `!inner` não diz
 * QUAL: o PostgREST responde PGRST201 ("more than one relationship was found").
 *
 * A página desestruturava só `{ data }`, então o erro foi para o lixo junto com
 * o resultado, `agentesRaw` virou `[]` e TODO material apareceu com
 * "Consultado por: nenhum assistente ainda" — inclusive os que os agentes
 * publicados leem em conversa real pelo WhatsApp.
 *
 * ## Por que três casos, e não um
 *
 * Só testar o mapping passaria com o embed ambíguo de volta (o mapping não
 * consulta nada); só testar o SELECT passaria com o `error` engolido de novo.
 * O trio prende as duas metades do defeito: a FK nomeada, o erro que deixa
 * rastro com a CAUSA, e a página que continua usando este construtor em vez de
 * embutir a tabela sozinha.
 */
import fs from "node:fs";
import path from "node:path";

import type { SupabaseClient } from "@supabase/supabase-js";
import { beforeEach, describe, expect, it, vi } from "vitest";

const RAIZ = path.resolve(__dirname, "../..");
const PASTAS = ["app", "lib", "components", "hooks", "workers"];

function arquivos(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return e.name === "node_modules" ? [] : arquivos(p);
    return /\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name) ? [p] : [];
  });
}

const erros: Array<{ msg: string; ctx: Record<string, unknown> }> = [];
vi.mock("@/lib/logger", () => ({
  logger: {
    error: (msg: string, ctx: Record<string, unknown>) => erros.push({ msg, ctx }),
    warn: () => {},
    info: () => {},
    debug: () => {},
  },
}));

/** O que o duplo do Supabase leu — é isto que o PostgREST receberia. */
const consultas: Array<{ tabela: string; select: string; filtros: string[] }> = [];
const resposta: {
  atual: { data: unknown; error: { code: string; message: string } | null };
} = { atual: { data: [], error: null } };

function supabaseFalso(): SupabaseClient {
  const builder = {
    select: (colunas: string) => {
      consultas[consultas.length - 1]!.select = colunas;
      return builder;
    },
    eq: (campo: string, valor: unknown) => {
      consultas[consultas.length - 1]!.filtros.push(`${campo}=${String(valor)}`);
      return builder;
    },
    is: (campo: string, valor: unknown) => {
      consultas[consultas.length - 1]!.filtros.push(`${campo} is ${String(valor)}`);
      return Promise.resolve(resposta.atual);
    },
  };
  return {
    from: (tabela: string) => {
      consultas.push({ tabela, select: "", filtros: [] });
      return builder;
    },
  } as unknown as SupabaseClient;
}

const { COLUNAS_AGENTES_QUE_USAM, listarAgentesQueUsam, montarAgentesQueUsam } =
  await import("@/lib/ai/knowledge/agentes-que-usam");

beforeEach(() => {
  erros.length = 0;
  consultas.length = 0;
  resposta.atual = { data: [], error: null };
});

describe("o embed da tela do acervo", () => {
  it("nomeia a FK da versão publicada — `!inner` sozinho é PGRST201", async () => {
    const { agentes, erro } = await listarAgentesQueUsam(supabaseFalso(), "org-1");

    expect(consultas).toHaveLength(1);
    expect(consultas[0]!.tabela).toBe("ai_agents");
    expect(consultas[0]!.select).toContain(
      "ai_agent_versions!ai_agents_published_version_id_fkey(id, knowledge_source_ids)",
    );
    expect(consultas[0]!.select).not.toMatch(/ai_agent_versions\s*!\s*inner/);
    // O escopo continua sendo a organização da pessoa, e só agentes vivos.
    expect(consultas[0]!.filtros).toEqual(["organization_id=org-1", "archived_at is null"]);
    expect(agentes).toEqual([]);
    expect(erro).toBeNull();
    expect(erros).toEqual([]);
  });

  it("a página usa o construtor e não embute a tabela sozinha", () => {
    const fonte = fs.readFileSync(path.join(RAIZ, "app/app/ai/knowledge/sources/page.tsx"), "utf8");
    expect(fonte).toContain("listarAgentesQueUsam(supabase, activeOrg.orgId)");
    expect(fonte).not.toMatch(/ai_agent_versions\s*!\s*inner/);
    expect(COLUNAS_AGENTES_QUE_USAM).toContain("!ai_agents_published_version_id_fkey");
  });
});

describe("o erro da consulta", () => {
  it("PGRST201 deixa rastro com a CAUSA, o código e a organization_id", async () => {
    resposta.atual = {
      data: null,
      error: {
        code: "PGRST201",
        message:
          'More than one relationship was found between the tables "ai_agents" and "ai_agent_versions"',
      },
    };

    const { agentes, erro } = await listarAgentesQueUsam(supabaseFalso(), "org-9");

    // A ação não muda: degrada para lista vazia (a tela não pode quebrar).
    expect(agentes).toEqual([]);
    expect(erro).toContain("relationship");
    // Mas some com o "nenhum assistente ainda" sem deixar pista? Não: o log é o pista.
    expect(erros).toHaveLength(1);
    expect(erros[0]!.msg).toMatch(/\[ai\/knowledge\]/);
    expect(erros[0]!.msg).toMatch(/nenhum assistente ainda/);
    // Sem organization_id a linha não diz de QUE instalação é; sem o code não
    // distingue ambiguidade de embed (PGRST201) de RLS ou de rede.
    expect(erros[0]!.ctx).toMatchObject({
      organization_id: "org-9",
      code: "PGRST201",
    });
    expect(String(erros[0]!.ctx.detail)).toContain("relationship");
  });

  it("sem erro não registra nada — o log só existe para incidente", async () => {
    const { erro } = await listarAgentesQueUsam(supabaseFalso(), "org-1");

    expect(erro).toBeNull();
    expect(erros).toEqual([]);
  });
});

describe("o mapeamento da versão publicada", () => {
  it("quem publicou material vira agente que usa o acervo", () => {
    expect(
      montarAgentesQueUsam([
        {
          id: "agente-1",
          name: "Vendas",
          versao_publicada: { id: "v2", knowledge_source_ids: ["ks-1", "ks-2"] },
        },
      ]),
    ).toEqual([{ id: "agente-1", nome: "Vendas", materiais: ["ks-1", "ks-2"] }]);
  });

  it("sem versão publicada, sem material ou sem lista não entram na lista", () => {
    expect(
      montarAgentesQueUsam([
        { id: "rascunho", name: "Rascunho", versao_publicada: null },
        { id: "vazio", name: "Vazio", versao_publicada: { id: "v1", knowledge_source_ids: [] } },
        { id: "nulo", name: "Nulo", versao_publicada: { id: "v3", knowledge_source_ids: null } },
      ]),
    ).toEqual([]);
  });
});

describe("vigia: nenhum arquivo embute ai_agent_versions a partir de ai_agents sem nomear a FK", () => {
  it("reprova o embed ambíguo (`!inner` não é nome de FK)", () => {
    const padrao = /ai_agent_versions\s*(?:!\s*(?:inner|left|right|outer)\s*)?\(/;
    const sql = /(?:insert into|update|delete from|from)\s+ai_agent_versions\s*\(/;

    const culpados: string[] = [];
    for (const pasta of PASTAS) {
      for (const arquivo of arquivos(path.join(RAIZ, pasta))) {
        const src = fs.readFileSync(arquivo, "utf8");
        if (!src.includes('.from("ai_agents")')) continue;
        src.split("\n").forEach((linha, i) => {
          if (sql.test(linha)) return;
          if (padrao.test(linha)) {
            culpados.push(`${path.relative(RAIZ, arquivo)}:${i + 1} → ${linha.trim()}`);
          }
        });
      }
    }

    expect(culpados).toEqual([]);
  });
});
