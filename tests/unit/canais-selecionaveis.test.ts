/**
 * O seletor de número não pode oferecer um canal que o usuário já excluiu.
 *
 * O defeito original não foi "esqueceram um filtro" — foi o filtro existir em
 * QUATRO cópias escritas à mão, três delas sem `archived_at is null`. Salvar um
 * roteador com o canal fantasma devolvia 404 "Número de WhatsApp não encontrado
 * nesta organização", mensagem falsa: ele está na organização, arquivado.
 *
 * Por isso são dois testes de naturezas diferentes:
 *  - o de COMPORTAMENTO garante que a função central filtra (e que erro sobe);
 *  - o de DERIVA garante que ninguém volte a escrever a consulta à mão numa tela
 *    nova — que é como as três cópias sem filtro nasceram.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

import { listSelectableChannels } from "@/lib/channels/selectable";
import type { DbErrorLike } from "@/lib/channels/archived";

type Resposta = { data: Record<string, unknown>[] | null; error: DbErrorLike | null };

interface Builder {
  select(colunas: string): Builder;
  eq(coluna: string, valor: string): Builder;
  is(coluna: string, valor: null): Builder;
  in(coluna: string, valores: readonly string[]): Builder;
  order(coluna: string, opts: { ascending: boolean }): Builder;
  then(resolve: (v: Resposta) => unknown): Promise<unknown>;
}

/**
 * Client falso que grava a consulta montada. Cada `from()` devolve um builder
 * novo e a resposta da vez — é assim que dá para observar a SEGUNDA tentativa
 * (a do fallback) sem reaproveitar um thenable já resolvido.
 */
function fakeDb(respostas: Resposta[]) {
  const chamadas: string[][] = [];
  let indice = 0;

  const build = (): Builder => {
    const trilha: string[] = [];
    chamadas.push(trilha);
    const b: Builder = {
      select(colunas) {
        trilha.push(`select(${colunas})`);
        return b;
      },
      eq(coluna, valor) {
        trilha.push(`eq(${coluna}=${valor})`);
        return b;
      },
      is(coluna, valor) {
        trilha.push(`is(${coluna}=${String(valor)})`);
        return b;
      },
      in(coluna, valores) {
        trilha.push(`in(${coluna}=[${[...valores].join("|")}])`);
        return b;
      },
      order(coluna, opts) {
        trilha.push(`order(${coluna},${opts.ascending ? "asc" : "desc"})`);
        return b;
      },
      then(resolve) {
        const r = respostas[Math.min(indice, respostas.length - 1)];
        indice += 1;
        return Promise.resolve(r as Resposta).then(resolve);
      },
    };
    return b;
  };

  const db = { from: (tabela: string) => { void tabela; return build(); } };
  return { db: db as unknown as SupabaseClient, chamadas };
}

const LINHA = {
  id: "canal-1",
  display_name: "Vendas",
  status: "WORKING",
  phone_number: "5511999999999",
  waha_session_name: "org_1111_aaa",
};

describe("listSelectableChannels", () => {
  it("pede só canal NÃO arquivado, e sempre da organização", async () => {
    const { db, chamadas } = fakeDb([{ data: [LINHA], error: null }]);

    await listSelectableChannels(db, "org-1");

    const trilha = chamadas[0]?.join(" ") ?? "";
    expect(trilha).toContain("eq(organization_id=org-1)");
    expect(trilha).toContain("is(archived_at=null)");
  });

  it("banco sem a migration 0106: repete sem o filtro em vez de devolver lista vazia", async () => {
    const { db, chamadas } = fakeDb([
      { data: null, error: { code: "42703", message: "column channel_sessions.archived_at does not exist" } },
      { data: [LINHA], error: null },
    ]);

    const canais = await listSelectableChannels(db, "org-1");

    expect(canais).toHaveLength(1);
    expect(chamadas).toHaveLength(2);
    expect(chamadas[1]?.join(" ")).not.toContain("is(archived_at");
  });

  it("erro de verdade SOBE — seletor vazio é indistinguível de 'org sem número'", async () => {
    const { db } = fakeDb([{ data: null, error: { code: "42501", message: "permission denied" } }]);

    await expect(listSelectableChannels(db, "org-1")).rejects.toThrow(/permission denied/);
  });

  it("canal sem apelido nem sessão (o oficial) não vira opção em branco", async () => {
    const { db } = fakeDb([
      {
        data: [{ ...LINHA, display_name: null, waha_session_name: null }],
        error: null,
      },
      { data: [], error: null },
    ]);

    const canais = await listSelectableChannels(db, "org-1");

    expect(canais[0]?.display_name).toBe("5511999999999");
  });

  it("canal sem apelido NÃO é batizado com o identificador do transporte", async () => {
    // ⚠️ O caso acima zerava `waha_session_name` junto, então nunca exercitou o
    // degrau que tinha o defeito. Medido percorrendo o produto: o seletor
    // "Número conectado" do editor de agente oferecia a opção `org_2dd5e6ea`
    // — o identificador que NÓS geramos para o transporte, exposto como se
    // fosse o nome do número da pessoa.
    const { db } = fakeDb([
      {
        data: [
          {
            ...LINHA,
            display_name: null,
            phone_number: null,
            waha_session_name: "org_2dd5e6ea_aaa",
          },
        ],
        error: null,
      },
      { data: [], error: null },
    ]);

    const canais = await listSelectableChannels(db, "org-1");

    expect(canais[0]?.display_name).not.toContain("org_");
    expect(canais[0]?.display_name).toBe("Número sem nome");
  });

  it("a linha de chamada de voz não é oferecida como canal de mensagem", async () => {
    // O seletor lê `channel_sessions`, e a sessão de voz mora lá também. Sem o
    // filtro por provider ela apareceria como "Número conectado" no editor de
    // agente, no roteador e no onboarding — e um agente amarrado a ela nunca
    // receberia mensagem nenhuma, com o onboarding declarando sucesso.
    //
    // Este caso guarda o FILTRO, não a saída: com a fixture devolvendo só a
    // linha de mensagem, apagar o `.in()` da fonte deixaria a saída idêntica e
    // a suíte verde. É a consulta montada que precisa provar a intenção.
    const { db, chamadas } = fakeDb([{ data: [LINHA], error: null }, { data: [], error: null }]);
    await listSelectableChannels(db, "org-1");

    const consulta = chamadas[0]?.join(" ") ?? "";
    expect(consulta).toContain("in(provider=");
    expect(consulta).toContain("waha");
    expect(consulta).not.toContain("wacalls");
  });

  it("o apelido continua vencendo tudo", async () => {
    const { db } = fakeDb([
      {
        data: [{ ...LINHA, display_name: "Vendas", waha_session_name: "org_x" }],
        error: null,
      },
      { data: [], error: null },
    ]);
    expect((await listSelectableChannels(db, "org-1"))[0]?.display_name).toBe("Vendas");
  });
});

/** Telas: onde um seletor de canal pode nascer. A API tem regras próprias. */
const RAIZES_DE_TELA = ["app/app", "app/actions", "app/onboarding", "components", "hooks"];

/** Sem try/catch: raiz que sumiu tem que explodir, não virar varredura vazia. */
function arquivosFonte(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const caminho = join(dir, e.name);
    if (e.isDirectory()) return arquivosFonte(caminho);
    return /\.tsx?$/.test(e.name) ? [caminho] : [];
  });
}

describe("deriva: nenhuma tela monta a consulta de canais à mão", () => {
  it("todo seletor de canal passa por listSelectableChannels", () => {
    const infratores = RAIZES_DE_TELA.flatMap(arquivosFonte).filter((f) =>
      /\.from\(\s*["'`]channel_sessions["'`]\s*\)/.test(readFileSync(f, "utf8")),
    );

    expect(
      infratores,
      "Consulta a channel_sessions escrita à mão numa tela: use listSelectableChannels " +
        "(lib/channels/selectable) — é ela que filtra canal excluído. Foi um select à mão " +
        "por tela que deixou três seletores oferecendo canal arquivado.",
    ).toEqual([]);
  });
});
