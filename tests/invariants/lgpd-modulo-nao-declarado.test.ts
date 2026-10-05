/**
 * LGPD — MÓDULO QUE CRIA TABELA COM DADO DA PESSOA PRECISA DECLARAR A SEÇÃO
 * (ADR-0002, D8 — issue #1902, continuação do #1901).
 *
 * ─── O que o #1901 fez, e o buraco que este arquivo fecha ──────────────────
 * O #1901 (migration 0485) fez a anonimização ALCANÇAR as seções que um módulo
 * DECLARA em `modulo_secoes_lgpd`, por SQL dinâmico protegido por `to_regclass`.
 * O limite é esse "declara": um módulo instalado que cria tabela com dado da
 * pessoa ligada a `contacts` e NÃO declara a seção fica fora da anonimização, e
 * ninguém é avisado — a rota devolve SUCESSO, o SLA é marcado como cumprido e a
 * linha continua legível. É o modo de falha que a LGPD não tolera em lugar
 * nenhum.
 *
 * ─── O que este arquivo guarda ─────────────────────────────────────────────
 * Um invariante que provisiona CADA `fn_<modulo>_provisionar()` num banco
 * descartável (este arquivo ganha um clone novo do baseline pelo setupFile
 * `tests/db/banco-limpo-por-arquivo.ts`) e exige que TODA tabela nova criada
 * pelo módulo com FK para `contacts`, ou com coluna de dado pessoal, esteja em
 * `modulo_secoes_lgpd` (o mecanismo que o #1901 instalou) OU numa allowlist com
 * o motivo escrito — o MESMO desenho do catálogo de recursos opcionais (#1876):
 * o módulo novo que não se registra reprova.
 *
 * ─── Por que "provisiona de verdade" e não lê o texto do corpo ─────────────
 * A régua da casa (CLAUDE.md, migrations item 10): grepar o arquivo mede a
 * definição ERRADA; quem manda é o que o banco instala. Aqui o caminho é ainda
 * mais direto que `pg_get_functiondef`: a função é CHAMADA (`select public.
 * fn_<modulo>_provisionar()`), as tabelas nascem de verdade, e a varredura olha
 * o CATÁLOGO (`pg_class`/`pg_constraint`/`pg_attribute`) do que nasceu — FK
 * real para `contacts`, coluna real com nome de dado pessoal. Símbolo no texto
 * mostra INTENÇÃO; o catálogo mostra o que existe.
 *
 * ─── O estado real hoje: honorários, e ele passa de propósito ───────────────
 * O único módulo na `main` é honorários (migration 0480): cria
 * `honorarios_contratos` e `honorarios_parcelas`, nenhuma com FK para `contacts`
 * (referenciam `organizations`, `crm_leads` e `financial_entries`) nem coluna de
 * dado pessoal (valores, percentuais e datas do NEGÓCIO). Não precisa registrar
 * seção — decisão escrita na própria 0480. O conjunto de violações nasce VAZIO.
 * Gate que nasce verde só é aceitável com controle positivo que prove que o
 * instrumento ainda enxerga o que deve reprovar — é o que os casos `sonda_*`
 * fazem, exatamente como `provisionadora-de-modulo.test.ts` nasce com o conjunto
 * vazio e mede o instrumento a cada rodada.
 *
 * ─── SABOTAGEM prevista (medida antes de rodar) ─────────────────────────────
 * Vou criar uma provisionadora `sonda_*` de mentira (na forma que a D4 exige)
 * que cria uma tabela com FK para `contacts` E coluna `nome_livre` de texto da
 * pessoa, sem registrar a seção. O invariante, rodado sobre ela, deve ANOTAR
 * exatamente 1 violação — a daquela tabela — que é o caso que este arquivo
 * cobra com o teste "SABOTAGEM prevista". Depois "registro" a seção (equivalente
 * ao conserto) e a mesma varredura passa. Contagem: 1/1 — o previsto — e a
 * restauração é registrar a seção. A medida AQUI é o instrumento: sem ele, a
 * violação não é anotada.
 *
 * E a sabotagem do TESTE (a régua da casa: teste que não fica vermelho quando o
 * conserto sai não guarda nada) foi medida num container descartável: neutralizei
 * por um instante a leitura de `modulo_secoes_lgpd` em `estaRegistrada` (fiz a
 * função devolver "sempre registrada") e a varredura passou a anotar ZERO
 * violações — o teste "SABOTAGEM prevista" e os dois que dependem dela caíram
 * (3 vermelhos). Restaurado o conserto, verde de novo. Sem a neutralização o
 * instrumento reprova; com ela, cega — é exatamente o contrato da issue #1902.
 */
import { afterEach, describe, expect, it } from "vitest";

import { sql } from "./gov-helpers";
import { provisionadorasDoCatalogo, relacoesDePublic } from "./molde-de-provisionadora";

/** Resultado da varredura: uma tabela de módulo que devia declarar LGPD e não declarou. */
interface Violacao {
  readonly modulo: string;
  readonly tabela: string;
  /** Por que a tabela cai na régua: FK para contacts, coluna de dado pessoal, ou as duas. */
  readonly razoes: string[];
  /** Onde deveria estar (e não está): registro em modulo_secoes_lgpd ou allowlist. */
  readonly faltou: string;
}

/**
 * ALLOWLIST — tabela de módulo com dado da pessoa que a VARREdura enxerga e que
 * fica FORA da anonimização por decisão escrita. A mesmíssima régua do catálogo
 * de recursos opcionais (#1876): o poder de deixar de fora não é silencioso,
 * precisa de motivo. Vazia hoje — o único módulo (honorários) nem cai na régua.
 *
 * Formato da chave: `<modulo>.<tabela>`. O motivo precisa de ≥ 60 caracteres
 * (a mesma régua de `manter` do redact-unificado, #1504): deixar de fora por
 * padrão é o mesmo defeito de não decidir.
 */
const ALLOWLIST: Record<string, string> = {};

/**
 * Tabela/coluna de MODULO entra na régua de LGPD quando:
 *   (a) tem FK DIRETA para `public.contacts`; ou
 *   (b) tem coluna cujo nome aponta dado pessoal (nome, e-mail, telefone, CPF…).
 * Medido do catálogo, nunca do texto do corpo da provisionadora.
 */
const PII_COLUNAS_RE =
  "\\m(name|nome|apelido|sobrenome|email|telefone|phone|celular|whatsapp|cpf|cnpj|rg|cep|endereco|address|nascimento|birthdate|documento)";

function tabelaExigeRegistroLGPD(tabela: string): { exige: boolean; razoes: string[] } {
  const razoes: string[] = [];

  const temFkParaContacts =
    sql(`select exists(
        select 1 from pg_constraint c
          join pg_class cl on cl.oid = c.conrelid
         where c.contype = 'f'
           and c.confrelid = 'public.contacts'::regclass
           and cl.relname = '${tabela}'
      )::text;`) === "true";
  if (temFkParaContacts) razoes.push("FK direta para contacts");

  const pii = sql(`select coalesce(string_agg(a.attname, ', ' order by a.attnum), '')
    from pg_attribute a
    join pg_class c on c.oid = a.attrelid
    join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public'
     and c.relname = '${tabela}'
     and a.attnum > 0 and not a.attisdropped
     and a.attname ~ '${PII_COLUNAS_RE}';`);
  if (pii.trim() !== "") razoes.push(`coluna(s) nomeando dado pessoal: ${pii.trim()}`);

  return { exige: razoes.length > 0, razoes };
}

/** `modulo_secoes_lgpd` já tem a seção para `modulo/tabela`? */
function estaRegistrada(modulo: string, tabela: string): boolean {
  return (
    sql(`select exists(select 1 from public.modulo_secoes_lgpd
                        where modulo = '${modulo}' and tabela = '${tabela}')::text;`) === "true"
  );
}

/** `modulo.tabela` está na allowlist com motivo suficiente escrito? */
function estaNaAllowlist(modulo: string, tabela: string): boolean {
  const motivo = ALLOWLIST[`${modulo}.${tabela}`];
  return typeof motivo === "string" && motivo.trim().length >= 60;
}

/**
 * Provisiona CADA `fn_<modulo>_provisionar()` do catálogo (nesta iteração)
 * e devolve, por módulo, as tabelas NOVAS que a chamada criou.
 */
function novasTabelasPorModulo(): Map<string, string[]> {
  const porModulo = new Map<string, string[]>();
  for (const p of provisionadorasDoCatalogo()) {
    const antes = new Set(relacoesDePublic());
    sql(`select public.${p.nome}();`);
    const depois = relacoesDePublic();
    const novas = depois.filter((t) => !antes.has(t));
    const modulo = p.nome.replace(/^fn_/, "").replace(/_provisionar$/, "");
    porModulo.set(modulo, novas);
  }
  return porModulo;
}

/** Toda tabela de módulo que a régua de LGPD exige registrar e que não registrou. */
function violacoesDoCatalogo(): Violacao[] {
  const v: Violacao[] = [];
  for (const [modulo, tabelas] of novasTabelasPorModulo()) {
    for (const tabela of tabelas) {
      const { exige, razoes } = tabelaExigeRegistroLGPD(tabela);
      if (!exige) continue;
      const registrada = estaRegistrada(modulo, tabela);
      const allow = estaNaAllowlist(modulo, tabela);
      if (registrada || allow) continue;
      v.push({
        modulo,
        tabela,
        razoes,
        faltou: registrada ? "modulo_secoes_lgpd" : "modulo_secoes_lgpd ou allowlist",
      });
    }
  }
  return v;
}

/* ── infraestrutura das sondas: criar provisionadora de mentira e limpar ── */

const MODULO_SONDA = "sondalgpd";
const TABELA_SONDA = "sonda_lgpd_dados";

/** O corpo BEM-COMPORTADO (forma da D4): cria só a tabela dela e protege. */
const CORPO = `begin
  create table if not exists public.${TABELA_SONDA} (
    id uuid primary key default gen_random_uuid(),
    organization_id uuid not null references public.organizations(id) on delete cascade,
    contact_id uuid references public.contacts(id) on delete cascade,
    nome_livre text
  );
  perform public.fn_proteger_modulo_provisionado();
end`;

function criarProvisionadoraSonda(): void {
  sql(`
    create or replace function public.fn_${MODULO_SONDA}_provisionar()
    returns void language plpgsql security definer set search_path = public
    as $prov$ ${CORPO} $prov$;
    revoke execute on function public.fn_${MODULO_SONDA}_provisionar() from public, anon, authenticated;
    grant execute on function public.fn_${MODULO_SONDA}_provisionar() to service_role;
  `);
}

/** Restaura: derruba as sondas e o que elas criaram (cada arquivo é um clone do baseline). */
function limparSonda(): void {
  sql(`
    drop function if exists public.fn_${MODULO_SONDA}_provisionar();
    drop table if exists public.${TABELA_SONDA} cascade;
    drop function if exists public.fn_sondafin_provisionar();
    drop table if exists public.sonda_lgpd_financeiro cascade;
    delete from public.modulo_secoes_lgpd
     where modulo in ('${MODULO_SONDA}', 'sondafin');
  `);
}

describe("LGPD — módulo que cria tabela com dado da pessoa tem que declarar a seção (D8)", () => {
  afterEach(limparSonda);

  it("o mecanismo está de pé: modulo_secoes_lgpd existe e as funções de apoio existem", () => {
    expect(sql(`select (to_regclass('public.modulo_secoes_lgpd') is not null)::text;`)).toBe("true");
    expect(
      sql(`select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'public' and p.proname = 'fn_lgpd_redigir_secoes_de_modulo';`),
    ).toBe("1");
    // O conjunto real do catálogo: só honorários na main. A varredura tem que enxergá-lo.
    const catalogadas = provisionadorasDoCatalogo();
    expect(catalogadas.some((p) => p.nome === "fn_honorarios_provisionar"), "a varredura não enxergou fn_honorarios_provisionar").toBe(true);
  });

  it("o conjunto REAL do catálogo está limpo — provisão de verdade, catálogo depois", () => {
    // Honrarios é provisionado de verdade; as duas tabelas não caem na régua de LGPD,
    // então não há violação. Este caso é o que reprova o PRIMEIRO módulo que criar
    // tabela com dado da pessoa e não declarar a seção.
    expect(violacoesDoCatalogo(), "tabela de módulo real com dado da pessoa sem seção declarada").toEqual([]);
    // Controle de vacuidade: a varredura PROVISIONOU e enxergou as tabelas de honorários.
    const relacionadas = relacoesDePublic();
    expect(relacionadas).toContain("honorarios_contratos");
    expect(relacionadas).toContain("honorarios_parcelas");
    // E confirmou que nenhuma delas tem FK para contacts nem coluna de dado pessoal.
    expect(tabelaExigeRegistroLGPD("honorarios_contratos").exige).toBe(false);
    expect(tabelaExigeRegistroLGPD("honorarios_parcelas").exige).toBe(false);
  });

  it("SABOTAGEM prevista: tabela de módulo com FK para contacts e coluna de dado pessoal SEM seção REPROVA", () => {
    criarProvisionadoraSonda();
    const violacoes = violacoesDoCatalogo();
    // Previsto: N=1 caso reprovado — exatamente a tabela da sonda.
    const n = violacoes.filter((v) => v.tabela === TABELA_SONDA).length;
    expect(n, `a varredura reprovou ${n} de 1 previsto — faltou enxergar ${TABELA_SONDA}`).toBe(1);
    const v = violacoes.find((x) => x.tabela === TABELA_SONDA);
    expect(v, `a varredura não achou ${TABELA_SONDA} entre as violações: ${JSON.stringify(violacoes)}`).toBeDefined();
    expect(v!.razoes.join(", ")).toContain("FK direta para contacts");
    expect(v!.razoes.join(", ")).toContain("nome_livre");
    // E NADA mais reprova: só a tabela da sonda (honorários continua limpo).
    expect(violacoes.filter((x) => x.tabela !== TABELA_SONDA)).toEqual([]);
  });

  it("RESTAURO da sabotagem: declarar a seção em modulo_secoes_lgpd faz a mesma tabela passar", () => {
    criarProvisionadoraSonda();
    // Declara a seção como a migration do módulo faria (o registro é lido pelo gatilho #1901).
    sql(`
      insert into public.modulo_secoes_lgpd (modulo, tabela, ligacao, colunas, colunas_rotulo)
      values ('${MODULO_SONDA}', '${TABELA_SONDA}',
              'organization_id = $1 and contact_id = $2',
              '{nome_livre}'::text[], '{}'::text[]);
    `);
    expect(violacoesDoCatalogo(), "registrada em modulo_secoes_lgpd continuou reprovando").toEqual([]);
  });

  it("allowlist com motivo não é o mesmo que allowlist sem motivo — e autoriza com motivo escrito", () => {
    criarProvisionadoraSonda();
    // Sem motivo: continua reprovando (deixar de fora sem justificar é o mesmo que não decidir).
    const vacuo = { ...ALLOWLIST };
    (ALLOWLIST as Record<string, string>)[`${MODULO_SONDA}.${TABELA_SONDA}`] = "deixa";
    expect(
      violacoesDoCatalogo(),
      "allowlist com motivo insuficiente (< 60 chars) autorizou tabela com dado da pessoa",
    ).not.toEqual([]);
    // Com motivo escrito e suficiente: autoriza — é o escape documentado da régua.
    (ALLOWLIST as Record<string, string>)[`${MODULO_SONDA}.${TABELA_SONDA}`] =
      "Tabela de auditoria do módulo sonda: guarda apenas ids técnicos e o resumo de uma " +
      "ação de manutenção, sem texto da pessoa; a linha de texto ficou vazia por construção.";
    expect(violacoesDoCatalogo(), "allowlist com motivo escrito e suficiente continuou reprovando").toEqual([]);
    Object.assign(ALLOWLIST, vacuo);
    delete (ALLOWLIST as Record<string, string>)[`${MODULO_SONDA}.${TABELA_SONDA}`];
  });

  it("tabela de módulo SEM dado da pessoa não é obrigada a registrar (honorários é o precedente)", () => {
    // Cria uma sonda cuja tabela NÃO tem FK para contacts nem coluna de dado pessoal:
    // é o caso de honorários, que a 0480 decidiu não registrar seção.
    sql(`
      create or replace function public.fn_sondafin_provisionar()
      returns void language plpgsql security definer set search_path = public
      as $prov$
      begin
        create table if not exists public.sonda_lgpd_financeiro (
          id uuid primary key default gen_random_uuid(),
          organization_id uuid not null references public.organizations(id) on delete cascade,
          total_cents bigint not null default 0,
          vencimento date not null
        );
        perform public.fn_proteger_modulo_provisionado();
      end $prov$;
      revoke execute on function public.fn_sondafin_provisionar() from public, anon, authenticated;
      grant execute on function public.fn_sondafin_provisionar() to service_role;
    `);
    expect(tabelaExigeRegistroLGPD("sonda_lgpd_financeiro").exige).toBe(false);
    expect(
      violacoesDoCatalogo().filter((v) => v.tabela === "sonda_lgpd_financeiro"),
      "tabela sem dado da pessoa virou obrigação de LGPD",
    ).toEqual([]);
  });

  it("a varredura enxerga ordenadamente e nada foge por nome de módulo mal derivado", () => {
    criarProvisionadoraSonda();
    const v = violacoesDoCatalogo().find((x) => x.tabela === TABELA_SONDA);
    // 'fn_sondalgpd_provisionar' -> modulo 'sondalgpd' (regra ancorada no catálogo).
    expect(v?.modulo).toBe("sondalgpd");
  });
});