// lib/propostas/documento/documento-da-proposta.ts
import type { SupabaseClient } from "@supabase/supabase-js";

import { resolverModelo, type ModeloResolvido } from "../modelos/resolver";
import { montarDadosDoDocumento, type ContatoParaDocumento, type DadosDaPropostaParaDocumento } from "./montar-dados";
import { lerNegocioDoDocumento } from "./negocio-do-documento";
import { renderizarDocumento, type SecaoRenderizada } from "./renderer";
import { ondePreencher, rotuloDaVariavel, type OndePreencher } from "./rotulos-das-variaveis";

export interface PropostaParaDocumento extends DadosDaPropostaParaDocumento {
  template_slug: string | null;
  secoes_editadas: unknown;
}

export interface SecaoDoDocumento extends SecaoRenderizada {
  editada: boolean;
}

export interface CampoFaltando {
  caminho: string;
  rotulo: string;
  onde: OndePreencher;
  secoes: string[];
}

export interface DocumentoDaProposta {
  modelo: ModeloResolvido;
  secoes: SecaoDoDocumento[];
  /** Uma entrada por OCORRÊNCIA (a mesma variável em duas seções conta duas). */
  pendencias: string[];
  /** Uma entrada por VARIÁVEL, na ordem em que aparece no documento. */
  camposFaltando: CampoFaltando[];
}

/** `secoes_editadas` é jsonb sem CHECK: só entra o que for texto. */
export function lerSecoesEditadas(valor: unknown): Record<string, string> {
  if (valor === null || typeof valor !== "object" || Array.isArray(valor)) return {};
  const saida: Record<string, string> = {};
  for (const [chave, texto] of Object.entries(valor as Record<string, unknown>)) {
    if (typeof texto === "string") saida[chave] = texto;
  }
  return saida;
}

function camposFaltandoDe(
  secoes: SecaoDoDocumento[],
  rotulosDoNegocio?: Readonly<Record<string, string>>,
): CampoFaltando[] {
  const porCaminho = new Map<string, CampoFaltando>();
  for (const secao of secoes) {
    for (const caminho of secao.faltantes) {
      const existente = porCaminho.get(caminho);
      if (existente) {
        if (!existente.secoes.includes(secao.id)) existente.secoes.push(secao.id);
        continue;
      }
      porCaminho.set(caminho, {
        caminho,
        rotulo: rotuloDaVariavel(caminho, rotulosDoNegocio),
        onde: ondePreencher(caminho),
        secoes: [secao.id],
      });
    }
  }
  return [...porCaminho.values()];
}

/**
 * O ÚNICO lugar que resolve modelo + dados + reescritas + pendências (D1 da
 * spec de 26/09). A rota do documento, a trava de envio, o snapshot e o PDF
 * chamam esta função — antes o cálculo estava copiado em três pontos.
 *
 * É também o único lugar que lê o NEGÓCIO da proposta (#4533): `db` e
 * `organizationId` já estão aqui, e a leitura do card (`crm_leads` +
 * `pipelines.settings.fields`) é de apoio — falhar nela deixa o documento
 * exatamente como era.
 *
 * Não lança para "sem modelo": devolve `null`, e quem chama segue o caminho
 * da proposta sem documento.
 */
export async function montarDocumentoDaProposta(
  db: SupabaseClient,
  organizationId: string,
  proposta: PropostaParaDocumento,
  contato: ContatoParaDocumento | null,
): Promise<DocumentoDaProposta | null> {
  if (!proposta.template_slug) return null;
  const modelo = await resolverModelo(db, organizationId, proposta.template_slug);
  if (!modelo) return null;

  // A leitura do card é de APOIO: `null` (sem `lead_id`, sem linha, banco
  // recusando) devolve o documento de antes, com as três fontes de sempre.
  const negocio = await lerNegocioDoDocumento(db, organizationId, proposta.lead_id ?? null, proposta.moeda);

  const renderizado = renderizarDocumento(
    modelo,
    montarDadosDoDocumento(proposta, contato, negocio?.dados ?? null),
  );
  const editadas = lerSecoesEditadas(proposta.secoes_editadas);
  const secoes: SecaoDoDocumento[] = renderizado.secoes.map((s) =>
    editadas[s.id] !== undefined
      ? { ...s, body: editadas[s.id]!, faltantes: [], editada: true }
      : { ...s, editada: false },
  );

  return {
    modelo,
    secoes,
    pendencias: secoes.flatMap((s) => s.faltantes),
    camposFaltando: camposFaltandoDe(secoes, negocio?.rotulos),
  };
}
