import { describe, expect, it } from "vitest";

import {
  CANAIS_DE_IDENTIDADE,
  normalizarIdentificador,
  type CanalDeIdentidade,
} from "@/lib/contacts/identidades";

import { sql } from "./gov-helpers";

/**
 * AS DUAS RÉGUAS DA FORMA CANÔNICA CONCORDAM — issue #3764, fatia 1 (migration 9419).
 *
 * ─── O defeito que este arquivo existe para impedir ────────────────────────
 *
 * A forma canônica do identificador mora em DOIS lugares de propósito:
 *
 *   `normalizarIdentificador` (lib)  → a ingestão das redes decide com ela o
 *                                      que procurar e o que gravar;
 *   `fn_identificador_canonico` (SQL) → o banco decide com ela o que GRAVAR, no
 *                                      gatilho e na constraint.
 *
 * A duplicação é deliberada (`docs`: normalizar só em TypeScript deixaria a
 * porta do PostgREST aberta), mas ela só é honesta se as duas concordarem em
 * TODO caso. Quando divergem, o defeito é MUDO e tem duas caras:
 *
 *   1. a lib aceita e o banco grava OUTRA coisa — o app pergunta "quem tem este
 *      identificador?", compara com a coluna e não acha ninguém, então sugere
 *      ficha nova para uma pessoa que já existe; e
 *   2. a lib recusa e o banco aceita — a identidade nasce por uma porta que a
 *      outra considera inválida, e a partir daí nenhuma das duas a reconhece.
 *
 * Nenhuma das duas aparece em teste de unidade (cada lado está coerente
 * consigo) nem em revisão (o texto das duas parece igual). É por isso que a
 * comparação é medida contra o BANCO de verdade, e não contra uma cópia da
 * régua escrita aqui.
 *
 * ─── O que ele cobra ───────────────────────────────────────────────────────
 *
 * 1. mesmo resultado das duas pontas para uma matriz de entradas cruas — as que
 *    a DM entrega (o id numérico do participante) e as que o atendente cola
 *    (URL do perfil, `@` na frente, maiúscula), e as que NÃO são identidade
 *    (espaço no meio, tamanho fora da régua, `@` no fim);
 * 2. ponto fixo: o que a lib devolve tem de ser aceito pelo banco sem mudar —
 *    é o que a constraint `contact_identities_identificador_canonico` exige, e
 *    é o que impede o `insert` da ingestão de morrer em `23514`.
 *
 * Sem PII: números e perfis sintéticos.
 */

/** `null` na lib é NULL no banco; o `coalesce` só existe para o psql imprimir. */
function canonicoNoBanco(casos: ReadonlyArray<readonly [CanalDeIdentidade, string]>): (string | null)[] {
  if (casos.length === 0) return [];
  const linhas = casos
    .map(([canal, valor], i) => {
      const q = (s: string) => `'${s.replace(/'/g, "''")}'`;
      return `select ${i}::int as i, public.fn_identificador_canonico(${q(canal)}, ${q(valor)}) as r`;
    })
    .join("\nunion all\n");
  // Coluna única com TAB entre o índice e o valor: `sql()` roda psql sem `-F`,
  // então o separador de colunas é `|` e um identificador com `|` no meio
  // (impossível hoje, mas barato de não depender) bagunçaria a leitura.
  const saida = sql(
    `select i::text || chr(9) || coalesce(r, '<NULL>') from (\n${linhas}\n) t order by i;`,
  );
  return saida
    .trim()
    .split("\n")
    .map((linha) => {
      const partes = linha.split("\t");
      const valor = partes[1];
      if (valor === undefined) throw new Error(`psql devolveu linha inesperada: ${linha}`);
      return valor === "<NULL>" ? null : valor;
    });
}

/**
 * A matriz. Cada canal cobre: a forma que a ingestão entrega, a forma que o
 * atendente cola, e o lixo que não pode virar identidade.
 */
const CASOS: ReadonlyArray<readonly [CanalDeIdentidade, string]> = [
  // ── instagram: o `@` do direct, a URL colada, o perfil cru ───────────────
  ["instagram", "17841400000000001"], // o id do participante que a DM entrega
  ["instagram", "fulano"],
  ["instagram", "@Fulano"],
  ["instagram", "@@fulano"],
  ["instagram", "FULANO"],
  ["instagram", "https://www.instagram.com/fulano/?hl=pt"],
  ["instagram", "https://m.instagram.com/fulano"],
  ["instagram", "instagram.com/@fulano"],
  ["instagram", "fulano@"],
  ["instagram", "perfil.com.ponto"],
  ["instagram", "a".repeat(30)],
  ["instagram", "a".repeat(31)],
  ["instagram", "com espaço"],
  ["instagram", ""],

  // ── facebook: perfil e o id numérico (PSID) que a página entrega ─────────
  ["facebook", "24680135792468013"],
  ["facebook", "Pessoa.B"],
  ["facebook", "https://www.facebook.com/Pessoa.B/?ref=page"],
  ["facebook", "m.facebook.com/pessoa.b"],
  ["facebook", "https://fb.me/pessoa.b"],
  ["facebook", "pessoa.b@"],
  ["facebook", "1234567890"],
  ["facebook", "a".repeat(64)],
  ["facebook", "a".repeat(65)],
  ["facebook", ""],
];

describe("identidades — a lib e o banco concordam na forma canônica", () => {
  it("CONTROLE: a matriz mede os dois lados (canal do CHECK e casos com forma)", () => {
    expect(CASOS.length).toBeGreaterThanOrEqual(20);
    for (const canal of CANAIS_DE_IDENTIDADE) {
      expect(CASOS.some(([c]) => c === canal), `a matriz não cobre o canal ${canal}`).toBe(true);
    }
    // Se a lib devolvesse `null` em tudo, a comparação abaixo passaria por vazio.
    expect(CASOS.filter(([c, v]) => normalizarIdentificador(c, v) !== null).length).toBeGreaterThanOrEqual(
      15,
    );
  });

  it("cada entrada crua tem a MESMA forma canônica na lib e no banco", () => {
    const noBanco = canonicoNoBanco(CASOS);
    expect(noBanco).toHaveLength(CASOS.length);

    const divergencias: string[] = [];
    CASOS.forEach(([canal, valor], i) => {
      const daLib = normalizarIdentificador(canal, valor);
      const doBanco = noBanco[i] ?? null;
      if (daLib !== doBanco) {
        divergencias.push(
          `${canal} ${JSON.stringify(valor)}: lib=${JSON.stringify(daLib)} banco=${JSON.stringify(doBanco)}`,
        );
      }
    });

    expect(
      divergencias,
      "A lib e o banco divergem: o app sugere/junta por uma string que o banco não grava " +
        "(ou o banco aceita o que o app recusa). Nos dois casos o defeito é mudo — " +
        "a ingestão não acha a identidade e a pessoa nasce em duas fichas.",
    ).toEqual([]);
  });

  it("o que a lib devolve é PONTO FIXO da régua do banco (o `insert` não morre em 23514)", () => {
    const daLib = CASOS.map(([canal, valor]) => [canal, normalizarIdentificador(canal, valor)] as const).filter(
      (par): par is readonly [CanalDeIdentidade, string] => par[1] !== null,
    );
    expect(daLib.length).toBeGreaterThanOrEqual(15);

    const reconferido = canonicoNoBanco(daLib.map(([canal, valor]) => [canal, valor] as const));
    const quebrados = daLib
      .map(([canal, valor], i) => ({ canal, valor, banco: reconferido[i] ?? null }))
      .filter(({ valor, banco }) => banco !== valor)
      .map(({ canal, valor, banco }) => `${canal} ${JSON.stringify(valor)} → banco ${JSON.stringify(banco)}`);

    expect(
      quebrados,
      "A lib produz forma que a constraint `contact_identities_identificador_canonico` recusa: " +
        "a ingestão tenta gravar e o PostgREST devolve 23514.",
    ).toEqual([]);
  });

  it("a mesma pessoa em canais diferentes NÃO vira a mesma identidade", () => {
    const iguais = canonicoNoBanco([
      ["instagram", "fulano"],
      ["facebook", "fulano"],
    ]);
    expect(iguais[0]).toBe("fulano");
    expect(iguais[1]).toBe("fulano");
    // A chave é (canal, identificador): o unique inclui o canal, e é por isso
    // que o mesmo `fulano` nas duas redes é duas linhas, não conflito.
  });
});
