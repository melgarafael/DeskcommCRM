import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * TODO PAR DE RETENÇÃO DECLARADO NO TYPESCRIPT TEM DONO NO SQL — OU UMA
 * ISENÇÃO ESCRITA.
 *
 * ═══ Por que este arquivo existe ═══
 *
 * `retencao-poda-em-lotes.test.ts` casa os pisos do TypeScript com os do SQL, e
 * fazia isso com uma lista FIXA. Eu acrescentei o par do espelho e a lista virou
 * "fixa em dois mais fixa em um" — nomeei a classe e consertei a instância. Um
 * quinto par nasceria fora das duas e ninguém seria avisado; um piso que só
 * existe no TypeScript é decorativo, e a função do banco aplicaria outro número.
 *
 * Aqui a lista é DERIVADA dos exports de `lib/retencao/politica.ts`. Não há o
 * que esquecer de acrescentar: o par novo entra na varredura no instante em que
 * é exportado, e ou tem função dona, ou tem isenção com razão escrita.
 *
 * ═══ Por que casar pelo NOME DA FUNÇÃO, e não pelos números ═══
 *
 * Medido: `RETENCAO_FILA` e `RETENCAO_ESPELHO_AGENDA` têm os MESMOS valores —
 * padrão 90, piso 7. Um teste que procurasse `greatest(coalesce(…, 90), 7)` no
 * arquivo inteiro ficaria verde se UM dos dois sumisse do SQL, porque o outro
 * casaria a busca. Cada par é procurado dentro do CORPO da sua própria função.
 *
 * ═══ A isenção não é escapatória ═══
 *
 * `RETENCAO_CAPTACAO` legitimamente não está no SQL, e a razão está escrita em
 * `politica.ts`: a poda da captação é um DELETE do admin client, não uma
 * `security definer` — não existe função onde enfiar o piso. A allowlist exige
 * que a razão exista no arquivo, então "isentar" custa escrever o porquê onde o
 * próximo leitor vai procurar.
 */

const RAIZ = join(__dirname, "..", "..");
const POLITICA = readFileSync(join(RAIZ, "lib", "retencao", "politica.ts"), "utf8");
const BASELINE = readFileSync(join(RAIZ, "supabase", "baseline.sql"), "utf8");

/** O par é procurado DENTRO do corpo desta função. */
const DONO_NO_SQL: Record<string, string> = {
  FILA: "fn_podar_fila_de_jobs",
  AUDITORIA: "fn_expurgar_auditoria_vencida",
  ESPELHO_AGENDA: "fn_expurgar_espelho_da_agenda",
  // migration 0281 — a conversa interna da equipe com a IA sobre um caso. Entra
  // aqui no MESMO commit da migration, que é a lição desta lista: todo par que
  // divergiu divergiu por ter nascido sozinho.
  CONVERSA_DO_CASO: "fn_expurgar_conversa_do_caso_vencida",
  // migration 0291 — a passagem do atendimento para uma pessoa. Mesma lição:
  // entra aqui no MESMO commit da migration. O piso não é a única proteção
  // desta função (ela só apaga passagem JÁ reconhecida), mas ele é o que esta
  // lista sabe medir — o resto é `tests/invariants/passagem-retencao.test.ts`.
  PASSAGEM: "fn_expurgar_passagens_vencidas",
  // migration 0292 — o registro de entrega do aviso de caso no WhatsApp da
  // equipe. Mesma lição: entra aqui no MESMO commit da migration. É o piso mais
  // BAIXO da lista (30), e isso é decisão escrita em `politica.ts`: o que ele
  // protege é o incidente em apuração, não rastro legal.
  AVISO_DE_CASO: "fn_expurgar_avisos_de_caso_vencidos",
  // migration 0408 — o candidato da prospecção nativa vencido (issue #1313).
  // Entra aqui no MESMO commit da migration, que é a lição desta lista. Foi o
  // par que NASCEU como isenção com razão MENTIDA ("poda pelo admin client",
  // que não existia) — a isenção sem dono deixa o teste verde sem medir nada,
  // e este par é a prova: a razão escrita não correspondia ao código, e ninguém
  // percebeu até a revisão medir o repo.
  PROSPECCAO: "fn_expurgar_prospeccao_vencida",
  // migration 0421 — as observações do Jev. Entra no MESMO commit da migration.
  OBSERVACOES_DO_JEV: "fn_expurgar_observacoes_do_jev",
};

/**
 * Pares que legitimamente NÃO têm função no banco. A chave é o prefixo; o valor
 * é um trecho da razão que precisa estar escrita em `politica.ts`.
 */
const SEM_FUNCAO_NO_SQL: Record<string, string> = {
  CAPTACAO: "admin client",
};

function paresDeclarados(): string[] {
  const nomes = [...POLITICA.matchAll(/export const RETENCAO_([A-Z_]+)_DIAS_PADRAO\b/g)]
    .map((m) => m[1] as string);
  return [...new Set(nomes)].sort();
}

function valor(prefixo: string, qual: "PADRAO" | "PISO"): number {
  const m = new RegExp(`export const RETENCAO_${prefixo}_DIAS_${qual}\\s*=\\s*(\\d+)`).exec(POLITICA);
  if (!m) throw new Error(`INSTRUMENTO: não achei RETENCAO_${prefixo}_DIAS_${qual} em politica.ts`);
  return Number(m[1]);
}

function corpoDaFuncao(nome: string): string {
  // `lastIndexOf`: o baseline é dump + apêndice e vale a ÚLTIMA definição
  // (CLAUDE.md, item 10). Com `indexOf` a sonda mediria o corpo do dump — morto
  // desde o apêndice — e diria do produto o oposto do que o banco instala.
  const i = BASELINE.lastIndexOf(`create or replace function public.${nome}(`);
  if (i < 0) throw new Error(`INSTRUMENTO: função ${nome} não existe no baseline`);
  const fim = BASELINE.indexOf("$$;", i);
  return BASELINE.slice(i, fim > i ? fim : i + 4000);
}

describe("todo piso de retenção tem dono no SQL, ou isenção escrita", () => {
  it("a varredura acha os pares (guarda de vacuidade)", () => {
    // Um regex que parasse de casar devolveria lista vazia, e todo o resto
    // passaria medindo nada — verde por instrumento morto.
    expect(paresDeclarados().length).toBeGreaterThanOrEqual(4);
  });

  it("todo par declarado está mapeado: ou tem função dona, ou está isento", () => {
    // É este caso que faz a lista deixar de ser fixa. Um quinto par exportado
    // amanhã cai aqui até alguém decidir a qual dos dois lados ele pertence.
    const orfaos = paresDeclarados().filter(
      (p) => !(p in DONO_NO_SQL) && !(p in SEM_FUNCAO_NO_SQL),
    );
    expect(
      orfaos,
      "Par de retenção exportado em politica.ts sem dono: acrescente a função " +
        "que o aplica em DONO_NO_SQL, ou isente em SEM_FUNCAO_NO_SQL escrevendo " +
        "a razão em politica.ts. Piso que só existe no TypeScript é decorativo.",
    ).toEqual([]);
  });

  it.each(Object.keys(DONO_NO_SQL))("o piso de %s está no corpo da função dele", (prefixo) => {
    const fn = DONO_NO_SQL[prefixo] as string;
    const esperado = `greatest(coalesce(p_retencao_dias, ${valor(prefixo, "PADRAO")}), ${valor(prefixo, "PISO")})`;
    // Dentro do CORPO da função, e não no arquivo inteiro: fila e espelho têm os
    // mesmos números, e a busca ampla deixaria um cobrir o sumiço do outro.
    expect(corpoDaFuncao(fn)).toContain(esperado);
  });

  it.each(Object.entries(SEM_FUNCAO_NO_SQL))(
    "a isenção de %s tem a razão escrita em politica.ts",
    (prefixo, trecho) => {
      const i = POLITICA.indexOf(`RETENCAO_${prefixo}_DIAS_PADRAO`);
      expect(i).toBeGreaterThan(-1);
      // A razão vive nas ~40 linhas ao redor da declaração — onde o próximo
      // leitor vai procurar, e não num doc que morre com a entrega.
      expect(POLITICA.slice(Math.max(0, i - 2500), i + 500)).toContain(trecho);
    },
  );
});
