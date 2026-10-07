/**
 * O TETO GANHA DENTES SEM MORDER NINGUÉM — provado contra um Postgres de verdade.
 *
 * ## Por que este arquivo existe
 *
 * A 0159 liga `ai_budgets` ao gate que decide se a IA responde. Duas coisas
 * ficavam sem NENHUMA prova em banco até aqui, e as duas são das que só falham
 * na máquina do cliente:
 *
 *   1. **O bloco do apêndice não pode armar ninguém.** A afirmação vendida no
 *      MANIFEST é "nenhuma organização ganha uma capacidade de bloqueio que já
 *      não tivesse". `tests/unit/migracao-nao-arma-ninguem.test.ts` a mede no
 *      TEXTO; texto não executa. E o caso que distingue o `install.sh` (tabela
 *      vazia) do `update.sh` (clone com dados) só existe se a fixture semear a
 *      linha ANTES de rodar o bloco — foi exatamente aí que um desenho anterior
 *      desta feature morreu, com o CI verde.
 *   2. **`SQL_ORCAMENTO` nunca tinha sido executado contra Postgres nenhum.**
 *      As CTEs `retrata`, `avisa` e `avisado_antes` são o efeito colateral do
 *      gate — quem abre e fecha o alerta que explica ao cliente por que a IA
 *      parou. SQL não exercitado, no statement que decide se um negócio
 *      responde no WhatsApp.
 *
 * ## Técnica: o texto vem do artefato, nunca daqui
 *
 * O bloco é EXTRAÍDO do `supabase/baseline.sql` pelo rótulo, e o statement é
 * IMPORTADO de `lib/agent-engine/edge/llm/orcamento.ts`. Reimplementar qualquer
 * um dos dois mediria a minha cópia, e a cópia continuaria certa com o original
 * sabotado — o modo mais comum de um teste de migration ficar decorativo.
 *
 * ## O ensaio dos dois caminhos
 *
 * `scripts/test-db.sh` já aplicou o baseline uma vez, então as colunas da 0159
 * JÁ existem quando este arquivo roda. Medir o bloco em cima disso seria medir
 * um no-op: `add column if not exists` não reescreve default de coluna que já
 * está lá, e a sabotagem `default 'bloquear'` passaria VERDE. Por isso cada
 * ensaio começa derrubando as duas colunas — é o que reproduz o `install.sh`
 * (banco sem elas) e, com a linha semeada antes, o `update.sh` do clone.
 * `fileParallelism: false` (vitest.db.config.ts) garante que ninguém está
 * olhando a tabela no meio disso, e o próprio bloco a reconstrói ao fim.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { beforeAll, describe, expect, it } from "vitest";

import { SQL_ORCAMENTO, PISO_DE_TETO_CENTS } from "@/lib/agent-engine/edge/llm/orcamento";

import { sql } from "./psql-transporte";

const BASELINE = join(process.cwd(), "supabase", "baseline.sql");

/** Uma org por propriedade — o cruzamento entre elas é o que a fixture evita. */
const ORG_HERDADA = "e0000000-0000-4000-8000-0000000000e0"; // teto 5000 herdado, sem jsonb
const ORG_RESGATE = "e1000000-0000-4000-8000-0000000000e1"; // jsonb 700 → resgatada
const ORG_ZERO = "e2000000-0000-4000-8000-0000000000e2"; // jsonb 0 → NÃO resgatada
const ORG_STRING = "e3000000-0000-4000-8000-0000000000e3"; // jsonb "700" → NÃO resgatada
const ORG_SEM_LINHA = "e4000000-0000-4000-8000-0000000000e4"; // jsonb 900, sem linha em ai_budgets
const ORG_GATE = "e5000000-0000-4000-8000-0000000000e5"; // cobaia do SQL_ORCAMENTO

const TODAS = [ORG_HERDADA, ORG_RESGATE, ORG_ZERO, ORG_STRING, ORG_SEM_LINHA, ORG_GATE];

/**
 * Recorta um bloco do baseline entre o cabeçalho `-- ---- <marca>` e o próximo
 * cabeçalho `-- ---- `. `null` quando a marca sumiu — sem isso, um bloco
 * renomeado viraria string vazia, o psql aceitaria e o teste passaria medindo
 * nada.
 */
function blocoDoBaseline(marca: string): string | null {
  const texto = readFileSync(BASELINE, "utf8");
  const inicio = texto.indexOf(marca);
  if (inicio === -1) return null;
  const resto = texto.slice(inicio + marca.length);
  const fim = resto.indexOf("\n-- ---- ");
  return resto.slice(0, fim === -1 ? undefined : fim);
}

const BLOCO_0159 = blocoDoBaseline("-- ---- o teto de IA que vincula (migration 0159) ----");
const BLOCO_0160 = blocoDoBaseline("-- ---- ai_budgets só se escreve pela rota (migration 0160) ----");

/**
 * A companheira dos grants do snapshot para `ai_budgets` — o revoke EFETIVO
 * desde a #2255/#2258. Extraída do ARTEFATO (não digitada aqui): o bloco da
 * 0160 guarda a decisão comentada, mas o statement mora ao lado dos grants,
 * e é ele que o caso `(0160)` precisa provar.
 */
function companheiraDoAiBudgets(): string | null {
  const m =
    /revoke insert, update, delete, truncate on table public\.ai_budgets from authenticated, anon;/.exec(
      readFileSync(BASELINE, "utf8"),
    );
  return m ? m[0] : null;
}

const lista = (ids: string[]): string => ids.map((i) => `'${i}'`).join(",");

/**
 * O estado de um banco que ainda NÃO recebeu a 0159 — o que o `install.sh` e o
 * `update.sh` encontram. Sem isto, o bloco seria aplicado sobre si mesmo e o
 * ensaio mediria um no-op (ver o cabeçalho).
 */
function desfazerA0159(): void {
  sql(`
    alter table public.ai_budgets drop constraint if exists ai_budgets_enforcement_mode_check;
    alter table public.ai_budgets drop constraint if exists ai_budgets_bloquear_precisa_de_teto;
    alter table public.ai_budgets drop column if exists enforcement_mode;
    alter table public.ai_budgets drop column if exists enforcement_effective_at;
  `);
}

function aplicarBloco(): void {
  sql(BLOCO_0159 as string);
}

function limpar(): void {
  sql(`
    delete from public.llm_calls where organization_id in (${lista(TODAS)});
    delete from public.agent_inbox_items where organization_id in (${lista(TODAS)});
    delete from public.ai_budgets where organization_id in (${lista(TODAS)});
    delete from public.organizations where id in (${lista(TODAS)});
  `);
}

/** As orgs e as linhas COMO ELAS ESTÃO ANTES da 0159 — a foto do clone. */
function semearComoAntesDa0159(): void {
  limpar();
  sql(`
    insert into public.organizations (id, slug, legal_name, display_name, settings) values
      ('${ORG_HERDADA}',  'inv-orc-herdada',  'Herdada LTDA',  'Herdada',  '{}'::jsonb),
      ('${ORG_RESGATE}',  'inv-orc-resgate',  'Resgate LTDA',  'Resgate',  '{"llm":{"monthly_budget_cents":700}}'::jsonb),
      ('${ORG_ZERO}',     'inv-orc-zero',     'Zero LTDA',     'Zero',     '{"llm":{"monthly_budget_cents":0}}'::jsonb),
      ('${ORG_STRING}',   'inv-orc-string',   'String LTDA',   'String',   '{"llm":{"monthly_budget_cents":"700"}}'::jsonb),
      ('${ORG_SEM_LINHA}','inv-orc-semlinha', 'SemLinha LTDA', 'SemLinha', '{"llm":{"monthly_budget_cents":900}}'::jsonb),
      ('${ORG_GATE}',     'inv-orc-gate',     'Gate LTDA',     'Gate',     '{}'::jsonb);

    -- ⚠️ A LINHA VEM ANTES DO BLOCO. É o caso (b) do desenho, e é o que separa o
    -- caminho \`install.sh\` (tabela vazia, tudo verde por vacuidade) do
    -- \`update.sh\` de quem já usa o produto. Um desenho anterior desta feature
    -- morreu exatamente aqui, com o CI verde.
    insert into public.ai_budgets (organization_id, monthly_limit_cents) values
      ('${ORG_HERDADA}', 5000),
      ('${ORG_RESGATE}', 5000),
      ('${ORG_ZERO}', 5000),
      ('${ORG_STRING}', 5000),
      ('${ORG_GATE}', 5000);
  `);
}

/** Uma coluna de uma org, como texto. String vazia = NULL (o psql -tA). */
function campo(org: string, coluna: string): string {
  return sql(`select coalesce(${coluna}::text, '') from public.ai_budgets where organization_id = '${org}';`);
}

/**
 * `SQL_ORCAMENTO` com os três placeholders trocados por literais — o psql não
 * tem bind. O TEXTO do statement continua vindo do módulo: o que muda são só os
 * `$n`, e trocá-los não pode transformar uma CTE em outra.
 */
function rodarGate(org: string): {
  teto: string;
  modo: string;
  efetivoEm: string;
  limiarPct: string;
  gasto: string;
  avisadoAntes: string;
} {
  const texto = SQL_ORCAMENTO.replace(/\$1/g, `'${org}'::uuid`)
    .replace(/\$2/g, `'Titulo do aviso'`)
    .replace(/\$3/g, `'Corpo do aviso'`);
  const [teto = "", modo = "", efetivoEm = "", limiarPct = "", gasto = "", avisadoAntes = ""] = sql(
    texto,
  ).split("|");
  return { teto, modo, efetivoEm, limiarPct, gasto, avisadoAntes };
}

function itensAbertos(org: string, kind: string): number {
  return Number(
    sql(
      `select count(*) from public.agent_inbox_items
        where organization_id = '${org}' and kind = '${kind}' and status = 'open';`,
    ),
  );
}

/** Gasta `cents` no mês corrente, pelo caminho que a régua soma. */
function gastar(org: string, cents: number): void {
  sql(`insert into public.llm_calls
         (organization_id, purpose, provider, model, input_tokens, output_tokens, cost_cents, latency_ms)
       values ('${org}', 'agent_turn', 'anthropic', 'claude-sonnet-4', 10, 10, ${cents}, 100);`);
}

describe("o teto de orçamento nasce desarmado, e o gate faz o que promete", () => {
  beforeAll(() => {
    expect(
      BLOCO_0159,
      "não achei o bloco da 0159 no baseline.sql — o instrumento perdeu o alvo, e perder o alvo não é aprovação",
    ).not.toBeNull();
    expect(
      BLOCO_0160,
      "não achei o bloco da 0160 no baseline.sql — sem ele a REST do Supabase escreve o teto sem escada",
    ).not.toBeNull();
    expect(
      SQL_ORCAMENTO.includes("fn_gasto_de_ia_do_mes"),
      "o statement do gate deixou de chamar a régua única — guarda de vacuidade",
    ).toBe(true);
  });

  describe("aplicar o bloco não arma ninguém", () => {
    /**
     * Quem o resgate B→A PODE armar, medido no banco ANTES do bloco — não uma
     * lista que eu digitei. Depois do bloco a chave jsonb já saiu, e uma lista
     * escrita à mão passaria a valer por sorte no dia em que outra fixture
     * semeasse um teto.
     */
    let elegiveisAoResgate = "";

    beforeAll(() => {
      semearComoAntesDa0159();
      desfazerA0159();
      elegiveisAoResgate = sql(
        `select coalesce(string_agg(o.id::text, ',' order by o.id), '')
           from public.organizations o
          where jsonb_typeof(o.settings->'llm'->'monthly_budget_cents') = 'number'
            and (o.settings->'llm'->>'monthly_budget_cents')::numeric >= 100
            and (o.settings->'llm'->>'monthly_budget_cents')::numeric <= 2147483647;`,
      );
      aplicarBloco();
    });

    it("(a) NENHUMA organização sai armada além das que o resgate cobre", () => {
      // A varredura é GLOBAL de propósito: 'off' nas minhas seis e 'bloquear'
      // em alguma outra seria a mesma catástrofe para o self-hoster. A régua é
      // exata (conjunto == conjunto), e não "zero fora das minhas": com
      // `default 'bloquear'` o banco inteiro entra e a igualdade quebra.
      expect(
        elegiveisAoResgate,
        "guarda de vacuidade: nenhuma org elegível ao resgate — a fixture não montou o cenário",
      ).not.toBe("");
      expect(
        sql(
          `select coalesce(string_agg(organization_id::text, ',' order by organization_id), '')
             from public.ai_budgets where enforcement_mode <> 'off';`,
        ),
        "uma organização saiu do bloco podendo parar a IA sem ninguém ter escolhido isso",
      ).toBe(elegiveisAoResgate);
    });

    it("(b) o dia do update.sh: a linha que JÁ existia com 5000 continua desarmada", () => {
      // Este é o caso que o caminho `install` não alcança. A linha foi semeada
      // ANTES do bloco (ver `semearComoAntesDa0159`), com o `DEFAULT 5000` que
      // torna "escolhi US$ 50" indistinguível de "nunca abri a tela".
      expect(campo(ORG_HERDADA, "monthly_limit_cents"), "o teto herdado foi reescrito").toBe("5000");
      expect(campo(ORG_HERDADA, "enforcement_mode")).toBe("off");
      expect(
        campo(ORG_HERDADA, "enforcement_effective_at"),
        "carência não-nula numa linha que ninguém armou",
      ).toBe("");
    });

    it("(d) resgate B→A: quem HOJE é bloqueada pelo jsonb continua bloqueada", () => {
      expect(campo(ORG_RESGATE, "monthly_limit_cents")).toBe("700");
      expect(campo(ORG_RESGATE, "enforcement_mode")).toBe("bloquear");
      expect(
        campo(ORG_RESGATE, "enforcement_effective_at"),
        "sem carência de propósito: essa org JÁ está capada nesse número, e 72h de folga AFROUXARIA",
      ).not.toBe("");
      expect(
        sql(`select coalesce(settings->'llm'->>'monthly_budget_cents','') from public.organizations where id = '${ORG_RESGATE}';`),
        "duas verdades sobre o mesmo teto",
      ).toBe("");
    });

    it("(e) jsonb 0 NÃO é resgatado — 0 era 'sem limite' na tela e 'bloqueia tudo' no gate", () => {
      expect(campo(ORG_ZERO, "enforcement_mode")).toBe("off");
      expect(campo(ORG_ZERO, "monthly_limit_cents"), "o teto foi reescrito por um valor não resgatado").toBe("5000");
    });

    it("(f) jsonb com forma errada não é resgatado E não derruba o bloco (22P02)", () => {
      // `('"700"'::jsonb->>'x')::numeric` funcionaria; `'abc'` levantaria 22P02
      // dentro de um `update.sh` sem ON_ERROR_STOP — erro engolido, resgate
      // perdido, exit 0. Chegar até aqui já prova que o bloco não abortou.
      expect(campo(ORG_STRING, "enforcement_mode")).toBe("off");
      expect(campo(ORG_STRING, "monthly_limit_cents")).toBe("5000");
    });

    it("(g) org com teto vigente e SEM linha em ai_budgets ganha linha e é resgatada", () => {
      // Nenhum gatilho de `organizations` semeia `ai_budgets`. Sem o
      // `insert ... on conflict do nothing`, esta organização PERDERIA o
      // bloqueio no instante em que a chave jsonb saísse.
      expect(campo(ORG_SEM_LINHA, "monthly_limit_cents")).toBe("900");
      expect(campo(ORG_SEM_LINHA, "enforcement_mode")).toBe("bloquear");
    });

    it("(c) re-aplicar o bloco não muda uma linha (o update.sh roda toda atualização)", () => {
      const antes = sql(
        `select organization_id::text || '|' || monthly_limit_cents::text || '|' || enforcement_mode
           from public.ai_budgets where organization_id in (${lista(TODAS)}) order by 1;`,
      );
      aplicarBloco();
      aplicarBloco();
      expect(
        sql(
          `select organization_id::text || '|' || monthly_limit_cents::text || '|' || enforcement_mode
             from public.ai_budgets where organization_id in (${lista(TODAS)}) order by 1;`,
        ),
        "a segunda passada mudou o estado — cada update.sh do cliente mexeria no teto dele",
      ).toBe(antes);
    });

    it("(l) o CHECK recusa modo desconhecido e recusa 'bloquear' sem teto útil", () => {
      expect(() =>
        sql(`update public.ai_budgets set enforcement_mode = 'xpto' where organization_id = '${ORG_HERDADA}';`),
      ).toThrow();
      expect(() =>
        sql(
          `update public.ai_budgets set enforcement_mode = 'bloquear', monthly_limit_cents = ${
            PISO_DE_TETO_CENTS - 50
          } where organization_id = '${ORG_HERDADA}';`,
        ),
      ).toThrow();
      // Controle positivo: o CHECK não recusa o estado legítimo.
      sql(
        `update public.ai_budgets set enforcement_mode = 'avisar' where organization_id = '${ORG_HERDADA}';
         update public.ai_budgets set enforcement_mode = 'off' where organization_id = '${ORG_HERDADA}';`,
      );
      expect(campo(ORG_HERDADA, "enforcement_mode")).toBe("off");
    });

    it("(h) a régua de gasto não é alcançável pela chave que vai ao browser", () => {
      // `fn_gasto_de_ia_do_mes` é `security invoker`, e o bloco VARREDURA anon do
      // baseline percorre só `p.prosecdef` — ele NÃO cura função invoker. Sem os
      // revokes próprios, o PostgREST a serve como RPC para a anon key.
      for (const papel of ["anon", "authenticated"]) {
        expect(
          sql(`select has_function_privilege('${papel}', 'public.fn_gasto_de_ia_do_mes(uuid)', 'EXECUTE');`),
          `${papel} pode ler o gasto de QUALQUER organização passando o uuid`,
        ).toBe("f");
      }
      expect(
        sql(`select has_function_privilege('service_role', 'public.fn_gasto_de_ia_do_mes(uuid)', 'EXECUTE');`),
        "revogar de quem PRECISA derruba o card, a tela de saúde e o gate — controle positivo",
      ).toBe("t");
    });

    it("(0160) o teto não se escreve pela REST do Supabase, só pela rota com escada", () => {
      const companheira = companheiraDoAiBudgets();
      expect(
        companheira,
        "a companheira da 0160 sumiu do baseline — sem ela este caso mediria o revoke global, não a guarda",
      ).not.toBeNull();
      // Reproduz o CLONE antes da guarda: a concessão do snapshot de volta. Sem
      // isto, aplicar a companheira sobre o baseline já aplicado seria um no-op
      // e o caso passaria por vacuidade (foi o que aconteceu quando o revoke
      // saiu do bloco, na #2257).
      sql(`grant insert, update, delete, truncate on table public.ai_budgets to anon, authenticated;`);
      sql(companheira as string);
      for (const papel of ["anon", "authenticated"]) {
        for (const priv of ["INSERT", "UPDATE", "DELETE", "TRUNCATE"]) {
          expect(
            sql(`select has_table_privilege('${papel}', 'public.ai_budgets', '${priv}');`),
            `${papel} escreve ${priv} em ai_budgets — arma a parada sem escada, sem carência e sem auditoria`,
          ).toBe("f");
        }
      }
      expect(
        sql(`select has_table_privilege('authenticated', 'public.ai_budgets', 'SELECT');`),
        "a leitura FICA (escopada pela policy de SELECT da 0150) — tirá-la quebra clone com painel próprio",
      ).toBe("t");
    });
  });

  describe("SQL_ORCAMENTO executado contra Postgres — as CTEs do efeito colateral", () => {
    beforeAll(() => {
      // Estado limpo para a cobaia: modo `avisar`, teto de US$ 10,00, limiar 80%.
      sql(`
        delete from public.agent_inbox_items where organization_id = '${ORG_GATE}';
        delete from public.llm_calls where organization_id = '${ORG_GATE}';
        update public.ai_budgets
           set monthly_limit_cents = 1000, alarm_threshold_pct = 80, enforcement_mode = 'avisar'
         where organization_id = '${ORG_GATE}';
      `);
    });

    it("o statement roda e devolve o snapshot que a decisão consome", () => {
      const r = rodarGate(ORG_GATE);
      expect(r.teto).toBe("1000");
      expect(r.modo).toBe("avisar");
      expect(r.limiarPct).toBe("80");
      expect(Number(r.gasto)).toBe(0);
      expect(r.avisadoAntes).toBe("f");
      expect(itensAbertos(ORG_GATE, "budget_warning"), "abriu aviso com gasto zero").toBe(0);
    });

    it("(j0) não depende do índice da 0540 existir: a forma sem alvo não infere nada", () => {
      // A forma com alvo (`on conflict (organization_id, kind) where ...`) só
      // resolve se o índice único parcial existir: num clone cuja atualização
      // aplicou o código antes do banco, `SQL_ORCAMENTO` falharia com 42P10 e o
      // chamador seguiria SEM TETO (o `catch` de leitura é fail-open de
      // propósito). Este caso derruba o índice dentro de uma transação desfeita
      // e mede que o statement continua avaliando — o texto vem do módulo,
      // como no `rodarGate`.
      const texto = SQL_ORCAMENTO.replace(/\$1/g, `'${ORG_GATE}'::uuid`)
        .replace(/\$2/g, `'Titulo do aviso'`)
        .replace(/\$3/g, `'Corpo do aviso'`);
      const saida = sql(
        `begin; drop index public.agent_inbox_budget_aberto_unico; ${texto}; rollback;`,
      );
      const linha = saida.split("\n").find((l) => l.includes("|")) ?? "";
      const [teto = "", modo = ""] = linha.split("|");
      expect(teto, "o statement não avaliou sem o índice (42P10 na forma com alvo?)").toBe("1000");
      expect(modo).toBe("avisar");
    });

    it("(j) gasto entre limiar e teto abre UM aviso, e a segunda passada não duplica", () => {
      gastar(ORG_GATE, 850); // 85% de 1000 — acima do limiar, abaixo do teto
      rodarGate(ORG_GATE);
      expect(itensAbertos(ORG_GATE, "budget_warning")).toBe(1);
      rodarGate(ORG_GATE);
      expect(
        itensAbertos(ORG_GATE, "budget_warning"),
        "sem o `not exists` da CTE `avisa`, cada chamada de IA vira um item na Central",
      ).toBe(1);
    });

    it("(k) `avisado_antes` é o retrato ANTERIOR ao insert desta passada", () => {
      // Ele é lido do MESMO snapshot que as CTEs de escrita. Se ele já viesse
      // `true` na passada que ABRE o aviso, a condição 6 (`ninguém é bloqueado
      // sem ter sido avisado`) valeria já no primeiro cruzamento — e o cliente
      // descobriria a parada pelo WhatsApp mudo, sem nunca ter visto o aviso.
      sql(`delete from public.agent_inbox_items where organization_id = '${ORG_GATE}';`);
      const primeira = rodarGate(ORG_GATE);
      expect(primeira.avisadoAntes, "o primeiro cruzamento já se declarou avisado").toBe("f");
      expect(itensAbertos(ORG_GATE, "budget_warning")).toBe(1);
      expect(rodarGate(ORG_GATE).avisadoAntes).toBe("t");
    });

    it("(k2) fechar o aviso à mão NÃO vira bypass permanente do bloqueio", () => {
      // A CTE lê `created_at >= date_trunc('month', now())`, e não
      // `status = 'open'`. Trocar por `status` daria a quem clica "resolver" um
      // jeito de nunca mais ser bloqueado.
      sql(
        `update public.agent_inbox_items set status = 'resolved'
          where organization_id = '${ORG_GATE}' and kind = 'budget_warning';`,
      );
      expect(rodarGate(ORG_GATE).avisadoAntes).toBe("t");
    });

    it("(i) o gasto de volta abaixo do limiar RETRATA os itens abertos", () => {
      // Sem a CTE `retrata`, o alerta crítico fica aceso para sempre: quando a
      // IA está parada, ninguém a chama — e é justamente aí que o laço importa.
      sql(`
        delete from public.agent_inbox_items where organization_id = '${ORG_GATE}';
        insert into public.agent_inbox_items (organization_id, kind, severity, title, ref_kind, ref_id)
        values ('${ORG_GATE}', 'budget_exceeded', 'critical', 'aceso', 'ai_budget', '${ORG_GATE}'),
               ('${ORG_GATE}', 'budget_warning', 'warn', 'aceso', 'ai_budget', '${ORG_GATE}');
        update public.ai_budgets set monthly_limit_cents = 100000 where organization_id = '${ORG_GATE}';
      `);
      expect(itensAbertos(ORG_GATE, "budget_exceeded")).toBe(1);
      rodarGate(ORG_GATE);
      expect(
        itensAbertos(ORG_GATE, "budget_exceeded"),
        "o admin subiu o teto e o alerta de 'IA parada' continuou aceso",
      ).toBe(0);
      expect(itensAbertos(ORG_GATE, "budget_warning")).toBe(0);
    });

    it("teto abaixo do piso NÃO abre aviso — e retrata o que estiver aberto", () => {
      // O par que produzia um aviso PERMANENTE e FALSO: com teto 0 a condição do
      // limiar vira `gasto >= 0` (sempre verdadeira, já com gasto zero) e a CTE
      // `retrata` exigia `gasto < 0` para fechar. É o caminho de primeira
      // impressão — organização nova, admin escolhendo "Me avisar" sem digitar
      // teto.
      sql(`
        delete from public.agent_inbox_items where organization_id = '${ORG_GATE}';
        delete from public.llm_calls where organization_id = '${ORG_GATE}';
        update public.ai_budgets set monthly_limit_cents = 0, enforcement_mode = 'avisar'
         where organization_id = '${ORG_GATE}';
      `);
      rodarGate(ORG_GATE);
      expect(
        itensAbertos(ORG_GATE, "budget_warning"),
        "aviso aberto com gasto zero e teto zero — permanente, falso, e irretratável",
      ).toBe(0);

      sql(
        `insert into public.agent_inbox_items (organization_id, kind, severity, title, ref_kind, ref_id)
         values ('${ORG_GATE}', 'budget_warning', 'warn', 'herdado', 'ai_budget', '${ORG_GATE}');`,
      );
      rodarGate(ORG_GATE);
      expect(
        itensAbertos(ORG_GATE, "budget_warning"),
        "o teto sumiu e o aviso ficou aceso sem nada que possa reabri-lo nem fechá-lo",
      ).toBe(0);
    });
  });
});
