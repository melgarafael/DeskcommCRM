/**
 * A PORTA DE UMA ROTA QUE ACEITA TOKEN, MONTADA DO CAMINHO DA PASTA.
 *
 * `PUBLIC_PATHS` quer dizer "o proxy não decide": quem autentica é a própria
 * rota, por `resolveAuthDual` (sessão OU Bearer `dsk_…`, a organização vinda
 * da linha do token). A porta precisa ser ESTREITA — um padrão largo daria
 * carona a irmãos literais que seguem só de sessão (`/contacts/bulk`,
 * `/leads/import`) e a sub-paths futuros.
 *
 * Com dezenas de rotas por fatia da Spec 33, escrever cada expressão à mão é
 * onde o `[^/]+` e o `$` esquecido entram. Aqui o modelo é o caminho da pasta
 * (`"/api/v1/pipelines/[id]/stages"`), e a forma estreita sai de um lugar só:
 * cada `[x]` vira forma de UUID, salvo declaração com classe e amostra, e a
 * expressão é sempre ancorada nos dois lados.
 */

/** Forma de UUID: o único segmento dinâmico que uma porta de token aceita sem declaração. */
export const FORMA_DE_UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";

/**
 * O caminho da pasta da rota, ou o mesmo caminho com a classe de cada segmento
 * que não é id e uma amostra válida dele (a amostra é o que a cerca usa para
 * montar o caminho de teste).
 */
export type ModeloDePorta =
  | string
  | { caminho: string; segmentos: Record<string, string>; amostras: Record<string, string> };

export function caminhoDoModelo(modelo: ModeloDePorta): string {
  return typeof modelo === "string" ? modelo : modelo.caminho;
}

const CLASSE_LARGA = /[/.*]|^\[\^\/\]\+$/;

function escapar(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\-]/g, "\\$&");
}

export function portaDeToken(modelo: ModeloDePorta): RegExp {
  const caminho = caminhoDoModelo(modelo);
  const segmentos = typeof modelo === "string" ? {} : modelo.segmentos;
  const amostras = typeof modelo === "string" ? {} : modelo.amostras;
  if (!caminho.startsWith("/api/v1/")) throw new Error(`porta fora de /api/v1: ${caminho}`);

  const nomes = new Set<string>();
  const partes = caminho
    .slice(1)
    .split("/")
    .map((parte) => {
      const dinamico = /^\[(.+)\]$/.exec(parte);
      if (!dinamico) return escapar(parte);
      const nome = dinamico[1] ?? "";
      if (nome.startsWith("...") || nome.startsWith("[")) throw new Error(`catch-all não ganha porta: ${caminho}`);
      nomes.add(nome);
      // Entre parênteses: uma classe com `|` não pode levar a âncora junto.
      return `(?:${segmentos[nome] ?? FORMA_DE_UUID})`;
    });

  for (const [nome, classe] of Object.entries(segmentos)) {
    if (!nomes.has(nome)) throw new Error(`segmento ${nome} não existe em ${caminho}`);
    if (CLASSE_LARGA.test(classe)) throw new Error(`classe larga demais: ${nome}`);
    const amostra = amostras[nome];
    if (amostra === undefined) throw new Error(`falta a amostra de ${nome}`);
    if (!new RegExp(`^(?:${classe})$`, "i").test(amostra)) {
      throw new Error(`amostra ${amostra} não cabe na classe de ${nome}`);
    }
  }
  for (const nome of Object.keys(amostras)) {
    if (!nomes.has(nome)) throw new Error(`segmento ${nome} não existe em ${caminho}`);
  }

  return new RegExp(`^\\/${partes.join("\\/")}$`, "i");
}
