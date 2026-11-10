/**
 * O LIMITE DO PLANO DERIVA DOS RECURSOS QUE O PLANO DECLARA (#4172, fatia 1).
 *
 * `cobranca_planos` guarda um teto por coluna (`max_assentos`, `max_canais`,
 * `teto_ia_usd_cents`). A leitura do plano é traduzida AQUI para a declaração
 * tipada `PlanoDeclarado.recursos`, e todo consumo do teto pergunta
 * `limiteDoPlano(plano, recurso)` — sem `switch` de coluna, sem lista paralela e
 * sem `default`. Quem quiser um recurso novo acrescenta UMA entrada em
 * `RECURSOS` (vocabulario.ts), e o compilador cobra a coluna em todo plano.
 *
 * A direção importa: antes, o `case` de `fn_limite_do_plano` decidia o recurso e
 * os leitores repetiam o nome da coluna. Agora a declaração do recurso diz onde
 * o teto mora, e o limite é consequência dela.
 *
 * ⚠️ Duas recusas EXPLÍCITAS, de propósito:
 *   - recurso fora do vocabulário: o tipo barra em compilação e
 *     `recursoDoPlanoOuErro` LANÇA em runtime (dado de formulário/JSON/SQL não é
 *     confiável) — nunca cai em `undefined` nem herda `toString` do prototype;
 *   - linha sem a coluna do teto (SELECT parcial): `declararPlano` LANÇA em vez
 *     de devolver `undefined`, que viraria "sem limite" na tela.
 */
import { RECURSOS, RECURSOS_DO_PLANO, type RecursoDoPlano } from "./vocabulario";

/** A coluna de `cobranca_planos` que guarda o teto de algum recurso. */
export type ColunaDeRecurso = (typeof RECURSOS)[RecursoDoPlano]["coluna"];

/** O teto por recurso, como o plano o declara. `null` = sem limite. */
export type RecursosDoPlano = { readonly [R in RecursoDoPlano]: number | null };

/** O plano com os seus recursos declarados — o formato que o app consome. */
export interface PlanoDeclarado {
  readonly id: string;
  readonly nome: string;
  readonly recursos: RecursosDoPlano;
}

/** Recurso que o vocabulário não declara. Recusa, nunca default. */
export class RecursoForaDoVocabulario extends Error {
  constructor(readonly valor: unknown) {
    super(`recurso_do_plano_invalido:${String(valor)}`);
    this.name = "RecursoForaDoVocabulario";
  }
}

/**
 * `true` só para o que `RECURSOS` declara. `Object.hasOwn` (e não `in`) porque
 * `"toString"` e `"constructor"` também respondem a `RECURSOS[valor]` — um
 * dicionário de recurso herdado do prototype viraria teto de função em silêncio.
 */
export function ehRecursoDoPlano(valor: unknown): valor is RecursoDoPlano {
  return typeof valor === "string" && Object.hasOwn(RECURSOS, valor);
}

/** O recurso em runtime, ou a recusa explícita. Entrada de dado passa por aqui. */
export function recursoDoPlanoOuErro(valor: unknown): RecursoDoPlano {
  if (!ehRecursoDoPlano(valor)) throw new RecursoForaDoVocabulario(valor);
  return valor;
}

/** A DERIVAÇÃO: o teto do recurso vem da declaração do plano, não de um `switch`. */
export function limiteDoPlano(plano: PlanoDeclarado, recurso: RecursoDoPlano): number | null {
  return plano.recursos[recursoDoPlanoOuErro(recurso)];
}

/** Todos os tetos do plano, na ordem do vocabulário. */
export function recursosDoPlano(plano: PlanoDeclarado): RecursosDoPlano {
  const recursos = {} as Record<RecursoDoPlano, number | null>;
  for (const recurso of RECURSOS_DO_PLANO) recursos[recurso] = limiteDoPlano(plano, recurso);
  return recursos;
}

/**
 * Os tetos no formato "coluna → teto" que as telas e o painel JÁ consomem
 * (`max_assentos`, `max_canais`, `teto_ia_usd_cents`). É o único lugar onde o
 * nome da coluna reaparece — derivado da declaração, não digitado.
 */
export function limitesDaTela(plano: PlanoDeclarado): Record<ColunaDeRecurso, number | null> {
  const limites = {} as Record<ColunaDeRecurso, number | null>;
  for (const recurso of RECURSOS_DO_PLANO) limites[RECURSOS[recurso].coluna] = limiteDoPlano(plano, recurso);
  return limites;
}

/**
 * Lê a linha de `cobranca_planos` e DECLARA os recursos do plano. Toda coluna do
 * vocabulário tem de estar na linha (SELECT completo): coluna ausente, valor que
 * não é inteiro ou teto abaixo do piso do CHECK LANÇAM — não existe "campo
 * faltando vira sem limite".
 */
export function declararPlano<L extends { readonly id: string; readonly nome: string }>(
  linha: L,
): PlanoDeclarado {
  const bruta = linha as unknown as Record<string, unknown>;
  const recursos = {} as Record<RecursoDoPlano, number | null>;
  for (const recurso of RECURSOS_DO_PLANO) {
    const { coluna, minimo } = RECURSOS[recurso];
    if (!Object.hasOwn(bruta, coluna)) {
      throw new Error(
        `plano ${linha.id}: a linha não trouxe a coluna ${coluna} (recurso ${recurso}) — ` +
          "SELECT parcial não vira 'sem limite'",
      );
    }
    const teto = bruta[coluna];
    if (teto === null) {
      recursos[recurso] = null;
      continue;
    }
    if (typeof teto !== "number" || !Number.isInteger(teto) || teto < minimo) {
      throw new Error(
        `plano ${linha.id}: ${coluna}=${JSON.stringify(teto)} não é teto válido de ${recurso} ` +
          `(inteiro >= ${minimo}, ou null)`,
      );
    }
    recursos[recurso] = teto;
  }
  return { id: linha.id, nome: linha.nome, recursos };
}
