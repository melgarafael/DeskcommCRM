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
/**
 * As assinaturas como a 0264 as publicou — é o TEXTO daquele arquivo que os
 * casos abaixo leem, e o arquivo não muda (migration aplicada não se edita:
 * forward-fix numa nova, que é a 0336).
 */
const FUNCOES_DA_0264 = [
  "public.fn_vocabulario_de_tags(uuid)",
  "public.fn_tags_normalizar(text[], text, text, boolean)",
  "public.fn_vocabulario_de_tags_operar(uuid, text, text, text)",
] as const;

/**
 * A operação ganhou o quinto argumento na 0336 (`p_cor text default null`,
 * issue #1271) — é a ÚNICA função cuja assinatura mudou, e é por isso que é a
 * única cujos privilégios a migration nova reafirma. As DUAS listas de
 * assinatura do repo — esta e `AUTHENTICATED_PERMITIDO`, em
 * `tests/invariants/hardening-definer-varredura` — precisam andar juntas: um
 * `revoke` com a assinatura antiga não alcança a função que existe, e a nova
 * ficaria com o privilégio que o Postgres dá a PUBLIC na criação.
 */
const OPERAR_NA_0336 = "public.fn_vocabulario_de_tags_operar(uuid, text, text, text, text)";
const COR = "supabase/migrations/20260919190000_0336_cor_das_etiquetas.sql";

/** Escapa o que é metacaractere de regex na assinatura. */
const escapar = (fn: string) => fn.replace(/[[\]()]/g, (c) => `\\${c}`);

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
    for (const fn of FUNCOES_DA_0264) {
      const escapada = escapar(fn);
      // `from public, anon` cobre de uma vez o grant a PUBLIC que o Postgres dá
      // ao criar a função e o ALTER DEFAULT PRIVILEGES do baseline, que é o que
      // um `revoke from public` sozinho NÃO tira.
      expect(sql).toMatch(new RegExp(`revoke execute on function ${escapada} from public, anon;`));
    }
  });

  it("nenhuma função nova é concedida a anon", () => {
    const sql = ler(MIGRATION);
    expect(sql).not.toMatch(/grant\s+execute\s+on\s+function[\s\S]{0,120}?\bto\b[^;]*\banon\b/);
    for (const fn of FUNCOES_DA_0264) {
      const escapada = escapar(fn);
      expect(sql).toMatch(
        new RegExp(`grant\\s+execute on function ${escapada} to authenticated, service_role;`),
      );
    }
  });

  it("a 0336 reafirma os privilégios na assinatura de CINCO argumentos", () => {
    // Sem estas duas linhas, a assinatura NOVA fica com o EXECUTE que o Postgres
    // dá a PUBLIC na criação — isto é, alcançável pela anon key, que vai para o
    // browser. É o mesmo gate de antes, apontado para a assinatura que existe.
    const sql = ler(COR);
    const escapada = escapar(OPERAR_NA_0336);
    expect(sql).toMatch(new RegExp(`revoke execute on function ${escapada} from public, anon;`));
    expect(sql).toMatch(
      new RegExp(`grant\\s+execute on function ${escapada} to authenticated, service_role;`),
    );
    expect(sql).not.toMatch(/grant\s+execute\s+on\s+function[\s\S]{0,120}?\bto\b[^;]*\banon\b/);
    // E a assinatura antiga não sobra: com as duas no catálogo, a chamada de
    // quatro chaves resolvia na antiga e a cor nunca chegava ao banco.
    expect(sql).toMatch(/drop function if exists public\.fn_vocabulario_de_tags_operar\(uuid, text, text, text\);/);
    expect(ler("supabase/baseline.sql")).not.toMatch(
      /revoke execute on function public\.fn_vocabulario_de_tags_operar\(uuid, text, text, text\) from/,
    );
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
    // A assinatura vigente é a de CINCO argumentos (p_cor da 0336); a de quatro
    // não pode sobrar em lugar nenhum, nem aqui nem na migration nova.
    //
    // A âncora é a ÚLTIMA ocorrência, pela regra de
    // `sonda-do-baseline-ancora-na-ultima-definicao.test.ts`: a 0677 (issue
    // #2801) reafirma o MESMO revoke/grant no apêndice dela, como a convenção
    // do repo faz em toda redefinição de função — e o baseline aplica tudo em
    // ordem, então quem vale é a última definição. Antes era `.match(...)` sem
    // `g`, que casa a PRIMEIRA: com a segunda ocorrência o guarda de sondas
    // reprovava esta linha por medir definição morta.
    const assinaturas = [
      ...baseline.matchAll(
        /revoke execute on function public\.fn_vocabulario_de_tags_operar\(uuid, text, text, text, text\) from public, anon;/g,
      ),
    ];
    expect(assinaturas.at(-1)).not.toBeUndefined();
    expect(baseline).not.toMatch(/fn_vocabulario_de_tags_operar\(uuid, text, text, text\)/);
  });

  it("a 0336 acrescenta a cor: drop da assinatura antiga, ação e validação", () => {
    // O par de assinaturas é o defeito silencioso desta fatia: `create or replace`
    // com um parâmetro a mais NÃO substitui, cria sobrecarga, e a chamada de
    // quatro chaves continua resolvendo na antiga. O gate lê os dois arquivos
    // porque é o apêndice que roda na instalação por baseline.
    const cor = "supabase/migrations/20260919190000_0336_cor_das_etiquetas.sql";
    expect(existsSync(join(raiz, cor))).toBe(true);
    const sql = ler(cor);
    expect(sql).toMatch(/drop function if exists public\.fn_vocabulario_de_tags_operar\(uuid, text, text, text\);/);
    expect(sql).toMatch(/p_cor text default null/);
    expect(sql).toMatch(/'definir_cor'/);
    expect(sql).toMatch(/cor_invalida/);
    const baseline = ler("supabase/baseline.sql");
    expect(baseline).toMatch(/p_cor text default null/);
    expect(baseline).toMatch(/'definir_cor'/);
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
