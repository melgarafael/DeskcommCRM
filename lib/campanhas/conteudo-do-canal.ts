/**
 * O CONTEÚDO DA CAMPANHA SEGUE O QUE O NÚMERO ACEITA (migration 0710).
 *
 * Número por QR manda texto livre; número oficial manda modelo aprovado — a
 * pergunta é da capability do canal (`modoDeCampanhaDoCanal`), nunca uma escolha
 * solta do corpo da requisição. Criar e editar passam por aqui, e a conferência
 * do modelo é a MESMA de preparar e de testar (`conferirModeloDaCampanha`): a
 * tela nunca aceita o que o despacho vai recusar.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import type { ApiErrorCode } from "@/lib/api/errors";
import { modoDeCampanhaDoCanal } from "@/lib/channels/capabilities";

import type { VariaveisDaCampanha } from "./modelo";
import { conferirModeloDaCampanha } from "./modelo-da-conexao";
import type { ModoDaMensagem, VelocidadeDaCampanha } from "./tipos";

export interface PedidoDeConteudo {
  message_mode?: ModoDaMensagem | undefined;
  message_body?: string | null | undefined;
  provider_template_name?: string | null | undefined;
  provider_template_language?: string | null | undefined;
  provider_template_variables?: VariaveisDaCampanha | undefined;
}

export type ColunasDoConteudo = {
  message_mode: ModoDaMensagem;
  provider_template_name: string | null;
  provider_template_language: string | null;
  provider_template_variables: VariaveisDaCampanha;
};

export type DecisaoDoConteudo =
  | { ok: true; colunas: ColunasDoConteudo; modo: ModoDaMensagem }
  | { ok: false; codigo: ApiErrorCode; mensagem: string; status: number };

/** O modo que o canal aceita, lido do banco. `null` = conexão inexistente nesta organização. */
export async function lerModoDoCanal(
  db: SupabaseClient,
  organizationId: string,
  channelSessionId: string,
): Promise<{ existe: false } | { existe: true; modo: ModoDaMensagem | null }> {
  const { data } = await db
    .from("channel_sessions")
    .select("id, provider")
    .eq("organization_id", organizationId)
    .eq("id", channelSessionId)
    .maybeSingle();
  if (!data) return { existe: false };
  return { existe: true, modo: modoDeCampanhaDoCanal((data as { provider?: string | null }).provider) };
}

/**
 * Decide as colunas de conteúdo de uma campanha para o número dado.
 *
 * `pedido` é o que chegou (criar: tudo; editar: só o que mudou, já mesclado com
 * o que a campanha tinha). Um modelo escolhido é conferido inteiro — existe no
 * número, está aprovado, toda variável tem origem que serve. Sem modelo ainda,
 * passa: é rascunho, e quem cobra o conteúdo é a preparação (`faltaParaEnviar`).
 */
export async function decidirConteudo(
  db: SupabaseClient,
  entrada: {
    organizationId: string;
    channelSessionId: string;
    extras: readonly string[];
    modoDoCanal: ModoDaMensagem | null;
    pedido: PedidoDeConteudo;
  },
): Promise<DecisaoDoConteudo> {
  const modo = entrada.modoDoCanal;
  if (modo === null) {
    return {
      ok: false,
      codigo: "campanha_canal_indisponivel",
      mensagem: "Este canal não envia campanhas de WhatsApp.",
      status: 409,
    };
  }
  if (entrada.pedido.message_mode !== undefined && entrada.pedido.message_mode !== modo) {
    return {
      ok: false,
      codigo: "campanha_modo_do_canal",
      mensagem:
        modo === "template"
          ? "Número oficial só envia campanha com modelo aprovado: fora das 24 horas o texto livre é recusado."
          : "Número por QR envia texto livre; modelo aprovado é do número oficial.",
      status: 422,
    };
  }

  if (modo === "text") {
    return {
      ok: true,
      modo,
      colunas: {
        message_mode: "text",
        provider_template_name: null,
        provider_template_language: null,
        provider_template_variables: {},
      },
    };
  }

  if (entrada.extras.length > 0) {
    return {
      ok: false,
      codigo: "campanha_modelo_um_numero",
      mensagem:
        "Campanha com modelo aprovado sai por um número só: cada número tem os próprios modelos na plataforma.",
      status: 422,
    };
  }

  const name = entrada.pedido.provider_template_name?.trim() || null;
  const language = entrada.pedido.provider_template_language?.trim() || null;
  const variaveis = entrada.pedido.provider_template_variables ?? {};
  if (name !== null || language !== null) {
    if (name === null || language === null) {
      return {
        ok: false,
        codigo: "campanha_modelo_inexistente",
        mensagem: "Escolha o modelo e o idioma dele.",
        status: 422,
      };
    }
    const conferencia = await conferirModeloDaCampanha(
      db,
      { organizationId: entrada.organizationId, channelSessionId: entrada.channelSessionId, name, language },
      variaveis,
    );
    if (!conferencia.ok) {
      return { ok: false, codigo: conferencia.codigo, mensagem: conferencia.mensagem, status: 422 };
    }
  }

  return {
    ok: true,
    modo,
    colunas: {
      message_mode: "template",
      provider_template_name: name,
      provider_template_language: language,
      provider_template_variables: variaveis,
    },
  };
}

export type DecisaoDaVelocidade =
  | { ok: true; velocidade: VelocidadeDaCampanha }
  | { ok: false; codigo: ApiErrorCode; mensagem: string; status: number };

/**
 * A VELOCIDADE SEGUE O CONTEÚDO (migration 0711): rápida só com modelo
 * aprovado, que é o número oficial. Pedir rápida num número por QR é recusado
 * com a frase; trocar uma campanha rápida para um número por QR a devolve a
 * gradual — a única que ali existe —, em vez de travar a edição no CHECK.
 */
export function decidirVelocidade(entrada: {
  pedida: VelocidadeDaCampanha | undefined;
  atual: VelocidadeDaCampanha;
  modo: ModoDaMensagem;
}): DecisaoDaVelocidade {
  if (entrada.pedida === "rapida" && entrada.modo !== "template") {
    return {
      ok: false,
      codigo: "campanha_velocidade_do_canal",
      mensagem:
        "Envio rápido é só do número oficial, com modelo aprovado: no número por QR a rajada leva ao banimento.",
      status: 422,
    };
  }
  const velocidade = entrada.pedida ?? entrada.atual;
  return { ok: true, velocidade: entrada.modo === "template" ? velocidade : "gradual" };
}
