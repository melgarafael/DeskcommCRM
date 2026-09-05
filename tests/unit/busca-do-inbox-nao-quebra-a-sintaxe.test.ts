import { createClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";

import { termoSeguroParaOr } from "@/app/api/v1/conversations/_handler";

/**
 * O TERMO DIGITADO NÃO PODE QUEBRAR A SINTAXE DO `or=` DO POSTGREST.
 *
 * ─── O defeito ───────────────────────────────────────────────────────────────
 * A busca do Inbox monta `or=(display_name.ilike.*<termo>*,name.ilike.*<termo>*)`.
 * A vírgula é o separador de condições do PostgREST — e um contato cadastrado
 * como "Sobrenome, Nome", que é como meia agenda de CRM é digitada, faz o termo
 * carregar uma vírgula até dentro da gramática.
 *
 * Medido contra o PostgREST v14.10 do stack local, buscando contato existente:
 *
 *     or=(display_name.ilike.*DIAG, 178*,…)  → HTTP 400 PGRST100
 *     or=(display_name.ilike.*DIAG* 178*,…)  → 200, 3 resultados
 *
 * Não é lista vazia: é a TELA QUEBRANDO. E o atendente nem precisa que a vírgula
 * esteja no banco — basta digitá-la.
 *
 * ─── Por que a solução é trocar pelo curinga, e não escapar ──────────────────
 * As duas saídas óbvias foram medidas contra o PostgREST real e as duas falham:
 *
 *   aspas duplas ....... `ilike."*IAG*"` devolve 0 onde `ilike.*IAG*` devolve 3.
 *                        Dentro das aspas o `*` deixa de ser curinga — consertaria
 *                        a sintaxe e mataria a busca.
 *   barra invertida .... `ilike.*I\,AG*` → HTTP 400. O PostgREST não tem escape
 *                        para vírgula fora de aspas.
 *
 * ─── O par que impede o degenerado ───────────────────────────────────────────
 * O último caso é o que impede "troque TUDO por `*`" de passar: o termo precisa
 * continuar FILTRANDO. Sem ele, uma sanitização que apagasse o termo inteiro
 * satisfaria todos os outros casos.
 */

/** Separa condições como o PostgREST faz: vírgula no nível 0 de parênteses. */
function analisa(or: string) {
  let nivel = 0;
  let condicoes = 1;
  let minimo = 0;
  for (const ch of or) {
    if (ch === "(") nivel++;
    else if (ch === ")") {
      nivel--;
      if (nivel < minimo) minimo = nivel;
    } else if (ch === "," && nivel === 0) condicoes++;
  }
  return { condicoes, nivel, minimo };
}

/** Monta o `or=` como o handler monta, e devolve o miolo (sem o par externo). */
function orDoHandler(termoBruto: string): string {
  const s = termoSeguroParaOr(termoBruto);
  const campos = [`display_name.ilike.*${s}*`, `name.ilike.*${s}*`].join(",");
  const c = createClient("http://exemplo.local", "chave-de-teste");
  const url = (c.from("contacts").select("id").or(campos) as unknown as { url: URL }).url;
  const bruto = decodeURIComponent(url.searchParams.get("or") ?? "");
  return bruto.startsWith("(") && bruto.endsWith(")") ? bruto.slice(1, -1) : bruto;
}

describe("a busca do Inbox não quebra a sintaxe do PostgREST", () => {
  it("CONTROLE: nome comum produz exatamente 2 condições, balanceadas", () => {
    const or = orDoHandler("Silva");
    expect(analisa(or), `or=${or}`).toEqual({ condicoes: 2, nivel: 0, minimo: 0 });
  });

  it("vírgula no termo NÃO vira condição extra", () => {
    const or = orDoHandler("Silva, João");
    expect(analisa(or).condicoes, `or=${or}`).toBe(2);
  });

  it("parêntese que FECHA sem abrir NÃO desbalanceia", () => {
    const or = orDoHandler("Silva) ou 1=1");
    expect(analisa(or).minimo, `or=${or}`).toBe(0);
  });

  it("parêntese que ABRE sem fechar NÃO desbalanceia", () => {
    const or = orDoHandler("Silva (Filho");
    expect(analisa(or).nivel, `or=${or}`).toBe(0);
  });

  it("o curinga `%` do ilike continua escapado — ele não é da gramática do or=", () => {
    expect(termoSeguroParaOr("100% certo")).toContain("\\%");
  });

  it("o termo continua FILTRANDO: não vira curinga universal", () => {
    // sem este par, "apague o termo todo" ou "troque tudo por *" passaria em
    // todos os casos acima.
    const s = termoSeguroParaOr("Silva, João");
    expect(s).toContain("Silva");
    expect(s).toContain("João");
    expect(s.replace(/\*/g, "").trim()).not.toBe("");
  });
});
