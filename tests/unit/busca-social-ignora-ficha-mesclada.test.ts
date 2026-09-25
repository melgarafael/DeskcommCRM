import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { RAIZ_DO_REPO } from "./helpers/varrer-codigo";

/**
 * BUSCA POR `social_identity` IGNORA A FICHA MESCLADA.
 *
 * ─── A metade que faltou ────────────────────────────────────────────────────
 * Juntar duas fichas não apaga a perdedora: ela fica com `is_merged_into`
 * apontando para a vencedora. O índice único de identidade social já aprendeu
 * a ignorá-la — a `0368` traz `where social_identity is not null and
 * is_merged_into is null`, e o gate irmão
 * `indice-de-contato-ignora-ficha-mesclada` cobra isso de toda migration nova.
 *
 * A BUSCA não aprendeu. `upsertSocialContact` procura por `social_identity`
 * sem a guarda, e a issue #1315 já dizia por que os dois são necessários:
 * "índice sem busca deixa a leitura errada e busca sem índice deixa a escrita
 * errada". Entrou metade.
 *
 * ─── Os dois defeitos que a ausência da guarda produz ───────────────────────
 * 1. LEITURA ERRADA — depois da fusão, a busca reencontra a ficha MORTA e a
 *    mensagem nova do Instagram é gravada num cadastro que ninguém mais abre.
 * 2. INGESTÃO QUEBRADA — o índice parcial PERMITE, por desenho, duas linhas
 *    com a mesma `social_identity` (uma mesclada, uma viva). `.maybeSingle()`
 *    estoura quando o banco devolve as duas, e o webhook passa a falhar.
 *
 * ─── Por que ESTÁTICA, e não um dublê ───────────────────────────────────────
 * `upsertSocialContact` não é exportada: só se chega nela por
 * `ingestZernioInbound`. Exportá-la só para testar alargaria a superfície
 * pública por causa do teste. É a mesma forma de defeito — "query que esqueceu
 * um filtro" — que `telas-filtram-a-organizacao-ativa` já prende estaticamente,
 * e pela mesma razão: pega no PR em que nasce, sem Docker e sem banco.
 *
 * O preço está declarado: isto mede a FORMA da query, não o comportamento em
 * runtime. Um dublê de Supabase cobriria o comportamento e é a fatia seguinte,
 * caso alguém exporte a função por outro motivo.
 *
 * Escopo: as buscas por `social_identity` em `lib/channels/`. Se a identidade
 * social ganhar outro ponto de busca, ele entra aqui.
 */
const ALVO = "lib/channels/zernio/ingest.ts";

/**
 * Sem comentários: o que se mede é o que o V8 executa, não a prosa ao lado.
 *
 * O comentário vira UM ESPAÇO, nunca o vazio. Apagá-lo por completo colaria a
 * linha de cima na de baixo e, quando a prosa está DENTRO da cadeia (entre um
 * `.select()` e o `.eq()` seguinte), a varredura enxergaria uma cadeia
 * diferente da que existe. Foi medido: com o corte para vazio, a busca
 * consertada sumia do corpus e a cerca ficava verde por não ter olhado — o
 * controle de não-vacuidade abaixo é o que pegou isso.
 */
function semComentarios(ts: string): string {
  return ts.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");
}

/**
 * Cada cadeia `.from("contacts")` … até o terminador, como UMA string.
 *
 * A cadeia nasce quebrada em várias linhas (`.select()`, `.eq()`, `.eq()`,
 * `.maybeSingle()`). Varredura linha a linha concluiria "não filtra" em toda
 * cadeia bem escrita — o modo de falha que esta cerca existe para não ter.
 */
export function cadeiasDeContacts(ts: string): string[] {
  const limpo = semComentarios(ts);
  const cadeias: string[] = [];
  const abre = /\.from\(\s*["'`]contacts["'`]\s*\)/g;
  let m: RegExpExecArray | null;
  while ((m = abre.exec(limpo)) !== null) {
    const resto = limpo.slice(m.index);
    // O terminador é o primeiro `;` — as cadeias do supabase-js sempre acabam
    // nele, mesmo quebradas em dez linhas.
    const fim = resto.indexOf(";");
    cadeias.push(resto.slice(0, fim === -1 ? resto.length : fim));
  }
  return cadeias;
}

/** Só as cadeias que consultam a identidade social. */
export function buscasPorIdentidadeSocial(ts: string): string[] {
  return cadeiasDeContacts(ts).filter(
    (c) => /\.(eq|in)\(\s*["'`]social_identity["'`]/.test(c) && /\.select\(/.test(c),
  );
}

export function ignoraFichaMesclada(cadeia: string): boolean {
  return /\.is\(\s*["'`]is_merged_into["'`]\s*,\s*null\s*\)/.test(cadeia);
}

const FONTE = readFileSync(path.join(RAIZ_DO_REPO, ALVO), "utf8");
const BUSCAS = buscasPorIdentidadeSocial(FONTE);

describe("busca por social_identity em public.contacts", () => {
  it("enxerga o corpus que existe — varredura que não acha nada é varredura que não olhou", () => {
    expect(BUSCAS.length).toBeGreaterThanOrEqual(2);
  });

  it("ignora a ficha mesclada em TODA busca por identidade social", () => {
    const semGuarda = BUSCAS.filter((c) => !ignoraFichaMesclada(c)).map(
      (c) => `${ALVO} — busca por social_identity sem '.is("is_merged_into", null)': ${c.slice(0, 120).replace(/\s+/g, " ").trim()}`,
    );
    expect(semGuarda).toEqual([]);
  });

  /**
   * A busca do retry (pós-`23505`) usa `.single()`, que estoura em zero E em
   * duas linhas. Com a guarda, "duas" deixa de ser alcançável; sem ela, o
   * conserto da leitura teria trocado um defeito silencioso por um barulhento.
   * Esta asserção existe para que a guarda não seja removida "porque o single
   * já garante uma linha" — ele não garante, ele RECLAMA.
   */
  it("acusa o defeito e absolve o conserto", () => {
    const defeito = `const { data } = await admin.from("contacts").select("id").eq("organization_id", org).eq("social_identity", identity).maybeSingle();`;
    const conserto = `const { data } = await admin.from("contacts").select("id").eq("organization_id", org).eq("social_identity", identity).is("is_merged_into", null).maybeSingle();`;

    expect(buscasPorIdentidadeSocial(defeito).map(ignoraFichaMesclada)).toEqual([false]);
    expect(buscasPorIdentidadeSocial(conserto).map(ignoraFichaMesclada)).toEqual([true]);

    // Prosa não é código: o defeito citado num comentário não reprova ninguém.
    expect(buscasPorIdentidadeSocial(`// ${defeito}`)).toEqual([]);

    // ...mas prosa DENTRO da cadeia não pode cegar a varredura. Com o corte de
    // comentário para vazio, `.select("id")` colava no `.eq()` da linha
    // seguinte e a cadeia sumia do corpus — verde por não ter olhado.
    const comProsaNoMeio = `await admin.from("contacts").select("id")\n  // por que a guarda existe\n  .eq("organization_id", org).eq("social_identity", identity).is("is_merged_into", null).maybeSingle();`;
    expect(buscasPorIdentidadeSocial(comProsaNoMeio).map(ignoraFichaMesclada)).toEqual([true]);

    // Outra tabela com o mesmo nome de coluna não é alvo desta cerca.
    expect(
      buscasPorIdentidadeSocial(
        `await admin.from("contacts_arquivo").select("id").eq("social_identity", x);`,
      ),
    ).toEqual([]);

    // Escrita (insert) não é busca — não se filtra ficha mesclada ao criar.
    expect(
      buscasPorIdentidadeSocial(
        `await admin.from("contacts").insert({ social_identity: identity }).select("id").single();`,
      ),
    ).toEqual([]);
  });
});
