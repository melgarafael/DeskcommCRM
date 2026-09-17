import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * O contrato da fatia S4 (issue #852), medido no TEXTO do que foi escrito — é o
 * que este pacote consegue garantir sem banco. O comportamento sob RLS e o
 * "duas orgs, mesma etiqueta" moram em `tests/invariants/tags-vocabulario.test.ts`
 * (precisa de Postgres).
 *
 * A razão de existir: cada item abaixo é uma promessa que, se cair, cai em
 * silêncio. Função nova em `public` nasce executável pela anon key (duas origens
 * de EXECUTE, CLAUDE.md) — sem revoke, ela vira RPC pública, e nada na suíte
 * grita. Regra de agente que não acompanha o rename é o defeito que a issue
 * descreve, e ele só aparece semanas depois, como etiqueta fantasma voltando.
 */

const raiz = process.cwd();
const ler = (caminho: string) => readFileSync(join(raiz, caminho), "utf8");

const MIGRATION = "supabase/migrations/20260915213849_0264_vocabulario_de_tags.sql";
const FUNCOES = [
  "public.fn_vocabulario_de_tags(uuid)",
  "public.fn_tags_normalizar(text[], text, text, boolean)",
  "public.fn_vocabulario_de_tags_operar(uuid, text, text, text)",
] as const;

describe("fatia S4 — vocabulário de tags (contrato do que foi escrito)", () => {
  it("a migration existe e cria as três funções", () => {
    expect(existsSync(join(raiz, MIGRATION))).toBe(true);
    const sql = ler(MIGRATION);
    expect(sql).toMatch(/create or replace function public\.fn_vocabulario_de_tags\(/);
    expect(sql).toMatch(/create or replace function public\.fn_tags_normalizar\(/);
    expect(sql).toMatch(/create or replace function public\.fn_vocabulario_de_tags_operar\(/);
  });

  it("as DUAS origens de EXECUTE são revogadas para cada função nova", () => {
    const sql = ler(MIGRATION);
    for (const fn of FUNCOES) {
      const escapada = fn.replace(/[[\]()]/g, (c) => `\\${c}`);
      // `from public, anon` cobre de uma vez o grant a PUBLIC que o Postgres dá
      // ao criar a função e o ALTER DEFAULT PRIVILEGES do baseline, que é o que
      // um `revoke from public` sozinho NÃO tira.
      expect(sql).toMatch(new RegExp(`revoke execute on function ${escapada} from public, anon;`));
    }
  });

  it("nenhuma função nova é concedida a anon", () => {
    const sql = ler(MIGRATION);
    expect(sql).not.toMatch(/grant\s+execute\s+on\s+function[\s\S]{0,120}?\bto\b[^;]*\banon\b/);
    for (const fn of FUNCOES) {
      const escapada = fn.replace(/[[\]()]/g, (c) => `\\${c}`);
      expect(sql).toMatch(
        new RegExp(`grant\\s+execute on function ${escapada} to authenticated, service_role;`),
      );
    }
  });

  it("a leitura devolve o uso por tabela (contatos/leads/conversas)", () => {
    const sql = ler(MIGRATION);
    for (const campo of ["uso_em_contatos", "uso_em_leads", "uso_em_conversas"]) {
      expect(sql).toMatch(new RegExp(`${campo} bigint`));
    }
    // E lê das TRÊS tabelas onde a etiqueta mora, não de uma só.
    expect(sql).toMatch(/from public\.contacts c, unnest\(coalesce\(c\.tags/);
    expect(sql).toMatch(/from public\.crm_leads l, unnest\(coalesce\(l\.tags/);
    expect(sql).toMatch(/from public\.conversations v, unnest\(coalesce\(v\.tags/);
  });

  it("a leitura inclui as sementes e as regras add_tag, e não só o que está em uso", () => {
    const sql = ler(MIGRATION);
    expect(sql).toMatch(/settings -> 'canonical_conversation_tags'/);
    expect(sql).toMatch(/acao\.valor ->> 'type' = 'add_tag'/);
    expect(sql).toMatch(/em_regras bigint/);
  });

  it("renomear/juntar/excluir atualizam as regras add_tag NA MESMA função (transação única)", () => {
    const sql = ler(MIGRATION);
    const operar = sql.slice(sql.indexOf("create or replace function public.fn_vocabulario_de_tags_operar("));
    expect(operar).toMatch(/update public\.automation_rules r/);
    expect(operar).toMatch(/'\{config,tags\}'/);
    expect(operar).toMatch(/jsonb_set\(/);
  });

  it("excluir informa quantas regras escrevem a etiqueta e não apaga nenhuma", () => {
    const sql = ler(MIGRATION);
    const operar = sql.slice(sql.indexOf("create or replace function public.fn_vocabulario_de_tags_operar("));
    // O `update` das regras está sob `if not v_remover` — a exclusão só conta.
    const posIf = operar.indexOf("if not v_remover then");
    const posUpdate = operar.indexOf("update public.automation_rules r");
    const posElse = operar.indexOf("-- Exclusão:");
    expect(posIf).toBeGreaterThan(-1);
    expect(posUpdate).toBeGreaterThan(posIf);
    expect(posElse).toBeGreaterThan(posUpdate);
  });

  it("a escrita é definer e exige manager ANTES de qualquer update", () => {
    const sql = ler(MIGRATION);
    const operar = sql.slice(sql.indexOf("create or replace function public.fn_vocabulario_de_tags_operar("));
    expect(operar).toMatch(/security definer/);
    const posGuard = operar.indexOf("fn_role_at_least(p_org, 'manager')");
    const posPrimeiroUpdate = operar.indexOf("update public.contacts");
    expect(posGuard).toBeGreaterThan(-1);
    expect(posGuard).toBeLessThan(posPrimeiroUpdate);
    // A leitura, essa, é invoker: quem recorta a organização é a RLS.
    const leitura = sql.slice(sql.indexOf("create or replace function public.fn_vocabulario_de_tags("));
    expect(leitura.slice(0, 1200)).toMatch(/security invoker/);
  });

  it("o baseline.sql recebe o apêndice idempotente das mesmas funções", () => {
    const baseline = ler("supabase/baseline.sql");
    expect(baseline).toMatch(/create or replace function public\.fn_vocabulario_de_tags_operar\(/);
    const linha = baseline.match(/revoke execute on function public\.fn_vocabulario_de_tags_operar\(uuid, text, text, text\) from public, anon;/);
    expect(linha).not.toBeNull();
  });

  it("o MANIFEST aponta a migration, como as irmãs", () => {
    const manifest = ler("supabase/migrations/MANIFEST.md");
    // O MANIFEST lista `| `<timestamp>` | `<NNNN>_<slug>` |` — sem o `.sql`.
    expect(manifest).toContain("20260915213849");
    expect(manifest).toContain("0264_vocabulario_de_tags");
  });

  it("a tela está no NAV_CATALOG, para manager, e a página existe", () => {
    const catalogo = ler("lib/navigation/catalogo.ts");
    expect(catalogo).toMatch(/href: "\/app\/settings\/tags"/);
    expect(catalogo).toMatch(/minRole: "manager"/);
    expect(existsSync(join(raiz, "app/app/settings/tags/page.tsx"))).toBe(true);
  });

  it("o teto da tela é o MESMO `limit` do SQL — e a tela avisa quando bate nele", () => {
    // Duas cópias do mesmo número em arquivos diferentes: o `limit` da função e
    // o `TETO_DA_LISTA` do painel. Divergir não dá erro nenhum — dá uma tela que
    // corta em 500 e avisa em 400, ou que corta em 500 e nunca avisa. Este caso
    // liga as duas, e é o único lugar do repo que pode.
    const sql = ler(MIGRATION);
    const teto = /limit (\d+);/.exec(sql)?.[1];
    expect(teto, "a função precisa ter um `limit` explícito").toBeDefined();

    const painel = ler("app/app/settings/tags/_painel.tsx");
    expect(painel).toContain(`const TETO_DA_LISTA = ${teto};`);
    expect(painel).toContain("tags.length >= TETO_DA_LISTA");
    // E a frase do aviso nomeia o mesmo número — quem lê a tela não abre o SQL.
    expect(painel).toContain(`Mostrando as ${teto} primeiras etiquetas`);
  });

  it("a rota usa ok()/fail(), exige manager e chama a operação transacional", () => {
    const rota = ler("app/api/v1/tags/vocabulario/route.ts");
    expect(rota).toMatch(/from "@\/lib\/api\/wrappers"/);
    expect(rota).toContain('requireRole("manager"');
    expect(rota).toContain('rpc("fn_vocabulario_de_tags", {');
    expect(rota).toContain('rpc("fn_vocabulario_de_tags_operar"');
  });
});
