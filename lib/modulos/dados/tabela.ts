import "server-only";

import { createAdminClient } from "@/lib/supabase/admin";

import { nomeDaTabela } from "./nome";

export { nomeDaTabela };

/**
 * De qual TABELA sai a ficha de um módulo de dados.
 *
 * O nome **nunca** vem da URL. Ele é derivado do que está INSTALADO: a instalação ativa daquele
 * módulo, o artefato que ela aponta, e o objeto declarado lá dentro. Um `modulo`/`objeto` que não
 * casa com nada instalado devolve `null`, e a rota responde 404 — em vez de virar nome de tabela por
 * concatenação, que deixaria qualquer pessoa autenticada ler qualquer tabela do banco.
 */

/** Tipos de campo que o host conhece. Espelha o vocabulário do compilador no banco. */
export type TipoDeCampo =
  | "texto"
  | "texto_longo"
  | "inteiro"
  | "booleano"
  | "data"
  | "data_hora"
  | "dinheiro";

export interface CampoDeclarado {
  slug: string;
  tipo: TipoDeCampo;
  obrigatorio?: boolean;
}

export interface ObjetoInstalado {
  /** Nome real da tabela em `public`. */
  tabela: string;
  /** Rótulo do objeto, para a tela mostrar o que o autor escreveu. */
  rotulo: Record<string, string>;
  campos: CampoDeclarado[];
  /** Coluna que referencia o contato, quando o objeto declara essa referência. */
  refDoContato: string | null;
}


interface LinhaDeInstalacao {
  publisher: string;
  name: string;
  artifact_id: string | null;
}

/**
 * Duas consultas, e não um embed `extension_artifacts!artifact_id!inner(manifest)`: o cliente
 * falso dos testes de token não resolve embed, e a ambiguidade de FK (`previous_artifact_id`)
 * já está fechada pela varredura `tests/unit/embed-ambiguo-do-postgrest.test.ts`. O resultado é
 * o mesmo: instalação sem artefato (`artifact_id` nulo ou linha ausente) devolve `null`.
 */
export async function tabelaDoObjeto(modulo: string, objeto: string): Promise<ObjetoInstalado | null> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("extension_installations")
    .select("publisher, name, artifact_id")
    .eq("name", modulo)
    .is("removed_at", null)
    .limit(1);
  if (error || !data?.length) return null;

  const linha = data[0] as unknown as LinhaDeInstalacao;
  if (!linha.artifact_id) return null;
  const { data: artefato, error: erroDoArtefato } = await admin
    .from("extension_artifacts")
    .select("manifest")
    .eq("id", linha.artifact_id)
    .maybeSingle();
  if (erroDoArtefato || !artefato) return null;

  const manifesto =
    artefato.manifest && typeof artefato.manifest === "object"
      ? (artefato.manifest as Record<string, unknown>)
      : null;
  if (!manifesto || manifesto.profile !== "data") return null;

  const dados = manifesto.data as { mode?: string; objetos?: unknown[] } | undefined;
  if (dados?.mode !== "declarado" || !Array.isArray(dados.objetos)) return null;

  const declarado = dados.objetos.find(
    (o): o is Record<string, unknown> =>
      typeof o === "object" && o !== null && (o as { slug?: unknown }).slug === objeto,
  );
  if (!declarado) return null;

  const refs = Array.isArray(declarado.refs) ? declarado.refs : [];
  const doContato = refs.find(
    (r): r is Record<string, unknown> =>
      typeof r === "object" && r !== null && (r as { entidade?: unknown }).entidade === "contato",
  );

  return {
    tabela: nomeDaTabela(linha.publisher, linha.name, objeto),
    rotulo: (declarado.rotulo as Record<string, string>) ?? {},
    campos: (declarado.campos as CampoDeclarado[]) ?? [],
    refDoContato: doContato ? `${String(doContato.slug)}_id` : null,
  };
}
