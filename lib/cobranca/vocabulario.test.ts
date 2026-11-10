import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { COLUNAS_DO_PLANO, novoPlanoSchema } from "@/lib/schemas/cobranca-plano";

import {
  declararPlano,
  limitesDaTela,
  limiteDoPlano,
  recursosDoPlano,
  RecursoForaDoVocabulario,
} from "./planos";
import { RECURSOS, RECURSOS_DO_PLANO, type RecursoDoPlano } from "./vocabulario";

/**
 * O VOCABULÁRIO DE RECURSOS É A FONTE ÚNICA DO LIMITE DO PLANO (#4172, fatia 1).
 *
 * Antes: a lista de recursos vivia solta (`RECURSOS_DO_PLANO`, vocabulario.ts:38)
 * e a coluna de cada teto só existia no `case` de `fn_limite_do_plano` — quem
 * quisesse um recurso novo repetia o nome da coluna no schema, no SELECT do
 * painel e no formulário. Agora cada recurso DECLARA a sua coluna e o seu piso
 * (`RECURSOS`), o plano declara os seus recursos (`declararPlano`) e o limite é
 * DERIVADO dessa declaração (`limiteDoPlano`) — não o contrário.
 *
 * A compatibilidade é DURA: os planos que existem hoje têm de continuar com os
 * MESMOS limites. A tabela abaixo é a régua: os números da esquerda são os de
 * hoje, copiados de `curso/semear/admin-cobranca.ts:76-79` (os mesmos de
 * `curso/semear/plano-e-cobranca.ts:20-22`); os da direita são o que a derivação
 * devolve a partir da linha que o banco guarda.
 */

const baseline = readFileSync(join(process.cwd(), "supabase", "baseline.sql"), "utf8");

/** O corpo de `fn_limite_do_plano` no baseline — o lado SQL do mesmo vocabulário. */
function corpoDaLimiteDoPlano(): string {
  const ini = baseline.indexOf("create or replace function public.fn_limite_do_plano");
  expect(ini, "fn_limite_do_plano sumiu do baseline").toBeGreaterThan(-1);
  const fim = baseline.indexOf("$$;", ini);
  expect(fim, "fn_limite_do_plano sem fecho $$;").toBeGreaterThan(ini);
  return baseline.slice(ini, fim);
}

/** O bloco `create table public.cobranca_planos ( ... );` do baseline. */
function blocoDaTabelaDePlanos(): string {
  const ini = baseline.indexOf("create table if not exists public.cobranca_planos (");
  expect(ini, "cobranca_planos sumiu do baseline").toBeGreaterThan(-1);
  const fim = baseline.indexOf(");", ini);
  expect(fim).toBeGreaterThan(ini);
  return baseline.slice(ini, fim);
}

describe("o vocabulário de recursos", () => {
  it("é uma declaração por recurso, com coluna, piso e rótulo — e nada de lista paralela", () => {
    expect(RECURSOS_DO_PLANO).toEqual(["assentos", "canais", "ia_usd_cents"]);
    expect(new Set(RECURSOS_DO_PLANO).size).toBe(RECURSOS_DO_PLANO.length);

    const colunas = RECURSOS_DO_PLANO.map((r) => RECURSOS[r].coluna);
    expect(new Set(colunas).size, "duas declarações apontando para a MESMA coluna").toBe(colunas.length);
    for (const r of RECURSOS_DO_PLANO) {
      expect(RECURSOS[r].minimo, `${r}: piso do CHECK`).toBeGreaterThan(0);
      expect(RECURSOS[r].rotulo.length, `${r}: rótulo vazio`).toBeGreaterThan(0);
    }
    console.log(
      `[vocabulário] ${RECURSOS_DO_PLANO.length} recursos: ` +
        RECURSOS_DO_PLANO.map((r) => `${r}→${RECURSOS[r].coluna} (>=${RECURSOS[r].minimo})`).join(", "),
    );
  });
});

describe("o schema da rota e o SELECT derivam do MESMO vocabulário", () => {
  it("COLUNAS_DO_PLANO traz a coluna de CADA recurso declarado (nenhuma fica de fora)", () => {
    const colunas = new Set(COLUNAS_DO_PLANO.split(",").map((c) => c.trim()));
    for (const recurso of RECURSOS_DO_PLANO) {
      expect(colunas.has(RECURSOS[recurso].coluna), `${recurso}: ${RECURSOS[recurso].coluna} fora do SELECT`).toBe(true);
    }
  });

  it("o zod aceita o piso do vocabulário e recusa um abaixo dele — no campo certo", () => {
    const base = { nome: "Essencial", preco_cents: 4_990, intervalo: "mes" as const, trial_dias: 14 };
    for (const recurso of RECURSOS_DO_PLANO) {
      const { coluna, minimo } = RECURSOS[recurso];
      expect(novoPlanoSchema.safeParse({ ...base, [coluna]: minimo }).success, `${recurso}=${minimo}`).toBe(true);

      const abaixo = novoPlanoSchema.safeParse({ ...base, [coluna]: minimo - 1 });
      expect(abaixo.success, `${recurso}=${minimo - 1} deveria ser recusado`).toBe(false);
      if (!abaixo.success) expect(abaixo.error.issues[0]?.path).toEqual([coluna]);
    }
  });
});

describe("o banco fala o MESMO vocabulário (baseline, sem subir Postgres)", () => {
  it("⭐ fn_limite_do_plano aceita exatamente RECURSOS_DO_PLANO", () => {
    const corpo = corpoDaLimiteDoPlano();
    const achado = /p_recurso\s+not\s+in\s*\(([^)]*)\)/i.exec(corpo);
    expect(
      achado,
      "o baseline não tem mais `p_recurso not in (...)` em fn_limite_do_plano — " +
        "se a recusa do recurso mudou de forma, o vocabulário do TypeScript ficou sem par",
    ).not.toBeNull();
    const doBanco = [...achado![1]!.matchAll(/'([^']+)'/g)].map((m) => m[1]!).sort();
    expect(doBanco).toEqual([...RECURSOS_DO_PLANO].sort());
  });

  it("⭐ o limite de cada recurso sai da COLUNA que o vocabulário declara", () => {
    const corpo = corpoDaLimiteDoPlano();
    const doBanco = new Set([...corpo.matchAll(/v_plano\.(\w+)/g)].map((m) => m[1]!));
    const declaradas = new Set(RECURSOS_DO_PLANO.map((r) => RECURSOS[r].coluna));
    expect([...doBanco].sort()).toEqual([...declaradas].sort());
  });

  it("cobranca_planos tem as colunas dos tetos, com o piso declarado (o schema zod usa o mesmo número)", () => {
    const bloco = blocoDaTabelaDePlanos();
    for (const r of RECURSOS_DO_PLANO) {
      const { coluna, minimo } = RECURSOS[r];
      expect(
        bloco,
        `cobranca_planos.${coluna} não tem \`integer check (${coluna} >= ${minimo})\` — ` +
          `o piso do vocabulário e o CHECK do banco divergiram`,
      ).toMatch(new RegExp(`${coluna} integer check \\(${coluna} >= ${minimo}\\)`));
    }
  });
});

/**
 * A RÉGUA DA COMPATIBILIDADE. Esquerda: o limite que o plano tem HOJE (a coluna
 * que `cobranca_planos` guarda, copiada do seed). Direita: o que a derivação a
 * partir dos recursos devolve. Se um dia divergirem, é regressão de cliente.
 */
const PLANOS_DE_HOJE: Array<{
  nome: string;
  linha: { id: string; nome: string; max_assentos: number | null; max_canais: number | null; teto_ia_usd_cents: number | null };
  hoje: Record<RecursoDoPlano, number | null>;
}> = [
  {
    nome: "Essencial",
    linha: { id: "be7c0000-0000-4000-8000-000000000001", nome: "Essencial", max_assentos: 3, max_canais: 1, teto_ia_usd_cents: 2_000 },
    hoje: { assentos: 3, canais: 1, ia_usd_cents: 2_000 },
  },
  {
    nome: "Profissional",
    linha: { id: "be7c0000-0000-4000-8000-000000000002", nome: "Profissional", max_assentos: 5, max_canais: 2, teto_ia_usd_cents: 5_000 },
    hoje: { assentos: 5, canais: 2, ia_usd_cents: 5_000 },
  },
  {
    nome: "Clínica Completa",
    linha: { id: "be7c0000-0000-4000-8000-000000000003", nome: "Clínica Completa", max_assentos: 10, max_canais: 3, teto_ia_usd_cents: 15_000 },
    hoje: { assentos: 10, canais: 3, ia_usd_cents: 15_000 },
  },
  {
    nome: "Rede Parceira (negociado)",
    linha: { id: "c0b40000-0000-4000-8000-0000000000a1", nome: "Rede Parceira (negociado)", max_assentos: 30, max_canais: 6, teto_ia_usd_cents: 30_000 },
    hoje: { assentos: 30, canais: 6, ia_usd_cents: 30_000 },
  },
];

describe("compatibilidade: o plano de hoje continua com o MESMO limite", () => {
  it.each(PLANOS_DE_HOJE)("$nome — limite de hoje = limite derivado dos recursos", ({ nome, linha, hoje }) => {
    const plano = declararPlano(linha);
    const depois = recursosDoPlano(plano);

    expect(depois, `${nome}: a derivação mudou o limite`).toEqual(hoje);
    expect(limitesDaTela(plano), `${nome}: o formato que o painel já consome mudou`).toEqual({
      max_assentos: linha.max_assentos,
      max_canais: linha.max_canais,
      teto_ia_usd_cents: linha.teto_ia_usd_cents,
    });
    expect(RECURSOS_DO_PLANO.length).toBe(Object.keys(depois).length);

    console.log(
      `[tabela] ${nome}: ${RECURSOS_DO_PLANO.length} recursos → ` +
        RECURSOS_DO_PLANO.map((r) => `${r}=${depois[r] ?? "sem limite"}`).join(", "),
    );
  });

  it("cada limite individual continua vindo da sua coluna, recurso por recurso", () => {
    for (const { nome, linha, hoje } of PLANOS_DE_HOJE) {
      const plano = declararPlano(linha);
      for (const r of RECURSOS_DO_PLANO) {
        expect(limiteDoPlano(plano, r), `${nome}/${r}`).toBe(hoje[r]);
      }
    }
  });

  it("sem teto continua SEM teto (null atravessa a derivação, não vira zero nem default)", () => {
    const isento = declararPlano({ id: "x", nome: "Sem teto", max_assentos: null, max_canais: null, teto_ia_usd_cents: null });
    expect(recursosDoPlano(isento)).toEqual({ assentos: null, canais: null, ia_usd_cents: null });
    expect(limitesDaTela(isento)).toEqual({ max_assentos: null, max_canais: null, teto_ia_usd_cents: null });
  });
});

describe("recurso fora do vocabulário NÃO cai em default", () => {
  // criado dentro de cada teste: um recurso inventado no vocabulário já estoura
  // aqui na COLETA se isto for de módulo, e a suíte inteira vira "0 test".
  const umPlano = () =>
    declararPlano({ id: "x", nome: "Essencial", max_assentos: 3, max_canais: 1, teto_ia_usd_cents: 2_000 });

  it("⭐ em runtime: recusa explícita (inclusive nome herdado do prototype)", () => {
    const plano = umPlano();
    expect(() => limiteDoPlano(plano, "armazenamento" as RecursoDoPlano)).toThrow(RecursoForaDoVocabulario);
    expect(() => limiteDoPlano(plano, "toString" as RecursoDoPlano)).toThrow(RecursoForaDoVocabulario);
    expect(() => limiteDoPlano(plano, "assentos " as RecursoDoPlano)).toThrow(/armazenamento|recurso_do_plano_invalido/);
  });

  it("⭐ em compilação: o tipo recusa o recurso que o vocabulário não declara", () => {
    const plano = umPlano();
    // @ts-expect-error — "armazenamento" não é RecursoDoPlano: o compilador barra antes do runtime
    expect(() => limiteDoPlano(plano, "armazenamento")).toThrow();
  });

  it("a linha do plano também não pode chegar pela metade (SELECT sem a coluna)", () => {
    expect(() =>
      declararPlano({ id: "x", nome: "Parcial", max_assentos: 3, max_canais: 1 }),
    ).toThrow(/teto_ia_usd_cents/);
    expect(() =>
      declararPlano({ id: "x", nome: "Texto", max_assentos: 3, max_canais: "1", teto_ia_usd_cents: 2_000 }),
    ).toThrow(/max_canais/);
    expect(() =>
      declararPlano({ id: "x", nome: "Abaixo do piso", max_assentos: 3, max_canais: 1, teto_ia_usd_cents: 99 }),
    ).toThrow(/teto_ia_usd_cents/);
  });
});
