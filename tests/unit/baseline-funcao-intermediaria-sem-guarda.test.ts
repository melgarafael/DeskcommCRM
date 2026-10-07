import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * FUNÇÃO INTERMEDIÁRIA NÃO ENFRAQUECE GUARDA FORTE.
 *
 * ## A classe que a `baseline-nao-constroi-o-que-derruba` deixou de fora
 *
 * O `baseline.sql` reaplica a história: a mesma função pode aparecer várias
 * vezes no apêndice, e cada definição vale até a seguinte. Se a FINAL exige uma
 * guarda forte — `fn_is_platform_admin_full` (o `scope` do JWT), que a pura
 * ignora; `fn_support_write_allowed` (o modo de suporte); ou
 * `fn_session_mfa_proven` (segundo fator) — e uma intermediária não a tem, uma
 * atualização que morra no meio deixa a versão SEM a guarda de pé até a próxima
 * passada completa. Não é o mesmo que o par criar→derrubar das policies: não há
 * como "tirar a criação", porque a intermediária é a história que os backfills
 * do próprio arquivo executam.
 *
 * ## O que foi medido, e o que foi feito
 *
 * Na `main@0c5d2154a`: **98** definições intermediárias do apêndice diferem da
 * final; **12** enfraqueciam uma guarda forte, e uma delas era corrigível:
 *
 *   · `fn_lgpd_anonymize_contact` (passo legado, 0229) usava
 *     `fn_is_platform_admin()` puro no portão — o furo da #2196. A `_full` JÁ
 *     EXISTIA antes dela (linha 337, snapshot), então a intermediária passou a
 *     usá-la: o portão antigo não existe mais em lugar nenhum do arquivo;
 *   · as outras **11** são história: a guarda nasceu DEPOIS delas
 *     (`fn_support_write_allowed`, linha 18687; `fn_session_mfa_proven`, linha
 *     21931), então referenciá-la ali seria anacrônico. Ficam declaradas, com o
 *     motivo, e a régua impede que uma NOVA apareça sem declaração.
 *
 * Fora do escopo: as 86 intermediárias restantes não mexem em guarda forte
 * (corpo, colunas, definer) — história reaplicada sem efeito de autorização. A
 * definição final de cada função continua sendo comparada com a cadeia pela
 * `apendice-do-baseline-nao-diverge-da-cadeia`.
 */
const BASELINE = readFileSync(join(process.cwd(), "supabase", "baseline.sql"), "utf8");

const linhaDe = (sql: string, pos: number): number => sql.slice(0, pos).split("\n").length;

/** As guardas fortes: `scope` do JWT, modo de suporte e segundo fator. */
const GUARDAS_FORTES = ["full", "support", "mfa"] as const;
type GuardaForte = (typeof GUARDAS_FORTES)[number];

interface Definicao {
  nome: string;
  pos: number;
  linha: number;
  guardas: Record<GuardaForte, number>;
  corpo: string;
}

function definicoes(sql: string): Definicao[] {
  const achadas: Definicao[] = [];
  const re = /create\s+(?:or\s+replace\s+)?function\s+(?:"public"|public)\s*\.\s*"?([a-z_][a-z0-9_]*)"?\s*\(/gi;
  for (let m = re.exec(sql); m !== null; m = re.exec(sql)) {
    const abre = /\$([a-z_]*)\$/i.exec(sql.slice(m.index, m.index + 1200));
    if (!abre) continue;
    const marca = abre[0];
    const fim = sql.indexOf(marca, m.index + abre.index + marca.length);
    if (fim === -1) continue;
    const bruto = sql.slice(m.index, fim + marca.length);
    const cont = (rx: RegExp) => (bruto.match(rx) ?? []).length;
    achadas.push({
      nome: m[1]!.toLowerCase(),
      pos: m.index,
      linha: linhaDe(sql, m.index),
      guardas: {
        full: cont(/fn_is_platform_admin_full/gi),
        support: cont(/fn_support_write_allowed/gi),
        mfa: cont(/fn_session_mfa_proven/gi),
      },
      corpo: bruto
        .split("\n")
        .map((l) => l.replace(/--.*$/, ""))
        .join(" ")
        .replace(/\$[a-z_]*\$/gi, "###")
        .replace(/\s+/g, " ")
        .trim()
        .toLowerCase(),
    });
  }
  return achadas;
}

interface Intermediaria {
  chave: string;
  linhaDaIntermediaria: number;
  linhaDaFinal: number;
  faltando: GuardaForte[];
}

/**
 * Intermediárias do apêndice que ENFRAQUECEM guarda forte rumo à final. A chave
 * é `nome #n`, com `n` contando só as intermediárias que diferem da final —
 * posição estável por nome, nunca por linha (linha muda a cada PR).
 *
 * A inversa (intermediária com MAIS guarda que a final) não entra: uma versão
 * mais restritiva no meio do caminho não abre nada.
 */
function intermediariasSemGuarda(sql: string): Intermediaria[] {
  const inicio = sql.search(/^-- ---- .* \(migration \d+\) ----/m);
  const porNome = new Map<string, Definicao[]>();
  for (const d of definicoes(sql)) porNome.set(d.nome, [...(porNome.get(d.nome) ?? []), d]);

  const achadas: Intermediaria[] = [];
  for (const [nome, lista] of porNome) {
    if (lista.length < 2) continue;
    const final = lista[lista.length - 1]!;
    let n = 0;
    for (const d of lista.slice(0, -1)) {
      if (d.pos < inicio) continue; // veio do dump: não é história reaplicada
      if (d.corpo === final.corpo) continue; // idêntica à final: não muda nada
      n++;
      const faltando = GUARDAS_FORTES.filter((g) => final.guardas[g] > d.guardas[g]);
      if (faltando.length > 0) {
        achadas.push({
          chave: `${nome} #${n}`,
          linhaDaIntermediaria: d.linha,
          linhaDaFinal: final.linha,
          faltando: [...faltando],
        });
      }
    }
  }
  return achadas.sort((a, b) => a.chave.localeCompare(b.chave));
}

/**
 * As intermediárias que ENFRAQUECEM guarda, DECLARADAS com o motivo — mesma
 * disciplina do `DIVERGENCIAS_CONHECIDAS` do manifest e do `CONCESSOES_ACEITAS`
 * da cerca irmã. Todas são história: a guarda forte nasceu depois delas, então
 * referenciá-la ali seria anacrônico. Resolveu (a guarda deixou de faltar)?
 * Remova daqui — a asserção de que as declaradas continuam existindo reprova.
 */
const SEM_GUARDA_DECLARADAS = new Map<string, string>([
  ["fn_conversation_assign #1", "sem `fn_support_write_allowed`; a guarda nasceu depois (linha 18687)"],
  ["fn_conversation_assign #2", "sem `fn_support_write_allowed`; a guarda nasceu depois (linha 18687)"],
  ["fn_conversation_assign #3", "sem `fn_support_write_allowed`; a guarda nasceu depois (linha 18687)"],
  ["fn_conversation_assign #4", "sem `fn_support_write_allowed`; a guarda nasceu depois (linha 18687)"],
  ["fn_conversation_assign #5", "sem `fn_support_write_allowed`; a guarda nasceu depois (linha 18687)"],
  ["emit_event #1", "sem `fn_support_write_allowed`; a guarda nasceu depois (linha 18687)"],
  ["fn_mesclar_contatos #1", "sem `fn_support_write_allowed`; a guarda nasceu depois (linha 18687)"],
  ["fn_agenda_settings #1", "sem `fn_session_mfa_proven`; a guarda nasceu depois (linha 21931)"],
  ["fn_appointment_change_core #1", "sem `fn_session_mfa_proven`; a guarda nasceu depois (linha 21931)"],
  ["fn_google_selection #1", "sem `fn_session_mfa_proven`; a guarda nasceu depois (linha 21931)"],
  ["fn_google_resolve #1", "sem `fn_session_mfa_proven`; a guarda nasceu depois (linha 21931)"],
]);

const SINTETICO = `
create or replace function public.fn_enfraquece (p text) returns void language plpgsql as $$
begin perform 1; end $$;

create or replace function public.fn_pre_apendice (p text) returns void language plpgsql as $$
begin perform 1; end $$;

-- ---- apêndice (migration 9999) ----
create or replace function public.fn_enfraquece (p text) returns void language plpgsql as $$
begin perform 1; end $$;

create or replace function public.fn_enfraquece (p text) returns void language plpgsql as $$
begin perform public.fn_session_mfa_proven(); end $$;

create or replace function public.fn_igual (p text) returns void language plpgsql as $$
begin perform public.fn_session_mfa_proven(); perform 1; end $$;

create or replace function public.fn_igual (p text) returns void language plpgsql as $$
begin perform public.fn_session_mfa_proven(); end $$;

create or replace function public.fn_final_afrouxa (p text) returns void language plpgsql as $$
begin perform public.fn_session_mfa_proven(); end $$;

create or replace function public.fn_final_afrouxa (p text) returns void language plpgsql as $$
begin perform 1; end $$;

create or replace function public.fn_pre_apendice (p text) returns void language plpgsql as $$
begin perform public.fn_session_mfa_proven(); end $$;
`;

describe("função intermediária não enfraquece guarda forte", () => {
  it("o instrumento, contra formas conhecidas", () => {
    const achadas = intermediariasSemGuarda(SINTETICO);
    // CASO VIVO: a única que perde guarda rumo à final.
    expect(achadas.map((a) => a.chave)).toEqual(["fn_enfraquece #1"]);
    expect(achadas[0]!.faltando).toEqual(["mfa"]);
    // `fn_igual` não perde guarda (só o corpo difere); `fn_final_afrouxa` é a
    // inversa (a final tem MENOS guarda — intermediária mais restritiva);
    // `fn_pre_apendice` foi definida no dump, não na história reaplicada.
    expect(achadas.map((a) => a.chave)).not.toContain("fn_igual #1");
    expect(achadas.map((a) => a.chave)).not.toContain("fn_final_afrouxa #1");
    expect(achadas.map((a) => a.chave)).not.toContain("fn_pre_apendice #1");
    // GUARDA DE VACUIDADE do instrumento: sem o mínimo, um parser quebrado
    // devolveria vazio e todo o resto passaria por ausência de dado.
    expect(definicoes(SINTETICO).length).toBeGreaterThanOrEqual(8);
  });

  it("só as declaradas, e nenhuma declarada envelhece", () => {
    const chaves = intermediariasSemGuarda(BASELINE).map((a) => a.chave);
    expect(
      [...chaves].sort(),
      "intermediária nova enfraquecendo guarda forte rumo à final: conserte (se a guarda já existir " +
        "antes dela) ou declare em SEM_GUARDA_DECLARADAS com o motivo.\n",
    ).toEqual([...SEM_GUARDA_DECLARADAS.keys()].sort());
    expect(
      [...SEM_GUARDA_DECLARADAS.keys()].filter((k) => !chaves.includes(k)),
      "a intermediária declarada deixou de enfraquecer guarda: remova de SEM_GUARDA_DECLARADAS",
    ).toEqual([]);
  });

  it("o passo legado de fn_lgpd_anonymize_contact usa `_full` — o furo da #2196 não volta por passada interrompida", () => {
    // Regressão nomeada: a intermediária de 0229 era o portão do #2196 (puro, sem
    // scope). A `_full` já existia no snapshot, então ela foi corrigida — e a
    // forma antiga não pode voltar a existir em NENHUM ponto do arquivo.
    expect(intermediariasSemGuarda(BASELINE).map((a) => a.chave)).not.toContain(
      "fn_lgpd_anonymize_contact #1",
    );
    expect(
      BASELINE,
      "o portão sem scope da #2196 reapareceu no baseline — uma atualização interrompida o deixaria de pé",
    ).not.toContain("fn_is_platform_admin() and support is null");
  });
});
