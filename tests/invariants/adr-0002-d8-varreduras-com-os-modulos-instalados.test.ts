/**
 * D8 DA ADR-0002 — AS VARREDURAS DE RLS, `security definer` E CASCATA DE LGPD
 * RODAM TAMBÉM COM OS MÓDULOS INSTALADOS.
 *
 * ─── O que a ADR decide e este arquivo mede ───────────────────────────────────────────────────
 * "Varreduras de RLS, `security definer` e cascata de LGPD rodam também sobre um banco de teste
 * com os módulos instalados, para que tabela provisionada não fique fora delas."
 * (ADR-0002, D8 — a terceira alínea, a que a issue #1902 deixa em aberto)
 *
 * ─── O buraco, medido ──────────────────────────────────────────────────────────────────────────
 * Cada arquivo de `tests/invariants/**` recebe um clone do MOLDE pelo setupFile
 * (`tests/db/banco-limpo-por-arquivo.ts`): baseline aplicado, módulo NENHUM instalado. E nenhum
 * dos três irmãos chama uma provisionadora. No estado em que eles rodam:
 *
 *   - `rls-completude-varredura.test.ts` percorre as tabelas COM `organization_id` que EXISTEM —
 *     `honorarios_contratos`/`honorarios_parcelas` não existem ali, então não passam nem pela
 *     régua de "RLS ligada" nem pela de "prova comportamental";
 *   - `hardening-definer-varredura.test.ts` percorre `pg_proc` — função criada NO ATO de
 *     provisionar não existe quando o irmão roda;
 *   - `lgpd-cascata-alcanca-quem-guarda-pessoa.test.ts` percorre FK para `contacts` × coluna de
 *     dado pessoal — mesma cegueira, e a cobertura dele ainda não aceita o registro 0485
 *     (`modulo_secoes_lgpd`), que é justamente por onde uma tabela de módulo fica alcançada.
 *
 * O verde desses três, hoje, é verde em banco sem módulo: instrumento vivo que não viu o alvo.
 *
 * ─── O que este arquivo faz ───────────────────────────────────────────────────────────────────
 * Provisiona TODA `fn_*_provisionar()` do catálogo no banco do arquivo (provisão de verdade,
 * como o irmão `lgpd-modulo-nao-declarado.test.ts`) e roda os MESMOS probes dos três irmãos —
 * queries copiadas literalmente — por cima desse estado, com a régua de MÓDULO acrescentada onde
 * a de núcleo não alcança:
 *
 *   1. **RLS.** A régua "toda tabela com `organization_id` tem RLS ligada" (a do irmão, sem
 *      lista nenhuma) roda de ponta a ponta com módulo instalado; a de PROVA COMPORTEMENTAL
 *      cobre as tabelas de módulo com entrada própria, apontando o arquivo que prova e
 *      recusando entrada órfã — o equivalente de `PROVA_PROPRIA`, que é lista do irmão e não
 *      admite linha nova sem mexer em arquivo congelado. E a prova comportamental roda AQUI:
 *      membro da organização A lê zero linhas da organização B por JWT em toda tabela de módulo.
 *   2. **security definer.** A regra "nenhuma definer de `public` é executável por `anon`"
 *      (vazia no irmão, continua vazia aqui) roda com módulo instalado; e a função que a
 *      provisionadora CRIA no provisionar nasce fechada para `anon` e `authenticated` — sem
 *      provisionar, ela não existe para varredura nenhuma, que é o alvo desta alínea.
 *   3. **cascata de LGPD.** O escopo do irmão (FK × dado pessoal) alcança a tabela de módulo, e
 *      a cobertura dela aceita o registro em `modulo_secoes_lgpd` — o mecanismo da D8, provado
 *      aqui ponta a ponta: declarada a seção, a mesma anonimização redige a coluna.
 *
 * ─── O módulo de MENTIRA deste arquivo ────────────────────────────────────────────────────────
 * O conjunto real (só honorários) nasce verde — ele não tem FK para `contacts`, não tem coluna
 * de dado pessoal e nasce com RLS ligada. Green sem consumidor é instrumento cego, então cada
 * grupo tem a sua sonda: uma provisionadora `sonda_*` que viola UMA regra, contada como 1/1, e
 * some no `afterEach`. A limpeza apaga também as linhas de `modulo_secoes_lgpd` das sondas — sem
 * isso a sabotagem do grupo de LGPD fica verde pelo registro deixado pelo caso anterior.
 */
import { existsSync } from "node:fs";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { countAs, GOV_AGENT_A, GOV_ORG, sql } from "./gov-helpers";
import { provisionadorasDoCatalogo, relacoesDePublic } from "./molde-de-provisionadora";

/* ── infraestrutura: ler o banco como os três irmãos leem ── */

function linhas(consulta: string): string[] {
  return sql(consulta)
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l !== "");
}

/**
 * Booleano como o `psql` devolve SEM cast: `t`/`f`. Com `::text` vem `true`/`false` — os dois
 * formatos passam por aqui, porque `has_table_privilege` sem cast devolve `t` e uma comparação
 * com "true" transformaria toda recusa em falso verde.
 */
function booleano(resultado: string): boolean {
  const t = resultado.trim().toLowerCase();
  return t === "t" || t === "true";
}

/** Roda um script esperando FALHA; devolve o texto do erro, ou "" se passou. */
function tentar(script: string): string {
  try {
    sql(script);
    return "";
  } catch (e) {
    const erro = e as { stderr?: string; message?: string };
    return `${erro.stderr ?? ""}${erro.message ?? ""}`;
  }
}

/** Toda `public` relação base, em ordem. */
function relacoes(): string[] {
  return relacoesDePublic();
}

/** Toda assinatura de `public`, em ordem. */
function assinaturasDeFuncoes(): string[] {
  return linhas(`
    select p.oid::regprocedure::text
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
     order by 1;
  `);
}

/** O que uma provisionadora acaba de criar: tabelas e funções que não existiam antes. */
interface Provisionamento {
  readonly modulo: string;
  readonly tabelas: string[];
  readonly funcoes: string[];
}

/** Chama `public.<nome>()` e devolve o que nasceu na chamada. */
function executarProvisionadora(nome: string): Provisionamento {
  const tabelasAntes = new Set(relacoes());
  const funcoesAntes = new Set(assinaturasDeFuncoes());
  sql(`select public.${nome}();`);
  return {
    modulo: nome.replace(/^fn_/, "").replace(/_provisionar$/, ""),
    tabelas: relacoes().filter((t) => !tabelasAntes.has(t)),
    funcoes: assinaturasDeFuncoes().filter((f) => !funcoesAntes.has(f)),
  };
}

/**
 * Cria uma provisionadora de MENTIRA na forma que a D4 exige (sem parâmetro, `security definer`,
 * `execute` só de `service_role`) e chama — é `provisionar` + medição em um passo.
 */
function provisionarSonda(modulo: string, corpo: string): Provisionamento {
  const nome = `fn_${modulo}_provisionar`;
  sql(`
    create or replace function public.${nome}()
    returns void language plpgsql security definer set search_path = public
    as $prov$ ${corpo} $prov$;
    revoke execute on function public.${nome}() from public, anon, authenticated;
    grant execute on function public.${nome}() to service_role;
  `);
  return executarProvisionadora(nome);
}

/* ── o banco deste arquivo, com os módulos do catálogo instalados ── */

let PROVISIONAMENTOS: Provisionamento[] = [];
let TABELAS_DE_MODULO: string[] = [];

beforeAll(() => {
  PROVISIONAMENTOS = provisionadorasDoCatalogo().map((p) => executarProvisionadora(p.nome));
  TABELAS_DE_MODULO = PROVISIONAMENTOS.flatMap((p) => p.tabelas);
});

/**
 * PROVA COMPORTEMENTAL das tabelas de módulo — o que `PROVA_PROPRIA` é para o irmão de RLS,
 * aqui declarado porque aquela lista mora em arquivo congelado e não abre linha nova.
 *
 * O formato é `<arquivo> + razão`; a razão precisa de ≥ 40 caracteres (a régua da casa) e o
 * arquivo tem de EXISTIR: exceção que aponta para teste que sumiu não prova nada.
 */
const PROVA_DE_MODULO: Record<string, { readonly arquivo: string; readonly razao: string }> = {
  honorarios_contratos: {
    arquivo: "tests/invariants/honorarios-rls-por-operacao.test.ts",
    razao:
      "JWT real (`set role authenticated` + claims): viewer e agent não criam, não editam e não " +
      "apagam contrato nem parcela; manager escreve (controle positivo); parcela paga é " +
      "imutável pela sessão; e parcela não pendura em contrato de OUTRA organização (recusa " +
      "cross-org na própria FK). A leitura cross-org por contagem é medida neste arquivo.",
  },
  honorarios_parcelas: {
    arquivo: "tests/invariants/honorarios-rls-por-operacao.test.ts",
    razao:
      "Mesmo arquivo: `writeCountAs` com JWT para viewer/agent/manager nas quatro operações, " +
      "imutabilidade da parcela paga (status e financial_entry_id não mudam sem o caixa) e a " +
      "recusa de FK cross-org. A leitura cross-org por contagem é medida neste arquivo.",
  },
  // #1907 — as cinco tabelas da comanda, que nascem em `fn_financeiro_provisionar()`
  // (ADR-0002 D2/D3). A prova comportamental é a MESMA da lista de leitura
  // org-scoped de `rls-isolation.test.ts`: linha REAL semeada por organização e
  // contagem cross-org — o vizinho vê zero —, percorrida no `for` daquele arquivo.
  sales: {
    arquivo: "tests/invariants/rls-isolation.test.ts",
    razao:
      "Leitura cross-org por contagem com linha REAL de comanda semeada (insert em " +
      "`public.sales` naquele seed) e percorrida na lista org-scoped: membro da organização B " +
      "vê zero linhas da organização A. Vazar entrega preço praticado E carteira de clientes. " +
      "O eixo de ESCRITA (manager/agent, 0350-0351) é medido à parte e não entra nesta lista.",
  },
  sale_items: {
    arquivo: "tests/invariants/rls-isolation.test.ts",
    razao:
      "Mesmo seed: o item nasce da venda semeada (`select id into v_sale ... insert into " +
      "`public.sale_items`) e cai na mesma contagem cross-org — vizinho vê zero. Sem a linha do " +
      "vizinho a contagem seria 0 = 0 por ausência de dado, e é por isso que a semente existe.",
  },
  commission_rules: {
    arquivo: "tests/invariants/rls-isolation.test.ts",
    razao:
      "Regra de comissão semeada por organização (`insert into public.commission_rules`) na " +
      "mesma lista de leitura org-scoped: o vizinho conta zero regras. Vazar entrega a " +
      "política de remuneração do atendente — o parâmetro comercial mais sensível da casa.",
  },
  commissions: {
    arquivo: "tests/invariants/rls-isolation.test.ts",
    razao:
      "Comissão apurada semeada por organização (`insert into public.commissions`) e contada " +
      "cross-org no mesmo laço: vizinho vê zero. Cada linha é quanto uma pessoa levou de um " +
      "cliente que não é da organização dele — dado comercial e pessoal ao mesmo tempo.",
  },
  loyalty_ledger: {
    arquivo: "tests/invariants/rls-isolation.test.ts",
    razao:
      "Extrato de pontos semeado por organização (`insert into public.loyalty_ledger`) na " +
      "lista org-scoped: vizinho vê zero movimentações. A leitura é medida aqui; a decisão de " +
      "NÃO redigir (razão `manter` do #1504) mora no redact-unificado, e é outra régua.",
  },
};

/* ── probe 1: a varredura de RLS, copiada do irmão (rls-completude-varredura.test.ts) ── */

interface EstadoRls {
  readonly tabela: string;
  readonly rlsLigada: boolean;
  readonly anonAlcanca: boolean;
}

/**
 * Toda tabela BASE de `public` com `organization_id`, com RLS e com o alcance de `anon`.
 * A query é a do irmão acrescida da coluna de privilégio — que é o `estadoDas` do molde da
 * provisionadora, a mesma grandeza medida por dois arquivos diferentes.
 */
function inventarioRls(): EstadoRls[] {
  const out = sql(`
    select c.relname
           || E'\\t' || c.relrowsecurity::text
           || E'\\t' || (has_table_privilege('anon', c.oid, 'select')
                        or has_table_privilege('anon', c.oid, 'insert')
                        or has_table_privilege('anon', c.oid, 'update')
                        or has_table_privilege('anon', c.oid, 'delete'))::text
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      join pg_attribute a on a.attrelid = c.oid
                         and a.attname = 'organization_id' and a.attnum > 0
     where n.nspname = 'public' and c.relkind = 'r'
     order by 1;
  `);
  return out
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l !== "")
    .map((linha) => {
      const [tabela, rls, anon] = linha.split("\t");
      return {
        tabela: (tabela ?? "").trim(),
        rlsLigada: (rls ?? "").trim() === "true",
        anonAlcanca: (anon ?? "").trim() === "true",
      };
    });
}

/** As tabelas de uma lista que têm `organization_id` — isto é, que estão no escopo do irmão. */
function comOrganizationId(tabelas: readonly string[]): string[] {
  if (tabelas.length === 0) return [];
  const lista = tabelas.map((t) => `'${t}'`).join(",");
  return linhas(`
    select c.relname
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      join pg_attribute a on a.attrelid = c.oid
                         and a.attname = 'organization_id' and a.attnum > 0
     where n.nspname = 'public' and c.relkind = 'r' and c.relname in (${lista})
     order by 1;
  `);
}

interface ViolacaoRls {
  readonly tabela: string;
  readonly motivo: string;
}

/** A régua de catálogo da varredura de RLS, sobre UMA lista de tabelas (a de módulo, aqui). */
function violacoesDeRls(tabelas: readonly string[]): ViolacaoRls[] {
  const porNome = new Map(inventarioRls().map((t) => [t.tabela, t]));
  const v: ViolacaoRls[] = [];
  for (const tabela of comOrganizationId(tabelas)) {
    const estado = porNome.get(tabela);
    if (estado === undefined) {
      v.push({ tabela, motivo: "com organization_id mas FORA do inventário da varredura" });
      continue;
    }
    if (!estado.rlsLigada) v.push({ tabela, motivo: "row level security DESLIGADA" });
    if (estado.anonAlcanca) v.push({ tabela, motivo: "anon alcança a tabela (privilégio de leitura/escrita)" });
  }
  return v;
}

/** Toda tabela de módulo tenant-aware sem prova comportamental declarada (ou com ponteiro morto). */
function violacoesDeProva(tabelas: readonly string[]): string[] {
  return comOrganizationId(tabelas).filter((tabela) => {
    const prova = PROVA_DE_MODULO[tabela];
    if (prova === undefined) return true;
    return prova.razao.trim().length < 40 || !existsSync(prova.arquivo);
  });
}

/* ── probe 2: a varredura de security definer, copiada do irmão (hardening-definer-varredura.test.ts) ── */

interface Definer {
  readonly assinatura: string;
  readonly anon: boolean;
  readonly authenticated: boolean;
}

function inventarioDefiner(): Definer[] {
  const out = sql(`
    select p.oid::regprocedure::text
           || E'\\t' || has_function_privilege('anon', p.oid, 'EXECUTE')::text
           || E'\\t' || has_function_privilege('authenticated', p.oid, 'EXECUTE')::text
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.prosecdef
     order by 1;
  `);
  return out
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l !== "")
    .map((linha) => {
      const [assinatura, anon, auth] = linha.split("\t");
      return {
        assinatura: (assinatura ?? "").replace(/\s+/g, ""),
        anon: anon === "true",
        authenticated: auth === "true",
      };
    });
}

/**
 * Função NOVA (nasceu no provisionar) que ficou exposta.
 *
 * A régua de módulo é mais estrita que a do irmão e de propósito: uma função que a
 * provisionadora cria não tem call site nenhum ainda, então `anon` e `authenticated` com
 * EXECUTE são superfície morta que a D4 não aceita — só `service_role` instala módulo.
 */
function funcoesNovasExpostas(assinaturas: readonly string[]): { assinatura: string; motivo: string }[] {
  const v: { assinatura: string; motivo: string }[] = [];
  for (const assinatura of assinaturas) {
    const anon = booleano(sql(`select has_function_privilege('anon', '${assinatura}'::regprocedure, 'EXECUTE');`));
    const auth = booleano(sql(`select has_function_privilege('authenticated', '${assinatura}'::regprocedure, 'EXECUTE');`));
    if (anon) v.push({ assinatura, motivo: "anon EXECUTA" });
    if (auth) v.push({ assinatura, motivo: "authenticated EXECUTA" });
  }
  return v;
}

/* ── probe 3: a varredura da cascata de LGPD, copiada do irmão (lgpd-cascata-alcanca-quem-guarda-pessoa.test.ts) ── */

/** Colunas cujo nome indica conteúdo DA pessoa — a mesma régua do irmão. */
const PADRAO_PII =
  "(^|_)(name|full_name|phone|whatsapp|email|address|street|cpf|cnpj|birth|notes|note|body|content|title|subject)($|_)";

/** Tabelas no escopo do irmão: FK direta para `contacts` E coluna de conteúdo pessoal. */
function tabelasComDadoDePessoa(): string[] {
  return linhas(`
    with fk as (
      select c.conrelid::regclass::text t
        from pg_constraint c
       where c.contype = 'f' and c.confrelid = 'public.contacts'::regclass
    ),
    pii as (
      select table_name t
        from information_schema.columns
       where table_schema = 'public'
         and column_name ~ '${PADRAO_PII}'
         and column_name !~ '_hash$'
       group by table_name
    )
    select fk.t from fk join pii on pii.t = fk.t order by 1;
  `);
}

/** Tabelas tocadas pela cascata instalada — a mesma sonda do irmão, de propósito. */
function tabelasNaCascata(): string[] {
  return linhas(`
    select distinct m[1]
      from pg_proc p,
           lateral regexp_matches(
             pg_get_functiondef(p.oid),
             '(?:update|delete from)\\s+(?:public\\.)?"?([a-z_]+)"?', 'gi') m
     where p.proname = 'fn_lgpd_cascade_redact_contact'
       and p.pronamespace = 'public'::regnamespace
     order by 1;
  `);
}

/** A seção que o módulo declarou para a tabela, se declarou. */
function declarada(modulo: string, tabela: string): boolean {
  return booleano(
    sql(
      `select exists(select 1 from public.modulo_secoes_lgpd
                      where modulo = '${modulo}' and tabela = '${tabela}')::text;`,
    ),
  );
}

/** `modulo.tabela` está na allowlist com motivo escrito de verdade (≥ 60 chars, régua da casa). */
function autorizaPorAllowlist(allowlist: Record<string, string>, chave: string): boolean {
  const motivo = allowlist[chave];
  return typeof motivo === "string" && motivo.trim().length >= 60;
}

/**
 * As tabelas de UM provisionamento que estão no escopo da cascata e não estão cobertas.
 *
 * Cobertura = passo no corpo da cascata (o núcleo) OU seção declarada em
 * `modulo_secoes_lgpd` (o mecanismo da D8, migration 0485) OU allowlist com motivo. É esta
 * terceira leitura que o irmão não tem: ele roda sem módulo instalado, então nunca viu uma
 * tabela de módulo no escopo dele.
 */
function violacoesLgpd(
  p: { readonly modulo: string; readonly tabelas: readonly string[] },
  allowlist: Record<string, string> = {},
): string[] {
  const cobertas = new Set(tabelasNaCascata());
  const escopo = tabelasComDadoDePessoa();
  return p.tabelas.filter(
    (tabela) =>
      escopo.includes(tabela) &&
      !cobertas.has(tabela) &&
      !declarada(p.modulo, tabela) &&
      !autorizaPorAllowlist(allowlist, `${p.modulo}.${tabela}`),
  );
}

/* ── as sondas: corpo de provisionadora mentirosa e a faxina de cada caso ── */

/** Cria tabela com `organization_id` e NÃO liga a RLS (esquece `fn_proteger_modulo_provisionado`). */
const CORPO_RLS_SEM_PROTECAO = `
begin
  create table if not exists public.sonda_rls_sem_protecao (
    id uuid primary key default gen_random_uuid(),
    organization_id uuid not null references public.organizations(id) on delete cascade,
    nota_tecnica text
  );
end`;

/** Provisionadora bem-comportada: só cria tabela, não cria função nenhuma (controle). */
const CORPO_SO_TABELA = `
begin
  create table if not exists public.sonda_definer_ok (
    id uuid primary key default gen_random_uuid(),
    organization_id uuid not null references public.organizations(id) on delete cascade
  );
  perform public.fn_proteger_modulo_provisionado();
end`;

/** Cria tabela E uma `security definer` sem revogar nada — a função nasce exposta. */
const CORPO_COM_FUNCAO_EXPOSTA = `
begin
  create table if not exists public.sonda_definer_ruim (
    id uuid primary key default gen_random_uuid(),
    organization_id uuid not null references public.organizations(id) on delete cascade
  );
  perform public.fn_proteger_modulo_provisionado();
  create or replace function public.fn_sonda_aberta()
  returns void language plpgsql security definer set search_path = public
  as $f$ begin perform 1; end $f$;
end`;

/**
 * Cria uma `security definer` com o par de revoke que se copia de função antiga
 * (`from public, anon`) e esquece `authenticated` — que fica com o EXECUTE direto do
 * `alter default privileges` do baseline. A regra de anon não a vê; só a de módulo.
 */
const CORPO_COM_FUNCAO_REVOGADA_SO_DE_ANON = `
begin
  create or replace function public.fn_sonda_meio_fechada()
  returns void language plpgsql security definer set search_path = public
  as $f$ begin perform 1; end $f$;
  revoke execute on function public.fn_sonda_meio_fechada() from public, anon;
end`;

/** Tabela de módulo com FK para `contacts` e coluna `title` — cai no escopo da cascata. */
const CORPO_COM_DADO_DE_PESSOA = `
begin
  create table if not exists public.sonda_lgpd_titulo (
    id uuid primary key default gen_random_uuid(),
    organization_id uuid not null references public.organizations(id) on delete cascade,
    contact_id uuid references public.contacts(id) on delete cascade,
    title text
  );
  perform public.fn_proteger_modulo_provisionado();
end`;

/**
 * Faxina de cada caso.
 *
 * ⚠️ O `delete from modulo_secoes_lgpd` não é enfeite: a sabotagem de LGPD declara a seção num
 * caso e a retira no outro; sem apagar o registro aqui, o caso seguinte lê o que o anterior
 * deixou e a sabotagem fica VERDE pelo resíduo — a armadilha medida nesta sessão.
 */
function limparSondas(): void {
  sql(`
    do $limpa$
    declare f record;
    begin
      for f in select p.oid::regprocedure as assinatura
                 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                where n.nspname = 'public' and p.proname like 'fn\\_sonda%\\_provisionar'
      loop
        execute format('drop function if exists %s cascade', f.assinatura);
      end loop;
    end $limpa$;
    drop function if exists public.fn_sonda_aberta();
    drop function if exists public.fn_sonda_meio_fechada();
    drop table if exists public.sonda_rls_sem_protecao cascade;
    drop table if exists public.sonda_definer_ok cascade;
    drop table if exists public.sonda_definer_ruim cascade;
    drop table if exists public.sonda_lgpd_titulo cascade;
    delete from public.modulo_secoes_lgpd where modulo like 'sonda%';
  `);
}

/* ── os casos ── */

describe("D8 — as varreduras de RLS, security definer e cascata de LGPD com os módulos instalados", () => {
  afterEach(limparSondas);

  it("CONTROLE: os módulos do catálogo foram provisionados de verdade — sem isto todo verde abaixo é vazio", () => {
    const catalogadas = provisionadorasDoCatalogo();
    expect(catalogadas.length, "a varredura de provisionadoras não enxergou nenhuma").toBeGreaterThanOrEqual(1);
    expect(
      catalogadas.some((p) => p.nome === "fn_honorarios_provisionar"),
      "fn_honorarios_provisionar sumiu do catálogo",
    ).toBe(true);

    expect(TABELAS_DE_MODULO).toContain("honorarios_contratos");
    expect(TABELAS_DE_MODULO).toContain("honorarios_parcelas");

    // Os três inventários leem o banco de verdade — guardas de vacuidade do irmão.
    expect(inventarioRls().length, "inventário de RLS vazio").toBeGreaterThanOrEqual(90);
    expect(inventarioDefiner().length, "inventário de definer vazio").toBeGreaterThanOrEqual(20);
    expect(tabelasComDadoDePessoa(), "o escopo da cascata não enxergou contacts").toContain("contacts");
    expect(tabelasNaCascata(), "a cascata não foi lida do banco").toContain("contacts");
  });

  describe("RLS", () => {
    it("toda tabela de módulo com organization_id está no inventário, com RLS ligada e anon fora", () => {
      const comOrg = comOrganizationId(TABELAS_DE_MODULO);
      expect(comOrg).toContain("honorarios_contratos");
      expect(comOrg).toContain("honorarios_parcelas");

      const inventario = new Set(inventarioRls().map((t) => t.tabela));
      const fora = comOrg.filter((t) => !inventario.has(t));
      expect(
        fora,
        "tabela de módulo com organization_id e FORA do inventário da varredura — a alínea " +
          "da D8 é exatamente isto: tabela provisionada que o scan não vê",
      ).toEqual([]);

      expect(violacoesDeRls(TABELAS_DE_MODULO)).toEqual([]);
    });

    it("a régua 'RLS ligada' do irmão segue verde de ponta a ponta com o módulo instalado", () => {
      // A mesma asserção de rls-completude-varredura.test.ts (case 2), re-rodada por cima do
      // banco COM módulo: a tabela provisionada não pode derrubar a régua nem escapar dela.
      const semRls = inventarioRls()
        .filter((t) => !t.rlsLigada)
        .map((t) => t.tabela);
      expect(
        semRls,
        "Tabela com `organization_id` e SEM RLS — com o módulo instalado, a régua do irmão " +
          "reprova aqui o que em banco sem módulo ela nem vê",
      ).toEqual([]);
    });

    it("toda tabela de módulo tenant-aware declara ONDE está a prova comportamental — e o arquivo existe", () => {
      const comOrg = comOrganizationId(TABELAS_DE_MODULO);
      const semProva = violacoesDeProva(TABELAS_DE_MODULO);
      expect(
        semProva,
        "Tabela de módulo com `organization_id` sem prova comportamental declarada em " +
          "PROVA_DE_MODULO (ou apontando arquivo que não existe). O caminho é declarar aqui " +
          "com o arquivo que prova, ou provar em novo invariante.",
      ).toEqual([]);
      expect(comOrg.length, "a lista de prova está vazia — nada estaria sendo cobrado").toBeGreaterThanOrEqual(2);

      // Catraca: entrada órfã (tabela que saiu do módulo) vira ruído que ninguém apaga.
      const orfas = Object.keys(PROVA_DE_MODULO).filter((t) => !comOrg.includes(t));
      expect(
        orfas,
        "PROVA_DE_MODULO aponta tabela que esta provisão não criou — remova a entrada",
      ).toEqual([]);
    });

    it("comportamental: membro da organização A lê zero linhas da organização B em toda tabela de módulo", () => {
      // Seed da organização vizinha, com linha REAL em cada tabela de módulo de honorários:
      // sem linha do vizinho, a contagem cross-org seria 0 = 0 por ausência de dado.
      sql(`
        insert into public.organizations (id, slug, legal_name, display_name)
          values ('7a5f0011-9999-4000-8000-0000000000b1', 'd8-varreduras-b', 'D8 Varreduras B', 'D8 Var B')
          on conflict (id) do nothing;
        insert into public.honorarios_contratos (id, organization_id, modelo, valor_fixo_cents)
          values ('7a5f0011-9999-4000-8000-0000000000c1', '7a5f0011-9999-4000-8000-0000000000b1', 'fixo', 100000)
          on conflict do nothing;
        insert into public.honorarios_parcelas
            (id, organization_id, contrato_id, numero, vencimento, valor_cents, status)
          values ('7a5f0011-9999-4000-8000-0000000000c2', '7a5f0011-9999-4000-8000-0000000000b1',
                  '7a5f0011-9999-4000-8000-0000000000c1', 1, '2026-10-01', 100000, 'pendente')
          on conflict do nothing;
      `);
      expect(
        Number(sql(`select count(*) from public.honorarios_contratos
                     where organization_id = '7a5f0011-9999-4000-8000-0000000000b1';`)),
        "o seed da organização vizinha não plantou linha — o caso abaixo seria 0 = 0 por acaso",
      ).toBe(1);

      const comOrg = comOrganizationId(TABELAS_DE_MODULO);
      expect(comOrg.length).toBeGreaterThanOrEqual(2);
      for (const tabela of comOrg) {
        const podeLer = booleano(sql(`select has_table_privilege('authenticated', 'public.${tabela}', 'select');`));
        if (podeLer) {
          const esperado = Number(
            sql(`select count(*) from public.${tabela} where organization_id = '${GOV_ORG}';`),
          );
          expect(
            countAs(GOV_AGENT_A, `select count(*) from public.${tabela}`),
            `${tabela}: o membro da organização A não leu exatamente as linhas da própria ` +
              `organização — vizinho atravessando a RLS da tabela provisionada`,
          ).toBe(esperado);
        } else {
          // Tabela server-only: a prova é a recusa, não a contagem.
          expect(
            tentar(`
              set role authenticated;
              select set_config('request.jwt.claims', '{"sub":"${GOV_AGENT_A}"}', false);
              select count(*) from public.${tabela};
            `),
            `${tabela}: authenticated LEU tabela que deveria estar fechada`,
          ).toMatch(/permission denied/i);
        }
      }
    });

    it("SABOTAGEM: provisionadora que não liga a RLS é anotada 1/1, e sai da prova comportamental 1/1", () => {
      const p = provisionarSonda("sondartls", CORPO_RLS_SEM_PROTECAO);
      expect(p.tabelas).toEqual(["sonda_rls_sem_protecao"]);

      const violacoes = violacoesDeRls(p.tabelas);
      const daSonda = violacoes.filter((v) => v.tabela === "sonda_rls_sem_protecao");
      expect(
        daSonda.map((v) => v.motivo).join(" + "),
        `a varredura de RLS anotou ${daSonda.length} de 2 previstas (RLS desligada + anon com ` +
          `privilégio) para a tabela da sonda`,
      ).toBe("row level security DESLIGADA + anon alcança a tabela (privilégio de leitura/escrita)");
      // E nada mais: só a sonda reprova, o conjunto real continua limpo.
      expect(violacoesDeRls(TABELAS_DE_MODULO)).toEqual([]);

      expect(
        violacoesDeProva(p.tabelas),
        "tabela de módulo nova sem prova comportamental não foi anotada (1/1 previsto)",
      ).toEqual(["sonda_rls_sem_protecao"]);
    });
  });

  describe("security definer", () => {
    it("com o módulo instalado, nenhuma definer de public é executável por anon", () => {
      // A regra do irmão (ANON_PERMITIDO continua vazia), re-rodada com o módulo no banco.
      const expostas = inventarioDefiner()
        .filter((f) => f.anon)
        .map((f) => f.assinatura);
      expect(
        expostas,
        "SECURITY DEFINER executável pela anon key com o módulo instalado",
      ).toEqual([]);

      // E o inventário ENXERGA a provisionadora do módulo — sem isso o verde acima seria cego.
      // `oid::regprocedure::text` omite o schema que está no `search_path` — a mesma forma
      // que o irmão guarda em INVENTARIO_PRIMITIVAS.
      expect(inventarioDefiner().map((f) => f.assinatura)).toContain("fn_honorarios_provisionar()");
    });

    it("com o módulo instalado, nenhuma função que a provisionadora do catálogo criou é executável por anon nem por authenticated", () => {
      // A régua de módulo sobre o catálogo REAL, não só sobre as sondas. A regra de anon, acima,
      // não basta: `revoke ... from public, anon` deixa o EXECUTE de authenticated (ver a sonda
      // "revogada só de anon", abaixo), e o irmão roda sem módulo — não vê a função.
      expect(
        funcoesNovasExpostas(PROVISIONAMENTOS.flatMap((p) => p.funcoes)),
        "função criada no provisionar ficou executável por anon ou authenticated — revogue de " +
          "public, anon E authenticated; só service_role instala e opera módulo (D4)",
      ).toEqual([]);
    });

    it("CONTROLE: provisionadora que só cria tabela não deixa função nenhuma para a varredura", () => {
      const p = provisionarSonda("sondaok", CORPO_SO_TABELA);
      expect(p.funcoes, "a provisionadora de controle criou função — o corpo não era o declarado").toEqual([]);
      expect(funcoesNovasExpostas(p.funcoes)).toEqual([]);
    });

    it("SABOTAGEM: a função que a provisionadora cria nasce exposta — e sem provisionar ela não existe", () => {
      // O alvo da alínea: a varredura do irmão lê `pg_proc` de um banco sem módulo, e esta
      // função só passa a existir no ato do provisionar.
      expect(
        sql(`select (to_regprocedure('public.fn_sonda_aberta()') is null)::text;`),
        "fn_sonda_aberta() já existia antes de provisionar — a sonda não mede o alvo",
      ).toBe("true");

      const p = provisionarSonda("sondaruim", CORPO_COM_FUNCAO_EXPOSTA);
      expect(p.funcoes, "a sonda não criou a função — o corpo não era o declarado").toEqual([
        "fn_sonda_aberta()",
      ]);

      const expostas = funcoesNovasExpostas(p.funcoes);
      expect(
        [...new Set(expostas.map((e) => e.assinatura))],
        "a função nova exposta não foi anotada (1/1 previsto)",
      ).toEqual(["fn_sonda_aberta()"]);
      const motivos = expostas.map((e) => e.motivo).sort().join(" + ");
      expect(
        motivos,
        "a função nasceu com grant do `alter default privileges` do baseline — as DUAS origens " +
          "da D4, e as duas têm de aparecer aqui",
      ).toBe("anon EXECUTA + authenticated EXECUTA");
    });

    it("SABOTAGEM: a função revogada só de public e anon passa na regra de anon e reprova 1/1 na de módulo", () => {
      const p = provisionarSonda("sondameia", CORPO_COM_FUNCAO_REVOGADA_SO_DE_ANON);
      expect(p.funcoes, "a sonda não criou a função — o corpo não era o declarado").toEqual([
        "fn_sonda_meio_fechada()",
      ]);

      // A regra de anon não a vê: é a metade que ela não cobre.
      expect(
        inventarioDefiner()
          .filter((f) => f.anon)
          .map((f) => f.assinatura),
      ).not.toContain("fn_sonda_meio_fechada()");

      expect(
        funcoesNovasExpostas(p.funcoes),
        "a definer que ficou com o EXECUTE de authenticated não foi anotada (1/1 previsto)",
      ).toEqual([{ assinatura: "fn_sonda_meio_fechada()", motivo: "authenticated EXECUTA" }]);
    });
  });

  describe("cascata de LGPD", () => {
    it("com o módulo instalado, o escopo do irmão alcança o que tem que alcançar e o conjunto real está coberto", () => {
      // Instrumento vivo: contacts está no escopo E na cascata (os dois controles do irmão).
      expect(tabelasComDadoDePessoa()).toContain("contacts");
      expect(tabelasNaCascata()).toContain("contacts");

      // Nenhum módulo real cai no escopo SEM decisão — e é pela RÉGUA (FK × coluna de dado
      // pessoal), não por cegueira: a sonda do caso seguinte mostra que o escopo enxerga
      // tabela de módulo. A única entrada real é `sales` (#1907): FK para `contacts` E
      // `notes`, alcançada pela SEÇÃO declarada `financeiro/sales` (D8/0485) — a asserção
      // seguinte cobra a cobertura de cada entrada; aqui se cobra que a comanda seja a ÚNICA
      // e que a seção dela exista de fato no banco, para a exceção não virar esconderijo.
      const escopoDeModulo = tabelasComDadoDePessoa().filter((t) => TABELAS_DE_MODULO.includes(t));
      expect(
        escopoDeModulo,
        "tabela de módulo com dado de pessoa no escopo da cascata — a comanda (`sales`) é a " +
          "única decisão escrita deste PR (#1907, seção declarada `financeiro/sales`); se outra " +
          "entrou, a régua mudou e a decisão dela precisa ser reavaliada",
      ).toEqual(["sales"]);
      expect(
        declarada("financeiro", "sales"),
        "`sales` está no escopo do irmão mas a seção `financeiro/sales` não está declarada em " +
          "`modulo_secoes_lgpd` — a D8 manda a cobertura ser SQL dinâmico declarado, não passo " +
          "nomeado no corpo da cascata",
      ).toBe(true);

      const violacoes = PROVISIONAMENTOS.flatMap((p) => violacoesLgpd(p));
      expect(
        violacoes,
        "tabela de módulo no escopo da cascata e fora de toda cobertura (corpo da cascata, " +
          "seção declarada em modulo_secoes_lgpd, ou allowlist com motivo)",
      ).toEqual([]);
    });

    it("SABOTAGEM: tabela de módulo no escopo SEM seção declarada reprova 1/1 — declarada, passa — retirada, reprova de novo", () => {
      const p = provisionarSonda("sondalgpd", CORPO_COM_DADO_DE_PESSOA);
      expect(p.tabelas).toEqual(["sonda_lgpd_titulo"]);
      expect(
        tabelasComDadoDePessoa(),
        "a sonda não caiu no escopo do irmão (FK para contacts × coluna de dado pessoal)",
      ).toContain("sonda_lgpd_titulo");

      // 1) sem declaração: a única violação é a da sonda.
      expect(
        violacoesLgpd(p),
        "tabela de módulo com dado de pessoa e sem seção declarada passou (1/1 previsto)",
      ).toEqual(["sonda_lgpd_titulo"]);

      // 2) declarada a seção (como a migration do módulo faria): passa.
      sql(`
        insert into public.modulo_secoes_lgpd (modulo, tabela, ligacao, colunas, colunas_rotulo)
        values ('sondalgpd', 'sonda_lgpd_titulo',
                'organization_id = $1 and contact_id = $2',
                '{title}'::text[], '{}'::text[]);
      `);
      expect(violacoesLgpd(p), "seção declarada continuou reprovando").toEqual([]);

      // 3) sabotagem da sabotagem: RETIRAR a declaração devolve a violação. É o caso que
      //    ficaria verde pelo registro deixado pelo passo 2 se a faxina não apagasse.
      sql(`delete from public.modulo_secoes_lgpd where modulo = 'sondalgpd';`);
      expect(
        violacoesLgpd(p),
        "retirar a declaração não devolveu a violação — a varredura parou de ler " +
          "modulo_secoes_lgpd",
      ).toEqual(["sonda_lgpd_titulo"]);
    });

    it("a seção declarada é a que a anonimização redige de fato (scan e mecanismo no mesmo banco)", () => {
      const p = provisionarSonda("sondalgpd", CORPO_COM_DADO_DE_PESSOA);
      sql(`
        insert into public.modulo_secoes_lgpd (modulo, tabela, ligacao, colunas, colunas_rotulo)
        values ('sondalgpd', 'sonda_lgpd_titulo',
                'organization_id = $1 and contact_id = $2',
                '{title}'::text[], '{}'::text[]);
        insert into auth.users (id, email)
          values ('7a5f0011-7777-4000-8000-000000000001', 'd8-varreduras@invariant.test')
          on conflict (id) do nothing;
        insert into public.organizations (id, slug, legal_name, display_name)
          values ('7a5f0011-6666-4000-8000-000000000001', 'd8-varreduras', 'D8 Varreduras', 'D8 Var')
          on conflict (id) do nothing;
        insert into public.contacts (id, organization_id, name)
          values ('7a5f0011-5555-4000-8000-000000000001', '7a5f0011-6666-4000-8000-000000000001', 'Vera Varredura')
          on conflict do nothing;
        insert into public.sonda_lgpd_titulo (organization_id, contact_id, title)
          values ('7a5f0011-6666-4000-8000-000000000001',
                  '7a5f0011-5555-4000-8000-000000000001', 'Assunto escrito sobre Vera');
      `);
      // Controle de seed: o texto está legível ANTES — sem isto, "ficou nulo" seria verde
      // por ausência de linha.
      expect(
        sql(`select title from public.sonda_lgpd_titulo
              where contact_id = '7a5f0011-5555-4000-8000-000000000001';`),
      ).toBe("Assunto escrito sobre Vera");

      expect(
        violacoesLgpd(p),
        "com a seção declarada o scan ainda reprova a tabela que o mecanismo alcança",
      ).toEqual([]);

      sql(`select public.fn_lgpd_cascade_redact_contact(
            '7a5f0011-6666-4000-8000-000000000001',
            '7a5f0011-5555-4000-8000-000000000001', gen_random_uuid());`);

      expect(
        sql(`select (title is null)::text from public.sonda_lgpd_titulo
              where contact_id = '7a5f0011-5555-4000-8000-000000000001';`),
        "a seção declarada não foi redigida pela anonimização — o scan diria coberto e a " +
          "pessoa ficaria legível, que é exatamente o modo de falha da LGPD",
      ).toBe("true");
      // E nenhuma linha da sonda ficou com o título (há uma só: isto não mede vizinho intocado).
      expect(
        Number(sql(`select count(*) from public.sonda_lgpd_titulo where title is not null;`)),
      ).toBe(0);
    });

    it("allowlist sem motivo não autoriza — com motivo escrito, autoriza (a régua da casa)", () => {
      const p = provisionarSonda("sondalgpd", CORPO_COM_DADO_DE_PESSOA);
      const chave = "sondalgpd.sonda_lgpd_titulo";

      // Sem motivo (ou com motivo curto): continua reprovando — deixar de fora sem justificar
      // é o mesmo que não decidir.
      expect(violacoesLgpd(p, { [chave]: "deixa" })).toEqual(["sonda_lgpd_titulo"]);
      expect(violacoesLgpd(p, {})).toEqual(["sonda_lgpd_titulo"]);

      // Com motivo escrito e suficiente: é o escape documentado da régua.
      expect(
        violacoesLgpd(p, {
          [chave]:
            "Tabela de auditoria do módulo sonda: guarda apenas o título técnico de uma ação " +
            "de manutenção e o id do contato; o texto da pessoa ficou vazio por construção e a " +
            "linha é apagada junto com o contrato no prazo de retenção.",
        }),
        "allowlist com motivo escrito e suficiente continuou reprovando",
      ).toEqual([]);
    });
  });
});
