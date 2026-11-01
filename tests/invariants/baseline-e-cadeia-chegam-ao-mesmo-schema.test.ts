/**
 * OS DOIS CAMINHOS DE SCHEMA CHEGAM AO MESMO LUGAR — e quando não chegam, o
 * teste diz QUAL objeto ficou de fora.
 *
 * ## O defeito que esta cerca existe para matar
 *
 * Mudança de schema sai em dois artefatos com dois públicos: o arquivo em
 * `supabase/migrations/` (o Supabase CLI aplica em ordem) e o apêndice
 * idempotente de `supabase/baseline.sql` (o `install.sh`/`update.sh` do
 * self-host aplica **só** ele). Nenhum gate aplicava os dois e comparava o
 * resultado: `pnpm test:db` aplica o baseline, `test:unit` lê texto. Uma
 * migration cujo efeito não chegou ao espelho deixa o cliente com um schema
 * diferente do que o repositório diz entregar — e o CI inteiro fica verde.
 *
 * Medido neste HEAD antes de escrever esta cerca (dois bancos, mesmo prelude do
 * harness): cinco índices da migration 0133 (`fn_atrito_metrics`) existiam no
 * caminho da cadeia e **não** na instalação — o painel de atrito varria cinco
 * tabelas quentes por janela em quem instala do zero. Mais três divergências de
 * ACL: `activate_kb_version` sem `authenticated` na instalação, e
 * `fn_crm_lead_close_on_stage`/`fn_validate_lost_reason_required` executáveis
 * por PUBLIC (a cadeia revoga em 0426/0513 e o espelho não repetia). Os dois
 * caminhos só empataram depois de o espelho receber esses blocos.
 *
 * ## O método — e por que NÃO é "comparar cada migration com o baseline"
 *
 * Comparar migration a migration gera falso positivo em massa: função que
 * outra migration reescreve, policy que outra recria, grant que o dump
 * normaliza. O invariante é UM: **aplicar a cadeia inteira, em ordem, sobre o
 * estado de instalação tem de não mudar nada**. Duas fontes, dois caminhos,
 * mesmo destino. Cada linha do retrato é um atributo de um objeto nomeado, e o
 * diff nomeia o objeto (coluna, constraint, índice, policy, função, gatilho,
 * tipo, grant) — nunca um "diferente" genérico.
 *
 * A cadeia NÃO sobe de banco vazio, e isso é medido, não suposto: 0001-0009 e
 * 0013 são `SELECT 1;` (README, "As migrations 0001-0009 e 0013 são stubs") e o
 * schema-base vive só no baseline. Aplicada sobre vazio, ela falha em 519 dos
 * 614 arquivos com `relation "public.contacts" does not exist`. Por isso o
 * caminho B parte do estado de INSTALAÇÃO (prelude + baseline) e aplica a
 * cadeia por cima: o que a cadeia declara e o baseline não tem aparece como
 * divergência, que é exatamente o defeito de instalação que se quer pegar.
 *
 * ## O que esta cerca NÃO cobre (declarado, para não parecer cobertura)
 *
 * - **Migração que não roda sobre o estado final.** 606 dos 614 aplicam; as 8
 *   que não aplicam estão declaradas em `MIGRATIONS_QUE_NAO_RODAM` com o motivo
 *   medido, e a lista é cobrada nas DUAS direções: arquivo novo que falhe (ou
 *   conserto que a torne aplicável) deixa o teste vermelho em vez de sumir em
 *   silêncio. O efeito dessas 8 não é medido aqui — o baseline é a fonte para
 *   elas.
 * - **Tabelas de módulo provisionado** (`sales`, `sale_items`, `commissions`,
 *   `commission_rules`, `loyalty_ledger`): nascem dentro de
 *   `fn_financeiro_provisionar`, não no corpo do baseline (doutrina das
 *   extensões). A cadeia as cria em DDL direto, então os dois caminhos divergem
 *   por desenho; a lista é declarada em `TABELAS_PROVISIONADAS` e cobrada nas
 *   duas direções, com a prova de que cada uma ainda é criada só dentro da
 *   provisionadora.
 * - **Publicação de Realtime, dados, ordem de aplicação do prelude.** O
 *   harness não cria `supabase_realtime`; e nenhuma asserção aqui olha linhas de
 *   tabela.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

const RAIZ = process.cwd();
const CAMINHO_BASELINE = join(RAIZ, "supabase", "baseline.sql");
const DIR_MIGRATIONS = join(RAIZ, "supabase", "migrations");
const BASELINE = readFileSync(CAMINHO_BASELINE, "utf8");
const MIGRATIONS = readdirSync(DIR_MIGRATIONS)
  .filter((nome) => nome.endsWith(".sql"))
  .sort();

const CONTAINER = process.env.TEST_DB_CONTAINER;
if (!CONTAINER) {
  throw new Error(
    "TEST_DB_CONTAINER ausente — esta cerca compara DOIS bancos e roda por `pnpm test:db` " +
      "(scripts/test-db.sh), que sobe o Postgres efêmero. Filtrar direto no vitest não a alcança.",
  );
}

/**
 * As migrations que NÃO aplicam sobre o estado de instalação, com o motivo
 * medido em 01/11/2026. Não é "pode ignorar": é dívida declarada, e a direção
 * inversa (alguma delas passar a aplicar) também reprova — a lista tem de
 * descrever o repositório de hoje.
 */
const MIGRATIONS_QUE_NAO_RODAM: Record<string, string> = {
  "20260429080000_0014_storage_policies_ai_policy.sql":
    'policy "tenant_read_ai_policy" for table "objects" already exists',
  "20260429100000_0017_storage_policies_lgpd_exports.sql":
    'policy "tenant_read_lgpd_exports" for table "objects" already exists',
  "20260429130000_0021_incidents.sql":
    'trigger "incidents_updated_at" for relation "incidents" already exists',
  "20260805180000_0108_revoke_definer_exposto.sql":
    "function public.rls_auto_enable() does not exist",
  "20260827040000_0190_o_mesmo_state_do_google_valia_duas_vezes.sql":
    'cannot change name of input parameter "p_retencao_dias"',
  "20260831000000_0203_comando_da_conversa.sql":
    "function public.fn_comando_da_conversa(text, uuid, timestamp with time zone, boolean, boolean, timestamp with time zone) is not unique",
  "20260907010000_0225_google_reconciliacao.sql":
    "cannot drop column needs_google_push of table calendar_appointments because other objects depend on it",
  "20260914170000_0243_chamada_de_api_tem_prazo_de_trava.sql":
    'role "authenticator" does not exist',
};

/**
 * Tabelas que a cadeia cria em DDL direto e o baseline só cria dentro da
 * provisionadora do módulo financeiro — divergência de DESENHO (doutrina das
 * extensões: módulo opcional não cria tabela para quem não o tem). O valor é o
 * nome da função que as cria, conferido contra o `baseline.sql`.
 */
const TABELAS_PROVISIONADAS: Record<string, string> = {
  "public.sales": "fn_financeiro_provisionar",
  "public.sale_items": "fn_financeiro_provisionar",
  "public.commissions": "fn_financeiro_provisionar",
  "public.commission_rules": "fn_financeiro_provisionar",
  "public.loyalty_ledger": "fn_financeiro_provisionar",
};

const BANCO_ESPELHO = "cerca_espelho";
const BANCO_CADEIA = "cerca_cadeia";

const ROTULO: Record<string, string> = {
  rel: "relação",
  col: "coluna",
  con: "constraint",
  idx: "índice",
  pol: "policy",
  fn: "função",
  trg: "gatilho",
  type: "tipo",
  acl_rel: "grant em relação",
  acl_fn: "grant em função",
  defacl: "default privileges",
  ext: "extensão",
};

/**
 * O retrato normalizado dos dois bancos: uma linha por atributo de objeto, com
 * a categoria na frente para o diff conseguir nomear o que divergiu.
 *
 * O corpo das funções entra por `md5` do texto sem comentário e com espaço
 * colapsado — comparar o texto cru acusaria `$fn$`/`$$` e indentação, que são
 * escolha de quem escreveu, não semântica.
 */
const RETRATO = String.raw`
select 'rel|' || n.nspname || '.' || c.relname || '|' || c.relkind::text
       || '|rls=' || c.relrowsecurity || '|force=' || c.relforcerowsecurity
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
 where n.nspname in ('public','auth','storage') and c.relkind in ('r','v','m','p','S')
 order by 1;

select 'col|' || n.nspname || '.' || c.relname || '.' || a.attname || '|' || format_type(a.atttypid, a.atttypmod)
       || '|notnull=' || a.attnotnull
       || '|default=' || coalesce(regexp_replace(pg_get_expr(d.adbin, d.adrelid), '\s+', ' ', 'g'), '-')
       || '|ident=' || a.attidentity::text || '|gen=' || a.attgenerated::text
  from pg_attribute a
  join pg_class c on c.oid = a.attrelid
  join pg_namespace n on n.oid = c.relnamespace
  left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
 where n.nspname in ('public','auth','storage') and c.relkind in ('r','v','m','p')
   and a.attnum > 0 and not a.attisdropped
 order by 1;

select 'con|' || n.nspname || '.' || c.relname || '|' || k.conname || '|' || k.contype::text || '|'
       || pg_get_constraintdef(k.oid)
  from pg_constraint k
  join pg_class c on c.oid = k.conrelid
  join pg_namespace n on n.oid = c.relnamespace
 where n.nspname in ('public','auth','storage')
 order by 1;

select 'idx|' || n.nspname || '.' || t.relname || '|' || i.relname || '|' || pg_get_indexdef(i.oid)
  from pg_index x
  join pg_class i on i.oid = x.indexrelid
  join pg_class t on t.oid = x.indrelid
  join pg_namespace n on n.oid = i.relnamespace
 where n.nspname in ('public','auth','storage')
 order by 1;

select 'pol|' || schemaname || '.' || tablename || '|' || policyname || '|' || cmd || '|'
       || array_to_string(roles, ',')
       || '|using=' || coalesce(regexp_replace(qual, '\s+', ' ', 'g'), '-')
       || '|check=' || coalesce(regexp_replace(with_check, '\s+', ' ', 'g'), '-')
  from pg_policies
 where schemaname in ('public','auth','storage')
 order by 1;

select 'fn|' || n.nspname || '.' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')'
       || '|kind=' || p.prokind::text || '|secdef=' || p.prosecdef || '|vol=' || p.provolatile::text
       || '|strict=' || p.proisstrict || '|cfg=' || coalesce(array_to_string(p.proconfig, ','), '-')
       || '|acl=' || coalesce(p.proacl::text, '-')
       || '|body=' || md5(regexp_replace(regexp_replace(regexp_replace(p.prosrc, '--[^\n]*', '', 'g'), '\s+', ' ', 'g'),
                                        '\s*([(),])\s*', '\1', 'g'))
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname in ('public','auth','storage')
 order by 1;

select 'trg|' || n.nspname || '.' || c.relname || '|' || t.tgname || '|' || pg_get_triggerdef(t.oid)
  from pg_trigger t
  join pg_class c on c.oid = t.tgrelid
  join pg_namespace n on n.oid = c.relnamespace
 where n.nspname in ('public','auth','storage') and not t.tgisinternal
 order by 1;

select 'type|' || n.nspname || '.' || t.typname || '|' || t.typtype::text || '|'
       || coalesce((select string_agg(e.enumlabel, ',' order by e.enumsortorder)
                      from pg_enum e where e.enumtypid = t.oid), '-')
  from pg_type t join pg_namespace n on n.oid = t.typnamespace
 where n.nspname in ('public','auth','storage') and t.typtype in ('e','d')
 order by 1;

select 'acl_rel|' || n.nspname || '.' || c.relname || '|' || coalesce(r.rolname, 'PUBLIC') || '|'
       || a.privilege_type
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  cross join lateral aclexplode(c.relacl) a
  left join pg_roles r on r.oid = a.grantee
 where n.nspname in ('public','auth','storage') and c.relkind in ('r','v','m','S')
 order by 1;

select 'acl_fn|' || n.nspname || '.' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')|'
       || coalesce(r.rolname, 'PUBLIC') || '|' || a.privilege_type
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  cross join lateral aclexplode(p.proacl) a
  left join pg_roles r on r.oid = a.grantee
 where n.nspname in ('public','auth','storage')
 order by 1;

select 'defacl|' || coalesce(n.nspname, '-') || '|' || d.defaclobjtype::text || '|'
       || coalesce(r.rolname, 'PUBLIC') || '|' || a.privilege_type
  from pg_default_acl d
  left join pg_namespace n on n.oid = d.defaclnamespace
  cross join lateral aclexplode(d.defaclacl) a
  left join pg_roles r on r.oid = a.grantee
 order by 1;
`;

/** psql no container do harness; devolve o stdout em `-tA`. */
function psql(banco: string, script: string): string {
  return execFileSync(
    "docker",
    [
      "exec",
      "-i",
      CONTAINER as string,
      "psql",
      "-U",
      "postgres",
      "-d",
      banco,
      "-v",
      "ON_ERROR_STOP=1",
      "-tA",
      "-f",
      "-",
    ],
    { input: script, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  ).trim();
}

function motivoDoErro(err: unknown): string {
  const base = err instanceof Error ? err.message : String(err);
  const stderr = (err as { stderr?: unknown }).stderr;
  return `${base}${typeof stderr === "string" ? stderr : ""}`;
}

/**
 * O prelude do `scripts/test-db.sh` — roles do Supabase, `auth.uid()`,
 * extensões, `storage`/`auth`-stubs e o DEFAULT ACL que faz objeto novo nascer
 * concedido. Copiá-lo aqui seria criar a segunda fonte de verdade que esta
 * cerca existe para impedir: ele é LIDO do script do harness, e a extração
 * falha alto se o script mudar de forma.
 */
function preludeDoHarness(): string {
  const linhas = readFileSync(join(RAIZ, "scripts", "test-db.sh"), "utf8").split("\n");
  const marca = linhas.findIndex((linha) =>
    linha.includes("prelude: stubs mínimos do Supabase"),
  );
  if (marca < 0) {
    throw new Error(
      "não achei o bloco do prelude em scripts/test-db.sh (a linha '==> prelude: stubs mínimos do Supabase') — " +
        "esta cerca aplica os dois caminhos no MESMO prelude do harness e não sabe construí-lo sozinha",
    );
  }
  const inicio = linhas.findIndex(
    (linha, i) => i > marca && linha.trim() === "psql_install <<'SQL'",
  );
  const fim = inicio < 0 ? -1 : linhas.indexOf("SQL", inicio + 1);
  if (inicio < 0 || fim < 0) {
    throw new Error(
      "o prelude de scripts/test-db.sh não está no heredoc `psql_install <<'SQL' … SQL` esperado — " +
        "atualize esta extração (e rode de novo) em vez de duplicar o prelude aqui",
    );
  }
  return `${linhas.slice(inicio + 1, fim).join("\n")}\n`;
}

function criarBanco(banco: string): void {
  psql("template1", `drop database if exists ${banco} with (force);\ncreate database ${banco};\n`);
}

interface Resultado {
  espelho: string[];
  cadeia: string[];
  falhas: { arquivo: string; motivo: string }[];
}

let resultado: Resultado;

// O trabalho de montar os dois bancos é de ~70s medidos (baseline 5s + 614
// migrations 55s + retratos); o `hookTimeout` da config é 60s, então o teto vem
// explícito aqui.
beforeAll(() => {
  const prelude = preludeDoHarness();

  criarBanco(BANCO_ESPELHO);
  psql(BANCO_ESPELHO, prelude);
  psql(BANCO_ESPELHO, BASELINE);

  criarBanco(BANCO_CADEIA);
  psql(BANCO_CADEIA, prelude);
  // O caminho B parte do ESTADO DE INSTALAÇÃO: o baseline é o chão que a cadeia
  // supõe existir (0001-0009 são stubs). O que ela acrescenta além dele é o que
  // esta cerca compara.
  psql(BANCO_CADEIA, BASELINE);

  const falhas: { arquivo: string; motivo: string }[] = [];
  for (const arquivo of MIGRATIONS) {
    const corpo = readFileSync(join(DIR_MIGRATIONS, arquivo), "utf8");
    try {
      // Uma transação por arquivo, como o Supabase CLI faz: migration que
      // estoura não deixa metade do efeito no banco e virar divergência falsa.
      psql(BANCO_CADEIA, `begin;\n${corpo}\ncommit;\n`);
    } catch (err) {
      const motivo = motivoDoErro(err)
        .split("\n")
        .map((linha) => linha.trim())
        .find((linha) => linha.includes("ERROR:"));
      falhas.push({
        arquivo,
        motivo: (motivo ?? motivoDoErro(err)).replace(/^.*?ERROR:\s*/, "").trim(),
      });
    }
  }

  resultado = {
    espelho: psql(BANCO_ESPELHO, RETRATO).split("\n").map(normaliza),
    cadeia: psql(BANCO_CADEIA, RETRATO).split("\n").map(normaliza),
    falhas,
  };
}, 600_000);

afterAll(() => {
  for (const banco of [BANCO_ESPELHO, BANCO_CADEIA]) {
    try {
      psql("template1", `drop database if exists ${banco} with (force);\n`);
    } catch {
      // O container inteiro cai no EXIT do harness; falhar aqui esconderia o
      // veredito do teste.
    }
  }
});

/** Nome legível do objeto que a linha do retrato descreve. */
function descreve(linha: string): string {
  const p = linha.split("|");
  const familia = p[0] ?? "";
  const rotulo = ROTULO[familia] ?? familia;
  if (familia === "acl_rel") return `${rotulo} ${p[1]} → ${p[2]}:${p[3]}`;
  if (familia === "acl_fn") return `${rotulo} ${p[1]} → ${p[2]}:${p[3]}`;
  if (familia === "col") return `${rotulo} ${p[1]} (tipo ${p[2]})`;
  if (familia === "fn") return `${rotulo} ${p[1]}`;
  if (familia === "ext" || familia === "defacl") return `${rotulo} ${p.slice(1).join(":")}`;
  return `${rotulo} ${p[1]}${p[2] ? ` (${p[2]})` : ""}`;
}

/**
 * A FORMA não é conteúdo: espaço em volta de vírgula/parêntese e a ORDEM dos
 * literais dentro de `= ANY (ARRAY[...])` são escolha de quem escreveu — `CHECK
 * (kind = ANY (ARRAY['a','b']))` e `CHECK (kind = ANY (ARRAY['b','a']))` são a
 * mesma regra. Medido: sem esta normalização, dois CHECKs idênticos em conteúdo
 * apareciam como divergência bilateral e a cerca reprovava o repositório certo.
 */
function normaliza(linha: string): string {
  const semEspaco = linha
    .replace(/\s+/g, " ")
    .replace(/\s*([(),])\s*/g, "$1");
  return semEspaco.replace(/=\s*ANY\s*\(ARRAY\[([^\]]*)\]\)/g, (todo, dentro: string) => {
    const itens = dentro.split(",");
    // Só ordena quando todo item é um literal simples: um item com vírgula
    // dentro da string quebraria a ordenação e inventaria divergência.
    if (!itens.every((item) => /^'[^']*'(?:::"?text"?)?$/.test(item))) return todo;
    return `=ANY(ARRAY[${[...itens].sort().join(",")}])`;
  });
}

/**
 * Objeto que só existe com o módulo financeiro INSTALADO: as tabelas dele e as
 * constraints que apontam para elas (`financial_entries.sale_id → sales`, que a
 * provisionadora devolve e a cadeia cria junto com as tabelas). A cadeia as cria
 * em DDL direto; o baseline, só dentro da provisionadora.
 */
function ehDoModuloProvisionado(linha: string): boolean {
  const tabela = tabelaDaLinha(linha);
  if (tabela !== null && tabela in TABELAS_PROVISIONADAS) return true;
  if (!linha.startsWith("con|")) return false;
  const definicao = linha.split("|")[4] ?? "";
  return Object.keys(TABELAS_PROVISIONADAS).some((nome) =>
    definicao.includes(`REFERENCES ${nome.split(".")[1]}(`),
  );
}

/** A tabela dona da linha, quando ela tem uma (`public.sales`). */
function tabelaDaLinha(linha: string): string | null {
  const p = linha.split("|");
  if (!["rel", "col", "con", "idx", "pol", "trg", "acl_rel"].includes(p[0] ?? "")) return null;
  return (p[1] ?? "").split(".").slice(0, 2).join(".");
}

let textosDasMigrations: Map<string, string> | null = null;
function textos(): Map<string, string> {
  textosDasMigrations ??= new Map(
    MIGRATIONS.map((arquivo) => [arquivo, readFileSync(join(DIR_MIGRATIONS, arquivo), "utf8")]),
  );
  return textosDasMigrations;
}

/** O DDL que DECLARA o objeto que a linha do retrato descreve. */
function padraoDeDeclaracao(linha: string): RegExp | null {
  const p = linha.split("|");
  const tabela = (p[1] ?? "").split(".")[1] ?? "";
  const nomeDoCampo = (p[1] ?? "").split(".")[2] ?? "";
  switch (p[0]) {
    case "col":
      return new RegExp(`add column (if not exists )?${nomeDoCampo}\\b`);
    case "idx":
      return new RegExp(`create (unique )?index (concurrently )?(if not exists )?${p[2]}\\b`);
    case "pol":
      return new RegExp(`create policy ${p[2]}\\b`, "i");
    case "fn":
      return new RegExp(`create (or replace )?function (public\\.)?${(p[1] ?? "").split("(")[0]}\\b`, "i");
    case "con":
      return new RegExp(`(add )?constraint ${p[2]}\\b`, "i");
    case "trg":
      return new RegExp(`create trigger ${p[2]}\\b`, "i");
    case "rel":
      return new RegExp(`create (table|view|materialized view) (if not exists )?${tabela}\\b`, "i");
    case "acl_rel":
      return new RegExp(`(grant|revoke)[^;]{0,120}\\b${tabela}\\b`, "i");
    case "acl_fn": {
      const funcao = (p[1] ?? "").split("(")[0];
      return new RegExp(`(grant|revoke)[^;]{0,120}\\b${funcao}\\b`, "i");
    }
    default:
      return null;
  }
}

/**
 * Atribuição: qual migration DESCREVE o objeto que divergiu. O padrão de DDL vem
 * primeiro — o nome pode aparecer antes numa prosa ou num `select` de migration
 * posterior, e atribuir a essa arquivo manda quem lê para o lugar errado.
 */
function migrationQueDeclara(linha: string): string {
  const padrao = padraoDeDeclaracao(linha);
  const arquivos = [...textos().entries()];
  if (padrao !== null) {
    const declarantes = arquivos
      .filter(([, texto]) => padrao.test(texto))
      .map(([arquivo]) => arquivo);
    if (declarantes.length > 0) {
      return `declarado em supabase/migrations/${declarantes[declarantes.length - 1]}`;
    }
  }
  const p = linha.split("|");
  const nome = ((p[2] ?? p[1] ?? "").split(".").pop() ?? "").split("(")[0] ?? "";
  const citantes = arquivos
    .filter(([, texto]) =>
      texto
        .split("\n")
        .some((l) => l.includes(nome) && !l.trim().startsWith("--") && !l.trim().startsWith("*")),
    )
    .map(([arquivo]) => arquivo);
  return citantes.length > 0
    ? `citado em supabase/migrations/${citantes[citantes.length - 1]}`
    : "nenhuma migration declara esse nome em SQL (veio do próprio baseline)";
}

function formata(lista: { linha: string; lado: "cadeia" | "espelho" }[]): string {
  if (lista.length === 0) return "";
  const limite = 40;
  const linhas = lista.slice(0, limite).map(({ linha, lado }) => {
    const onde =
      lado === "cadeia"
        ? "está no caminho (baseline + cadeia) e NÃO na instalação"
        : "está na instalação e a cadeia derruba/redefine";
    return `  · ${descreve(linha)} — ${onde}; ${migrationQueDeclara(linha)}`;
  });
  const resto = lista.length > limite ? `\n  … e mais ${lista.length - limite} objeto(s)` : "";
  return (
    `${lista.length} objeto(s) divergem entre os dois caminhos de schema ` +
    `(baseline aplicado num banco vazio × baseline + cadeia inteira em ordem):\n` +
    `${linhas.join("\n")}${resto}`
  );
}

describe("baseline e cadeia de migrations chegam ao mesmo schema", () => {
  it("a cadeia inteira aplica sobre o estado de instalação, menos as 8 declaradas", () => {
    const medidas = resultado.falhas.map((f) => f.arquivo).sort();
    const declaradas = Object.keys(MIGRATIONS_QUE_NAO_RODAM).sort();

    expect(
      medidas.filter((arquivo) => !declaradas.includes(arquivo)),
      "migration que NÃO aplica e não está declarada em MIGRATIONS_QUE_NAO_RODAM: " +
        "o efeito dela não está sendo medido por esta cerca",
    ).toEqual([]);
    expect(
      declaradas.filter((arquivo) => !medidas.includes(arquivo)),
      "migration declarada como não-aplicável PASSOU a aplicar: tire-a da lista, senão o efeito dela " +
        "nunca é comparado com o baseline",
    ).toEqual([]);

    for (const { arquivo, motivo } of resultado.falhas) {
      expect(motivo, `a migration ${arquivo} falhou por motivo novo`).toContain(
        MIGRATIONS_QUE_NAO_RODAM[arquivo] as string,
      );
    }
  });

  it("toda tabela que a cadeia cria fora do baseline é de módulo provisionado", () => {
    const nomesDoEspelho = new Set(
      resultado.espelho
        .filter((linha) => linha.startsWith("rel|"))
        .map((linha) => linha.split("|")[1] as string),
    );
    const soNaNcadeia = resultado.cadeia
      .filter((linha) => linha.startsWith("rel|"))
      .map((linha) => linha.split("|")[1] as string)
      .filter((nome) => !nomesDoEspelho.has(nome));

    expect(
      [...new Set(soNaNcadeia)].sort(),
      "tabela que só existe no caminho da cadeia e não é módulo provisionado declarado — " +
        "o self-host que aplica só o baseline fica sem ela",
    ).toEqual(Object.keys(TABELAS_PROVISIONADAS).sort());
  });

  it("constraint que aponta para tabela provisionada só existe com o módulo instalado", () => {
    const porReferencia = resultado.cadeia.filter(
      (linha) => linha.startsWith("con|") && ehDoModuloProvisionado(linha) &&
        tabelaDaLinha(linha) !== null && !(tabelaDaLinha(linha) as string in TABELAS_PROVISIONADAS),
    );
    expect(
      porReferencia.length,
      "nenhuma constraint de módulo foi medida — se a 0619 mudou de forma, esta guarda está cega",
    ).toBeGreaterThan(0);

    for (const linha of porReferencia) {
      const nome = linha.split("|")[2] as string;
      expect(
        BASELINE.includes(nome),
        `${nome} é criada pela cadeia e não é citada em nenhum ponto do baseline`,
      ).toBe(true);
      expect(
        resultado.espelho.some((outra) => outra.startsWith("con|") && outra.split("|")[2] === nome),
        `${nome} passou a existir na INSTALAÇÃO — a provisionadora virou DDL direto e a exclusão apodreceu`,
      ).toBe(false);
    }
  });

  it("cada tabela declarada como provisionada continua nascendo só dentro da provisionadora", () => {
    const inicio = BASELINE.indexOf("create or replace function public.fn_financeiro_provisionar(");
    const proximaFuncao = BASELINE.indexOf("create or replace function public.", inicio + 10);
    expect(inicio, "fn_financeiro_provisionar não existe mais no baseline").toBeGreaterThan(0);
    expect(proximaFuncao, "não consegui delimitar o corpo da provisionadora").toBeGreaterThan(inicio);

    for (const [tabela, provisionadora] of Object.entries(TABELAS_PROVISIONADAS)) {
      const posicao = BASELINE.indexOf(`create table if not exists ${tabela}`);
      expect(
        posicao,
        `${tabela} deixou de existir no baseline — a lista TABELAS_PROVISIONADAS apodreceu`,
      ).toBeGreaterThan(0);
      if (provisionadora !== "fn_financeiro_provisionar") {
        throw new Error(`provisionadora ${provisionadora} não é a medida nesta cerca`);
      }
      expect(
        posicao > inicio && posicao < proximaFuncao,
        `${tabela} saiu do corpo de ${provisionadora} e passou a ser criada no corpo do baseline — ` +
          "tire-a da lista de exclusão",
      ).toBe(true);
    }
  });

  it("nenhum objeto fora das tabelas provisionadas diverge", () => {
    // Controle: dois retratos vazios também "não divergem". Se o instrumento
    // falhar (psql mudo, banco não criado), esta é a asserção que acusa.
    expect(resultado.espelho.length).toBeGreaterThan(5000);
    expect(resultado.cadeia.length).toBeGreaterThan(5000);
    expect(resultado.espelho.some((linha) => linha.startsWith("col|public.organizations.id|"))).toBe(
      true,
    );

    const espelho = resultado.espelho.filter((linha) => !ehDoModuloProvisionado(linha));
    const cadeia = resultado.cadeia.filter((linha) => !ehDoModuloProvisionado(linha));

    const conjuntoEspelho = new Set(espelho);
    const conjuntoCadeia = new Set(cadeia);

    const soNaCadeia = cadeia
      .filter((linha) => !conjuntoEspelho.has(linha))
      .map((linha) => ({ linha, lado: "cadeia" as const }));
    const soNoEspelho = espelho
      .filter((linha) => !conjuntoCadeia.has(linha))
      .map((linha) => ({ linha, lado: "espelho" as const }));

    expect(formata([...soNaCadeia, ...soNoEspelho])).toBe("");
  }, 600_000);
});
