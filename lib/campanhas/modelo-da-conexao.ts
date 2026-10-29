/**
 * O modelo aprovado de uma campanha, lido do espelho NA CONEXÃO da campanha.
 *
 * Dois números podem espelhar o mesmo nome com conteúdos diferentes, e conferir
 * a definição do número errado aprovaria uma campanha que a plataforma recusa
 * em cada envio. Por isso toda leitura aqui passa pela conexão
 * (`linhaDoEspelho` / `modelosDaConexao`), a mesma régua do pré-voo do envio
 * (`conferirDefinicao`).
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { linhaDoEspelho, modelosDaConexao } from "@/lib/channels/linha-do-espelho";
import { isStatusSendable } from "@/lib/channels/meta/template-binding";
import { deriveTemplateContract, type TemplateContract } from "@/lib/channels/meta/template-contract";

import { problemasDoMapa, type VariaveisDaCampanha } from "./modelo";

export interface DefinicaoDoModelo {
  name: string;
  language: string;
  status: string;
  category: string | null;
  components: unknown;
  parameterFormat: string | null;
  /** Links de mídia guardados na aba de modelos — pré-preenchem o cabeçalho. */
  savedValues: Record<string, string>;
}

const COLUNAS = "name, language, status, category, components, parameter_format, saved_values";

interface LinhaDoEspelho {
  name: string;
  language: string;
  status: string;
  category: string | null;
  components: unknown;
  parameter_format: string | null;
  saved_values: unknown;
}

function paraDefinicao(l: LinhaDoEspelho): DefinicaoDoModelo {
  const salvos: Record<string, string> = {};
  if (l.saved_values && typeof l.saved_values === "object" && !Array.isArray(l.saved_values)) {
    for (const [k, v] of Object.entries(l.saved_values as Record<string, unknown>)) {
      if (typeof v === "string") salvos[k] = v;
    }
  }
  return {
    name: l.name,
    language: l.language,
    status: l.status,
    category: l.category,
    components: l.components,
    parameterFormat: l.parameter_format,
    savedValues: salvos,
  };
}

export function contratoDe(d: DefinicaoDoModelo): TemplateContract {
  return deriveTemplateContract({
    name: d.name,
    language: d.language,
    ...(d.parameterFormat ? { parameter_format: d.parameterFormat } : {}),
    components: d.components as Parameters<typeof deriveTemplateContract>[0]["components"],
  });
}

/** As definições da conexão, aprovadas ou não — a tela mostra o estado de cada uma. */
export async function listarModelosDaConexao(
  db: SupabaseClient,
  chave: { organizationId: string; channelSessionId: string },
): Promise<DefinicaoDoModelo[]> {
  const { data, error } = await modelosDaConexao<LinhaDoEspelho>(db, COLUNAS, chave);
  if (error) throw new Error(`modelos da conexão: ${error.message}`);
  return data.map(paraDefinicao);
}

export async function definicaoDaCampanha(
  db: SupabaseClient,
  chave: { organizationId: string; channelSessionId: string; name: string; language: string },
): Promise<DefinicaoDoModelo | null> {
  const { data, error } = await linhaDoEspelho<LinhaDoEspelho>(db, COLUNAS, chave);
  if (error) throw new Error(`modelo da campanha: ${error.message}`);
  return data ? paraDefinicao(data) : null;
}

export type ConferenciaDoModelo =
  | { ok: true; definicao: DefinicaoDoModelo; contrato: TemplateContract }
  | { ok: false; codigo: "campanha_modelo_inexistente" | "campanha_modelo_nao_aprovado" | "campanha_modelo_variaveis"; mensagem: string };

/**
 * O modelo existe NESTE número, está aprovado e toda variável tem origem que
 * serve? É a conferência de salvar, de preparar e de testar — a mesma nas três,
 * para a tela nunca aceitar o que o despacho vai recusar.
 */
export async function conferirModeloDaCampanha(
  db: SupabaseClient,
  chave: { organizationId: string; channelSessionId: string; name: string; language: string },
  variaveis: VariaveisDaCampanha,
): Promise<ConferenciaDoModelo> {
  const definicao = await definicaoDaCampanha(db, chave);
  if (!definicao) {
    return {
      ok: false,
      codigo: "campanha_modelo_inexistente",
      mensagem: `O modelo "${chave.name}" (${chave.language}) não existe neste número. Atualize a lista de modelos em Conexões.`,
    };
  }
  if (!isStatusSendable(definicao.status)) {
    return {
      ok: false,
      codigo: "campanha_modelo_nao_aprovado",
      mensagem: `O modelo "${chave.name}" está ${definicao.status} na plataforma — só modelo aprovado pode ser enviado.`,
    };
  }
  const contrato = contratoDe(definicao);
  const problemas = problemasDoMapa(contrato, variaveis);
  if (problemas.length > 0) {
    return { ok: false, codigo: "campanha_modelo_variaveis", mensagem: problemas.join("; ") };
  }
  return { ok: true, definicao, contrato };
}
