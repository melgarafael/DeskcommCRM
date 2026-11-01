import { describe, expect, it } from "vitest";

import {
  CANAIS_DE_IDENTIDADE,
  normalizarIdentificador,
  type CanalDeIdentidade,
} from "@/lib/contacts/identidades";

import { sql } from "./gov-helpers";

/**
 * AS DUAS RÉGUAS DA FORMA CANÔNICA CONCORDAM — issue #3764, fatia 1 (migration 9082).
 *
 * ─── O defeito que este arquivo existe para impedir ────────────────────────
 *
 * A forma canônica do identificador mora em DOIS lugares de propósito:
 *
 *   `normalizarIdentificador` (lib)  → o app decide com ela o que sugerir e o
 *                                      que juntar;
 *   `fn_identificador_canonico` (SQL) → o banco decide com ela o que GRAVAR, no
 *                                      gatilho e na constraint.
 *
 * A duplicação é deliberada (`docs`: normalizar só em TypeScript deixaria a
 * porta do PostgREST aberta), mas ela só é honesta se as duas concordarem em
 * TODO caso. Quando divergem, o defeito é MUDO e tem duas caras:
 *
 *   1. a lib aceita e o banco grava OUTRA coisa — o app pergunta "quem tem este
 *      identificador?", compara com a coluna e não acha ninguém, então sugere
 *      cadastro novo para uma pessoa que já existe; e
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
 *    o atendente cola (local sem `+55`, com máscara, sem o nono dígito, URL do
 *    perfil, `@` na frente, maiúscula no e-mail) e as que NÃO são identidade
 *    (texto, número curto, e-mail sem domínio);
 * 2. ponto fixo: o que a lib devolve tem de ser aceito pelo banco sem mudar —
 *    é o que a constraint `contact_identities_identificador_canonico` exige, e
 *    é o que impede o `insert` de morrer em `23514` depois de a tela já ter
 *    dito "pronto";
 * 3. a afirmação escrita no cabeçalho de `lib/contacts/identidades.ts` — que
 *    `3198966398`, `553198966398` e `+55 31 98966-398` colapsam no MESMO valor
 *    — medida no banco, não só na lib.
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
  // ── whatsapp: o número do Brasil, com e sem o nono dígito, com máscara ────
  ["whatsapp", "3198966398"], // DDD + 8 dígitos, sem o nono e sem o `+`
  ["whatsapp", "31989663989"], // DDD + 9 dígitos, sem o `+55`
  ["whatsapp", "(31) 99896-6398"], // como o atendente digita
  ["whatsapp", "55 31 9 9896-6398"], // com o `55` e sem o `+`
  ["whatsapp", "553198966398"], // E.164 sem o `+`
  ["whatsapp", "+553198966398"], // a grafia do `wa_id`, sem o nono
  ["whatsapp", "+55 31 98966-398"],
  ["whatsapp", "+55 (31) 9 8966-398"],
  ["whatsapp", "+5531998966398"],
  // fixo: o nono dígito NÃO entra (inventar um fundiria duas pessoas)
  ["whatsapp", "3132345678"],
  ["whatsapp", "553132345678"],
  ["whatsapp", "+553132345678"],
  // 13 dígitos cujo local começa em 9 mas o segundo dígito não é 6–9: a
  // variante sem o nono NÃO pode ser gerada (é o fixo de outra pessoa)
  ["whatsapp", "+5531900000000"],
  // fora do Brasil: com `+` é o número; sem `+` e com 11 dígitos a lib assume BR
  ["whatsapp", "+14155552671"],
  ["whatsapp", "14155552671"],
  ["whatsapp", "447700900123"],
  // lixo: não é telefone em forma nenhuma
  ["whatsapp", "123"],
  ["whatsapp", "+123"],
  ["whatsapp", "+1234567890123456"],
  ["whatsapp", "55 31 ****-6398"],
  ["whatsapp", "abc"],
  ["whatsapp", ""],
  ["whatsapp", "   "],
  ["whatsapp", "+55 31 98966-398 "], // espaço nas pontas

  // ── email ────────────────────────────────────────────────────────────────
  ["email", "  Maiuscula@Invariant.TEST  "],
  ["email", "user+tag@invariant.test"],
  ["email", "sem-dominio"],
  ["email", "a b@invariant.test"],
  ["email", "@invariant.test"],
  ["email", ""],

  // ── instagram: o `@` do direct, a URL colada, o perfil cru ───────────────
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
    expect(CASOS.length).toBeGreaterThanOrEqual(40);
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
        "a sugestão de vínculo não acha ninguém e a pessoa nasce em duas fichas.",
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
        "a tela diz que gravou e o PostgREST devolve 23514.",
    ).toEqual([]);
  });

  it("as grafias do MESMO telefone colapsam no mesmo identificador (o cabeçalho da lib é verdade no banco)", () => {
    const grafias = [
      "3198966398",
      "553198966398",
      "+553198966398",
      "+55 31 98966-398",
      "+55 (31) 9 8966-398",
      "(31) 99896-6398",
    ] as const;
    const noBanco = canonicoNoBanco(grafias.map((g) => ["whatsapp", g] as const));
    const distintos = new Set(noBanco);
    expect(
      distintos.size,
      `as ${grafias.length} grafias do mesmo celular viraram ${distintos.size} identidades: ${JSON.stringify(noBanco)}`,
    ).toBe(1);
    expect(noBanco[0]).not.toBeNull();
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
