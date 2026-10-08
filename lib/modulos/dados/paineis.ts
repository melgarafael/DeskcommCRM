import "server-only";

import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * Quais módulos de dados mostram ficha NA tela de uma entidade do núcleo.
 *
 * Resolvido no SERVIDOR, e passado como prop para a tela: não há rota nova para isso. Um endpoint só
 * para listar painéis seria mais uma superfície pública a autorizar, para devolver uma informação que
 * o servidor da própria página já pode ler.
 *
 * Duas regras, as duas da doutrina de extensões:
 *
 * - **Módulo removido não aparece.** Remover é lógico e preserva dados (não-negociável 7): as tabelas
 *   ficam, as telas saem. O filtro é `removed_at is null`.
 * - **Só o objeto que DECLAROU a referência àquela entidade.** Sem a referência não há recorte, e o
 *   painel mostraria a lista inteira da organização na ficha de uma pessoa.
 *
 * Falha de leitura devolve lista vazia, nunca lança: esta função é chamada por telas do NÚCLEO, e o
 * não-negociável 1 diz que nenhuma jornada do núcleo depende de extensão.
 */

export type EntidadeDoNucleo = "contato";

export interface PainelDeModulo {
  modulo: string;
  objeto: string;
}

interface ObjetoDeclarado {
  slug?: unknown;
  refs?: unknown;
}

function objetosDeDados(manifesto: unknown): ObjetoDeclarado[] {
  if (!manifesto || typeof manifesto !== "object") return [];
  const m = manifesto as Record<string, unknown>;
  if (m.profile !== "data") return [];
  const dados = m.data as { mode?: unknown; objetos?: unknown } | undefined;
  if (dados?.mode !== "declarado" || !Array.isArray(dados.objetos)) return [];
  return dados.objetos as ObjetoDeclarado[];
}

function declaraRefPara(objeto: ObjetoDeclarado, entidade: EntidadeDoNucleo): boolean {
  const refs = Array.isArray(objeto.refs) ? objeto.refs : [];
  return refs.some(
    (r) => typeof r === "object" && r !== null && (r as { entidade?: unknown }).entidade === entidade,
  );
}

export async function paineisDaEntidade(entidade: EntidadeDoNucleo): Promise<PainelDeModulo[]> {
  const admin = createAdminClient();
  /**
   * ⚠️ A DICA `!artifact_id` NÃO É ENFEITE. `extension_installations` tem DUAS chaves
   * estrangeiras para `extension_artifacts` — `artifact_id` e `previous_artifact_id` —, e com
   * duas o PostgREST recusa o embed inteiro (`PGRST201`). Sem a dica esta leitura falha, cai no
   * `return []` abaixo e a ficha do contato fica em branco com o módulo instalado e a tabela
   * criada: medido pelo e2e, depois de quatro testes de unidade verdes em cima — o cliente era
   * dublê, e dublê aceita qualquer `select`.
   */
  const { data, error } = await admin
    .from("extension_installations")
    .select("name, extension_artifacts!artifact_id!inner(manifest)")
    .is("removed_at", null)
    .order("name", { ascending: true });
  if (error || !data) {
    /**
     * FALHA FECHADA, MAS NUNCA MUDA. Devolver vazio é a regra (não-negociável 1:
     * nenhuma jornada do núcleo depende de extensão), e ela só é defensável se a
     * falha deixar rastro — sem isto, "nenhum módulo instalado" e "a consulta
     * quebrou" são a MESMA tela em branco, e foi exatamente esse silêncio que
     * custou uma rodada inteira de e2e: 20 s esperando um painel que nunca vinha,
     * sem uma linha dizendo por quê.
     */
    if (error) {
      logger.warn("painéis de módulo: leitura recusada — a ficha segue sem painel", {
        entidade,
        codigo: error.code,
        detalhe: error.message,
      });
    }
    return [];
  }

  const paineis: PainelDeModulo[] = [];
  for (const linha of data as unknown as {
    name: string;
    extension_artifacts: { manifest: unknown } | { manifest: unknown }[] | null;
  }[]) {
    const bruto = Array.isArray(linha.extension_artifacts)
      ? linha.extension_artifacts[0]
      : linha.extension_artifacts;
    for (const objeto of objetosDeDados(bruto?.manifest)) {
      if (typeof objeto.slug === "string" && declaraRefPara(objeto, entidade)) {
        paineis.push({ modulo: linha.name, objeto: objeto.slug });
      }
    }
  }
  return paineis;
}
