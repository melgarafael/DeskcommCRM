import "server-only";

import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";

import { nomeDaTabela } from "./nome";

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

/**
 * ⚠️ O `orgId` NÃO É DECORAÇÃO, e a razão foi medida por um cético.
 *
 * O módulo é instalado por INSTALAÇÃO (ADR-0002 D3) e isso não muda. O que passa a ser por
 * organização é **o que a tela de uma empresa chega a saber**: sem recorte aqui, o NOME do módulo
 * chega ao navegador de toda empresa da instalação por três caminhos, e esconder o painel no
 * componente não fecha nenhum deles —
 *
 *   1. o destino é `"use client"`, então `{ modulo, objeto }` vai SERIALIZADO no payload da página;
 *   2. o componente busca `/api/v1/modulos/<modulo>/<objeto>`, e o nome aparece na aba de rede;
 *   3. a rota respondia 200 com `rotulo` e `campos` mesmo sem nenhuma ficha da empresa.
 *
 * Numa instalação de revendedor, isso conta a uma empresa quais módulos as OUTRAS usam. A régua
 * que fecha os três: painel existe para esta empresa só se ela tem ao menos UMA linha na tabela do
 * módulo — e quem decide isso é o servidor, antes de qualquer coisa descer.
 *
 * Custo: uma contagem `head` por objeto declarado, só para módulos de dados instalados. O catálogo
 * oficial não publica nenhum hoje, então na prática são zero consultas; com N módulos são N
 * contagens por render da ficha. Se isso aparecer num perfil, o caminho é uma view materializada
 * por organização, não tirar o recorte.
 *
 * `orgId` vem da SESSÃO em quem chama (`resolveActiveOrg`), nunca da URL.
 */
export async function paineisDaEntidade(
  entidade: EntidadeDoNucleo,
  orgId: string,
): Promise<PainelDeModulo[]> {
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
    .select("publisher, name, extension_artifacts!artifact_id!inner(manifest)")
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

  const candidatos: Array<PainelDeModulo & { tabela: string }> = [];
  for (const linha of data as unknown as {
    publisher: string;
    name: string;
    extension_artifacts: { manifest: unknown } | { manifest: unknown }[] | null;
  }[]) {
    const bruto = Array.isArray(linha.extension_artifacts)
      ? linha.extension_artifacts[0]
      : linha.extension_artifacts;
    for (const objeto of objetosDeDados(bruto?.manifest)) {
      if (typeof objeto.slug === "string" && declaraRefPara(objeto, entidade)) {
        candidatos.push({
          modulo: linha.name,
          objeto: objeto.slug,
          tabela: nomeDaTabela(linha.publisher, linha.name, objeto.slug),
        });
      }
    }
  }

  const paineis: PainelDeModulo[] = [];
  for (const candidato of candidatos) {
    const { count, error: erroDaContagem } = await admin
      .from(candidato.tabela)
      .select("id", { count: "exact", head: true })
      .eq("organization_id", orgId)
      .limit(1);
    if (erroDaContagem) {
      // Falha fechada, e com rastro: sem painel, mas a razão fica no log. Tabela ausente aqui só
      // aconteceria num banco onde o compilador não rodou, e aí não há o que mostrar mesmo.
      logger.warn("painéis de módulo: contagem recusada — este módulo fica fora da ficha", {
        modulo: candidato.modulo,
        codigo: erroDaContagem.code,
        detalhe: erroDaContagem.message,
      });
      continue;
    }
    if ((count ?? 0) > 0) paineis.push({ modulo: candidato.modulo, objeto: candidato.objeto });
  }
  return paineis;
}
