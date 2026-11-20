/**
 * O CONTEÚDO DA CAMPANHA SEGUE O QUE O CANAL ACEITA (migrations 0710 e 9334).
 *
 * Número por QR manda texto livre; número oficial manda modelo aprovado; e-mail
 * manda assunto + corpo — a pergunta é da capability do canal
 * (`modoDeCampanhaDoCanal`), nunca uma escolha solta do corpo da requisição.
 * Criar e editar passam por aqui, e a conferência do modelo é a MESMA de preparar
 * e de testar (`conferirModeloDaCampanha`): a tela nunca aceita o que o despacho
 * vai recusar.
 *
 * ─── A régua da CONTA DE ENVIO do e-mail ────────────────────────────────────
 *
 * Formato e conta são duas perguntas diferentes. `modoDeCampanhaDoCanal` diz que
 * o canal aceita assunto + corpo; quem diz que a organização PODE mandar é a
 * conta Resend dela (`organization_resend_accounts`, entregue pelo #3560).
 * Sem conta conectada não existe remetente — e aceitar o conteúdo assim mesmo
 * seria prometer um envio que não sai. A recusa tem motivo próprio
 * (`campanha_email_sem_conta`), nunca "texto livre".
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import type { ApiErrorCode } from "@/lib/api/errors";
import {
  CANAL_DE_CAMPANHA_EMAIL,
  canalTemTransmissao,
  modoDeCampanhaDoCanal,
} from "@/lib/channels/capabilities";
import { estadoDaContaResend } from "@/lib/email/resend-da-organizacao";
import { moduloLigado } from "@/lib/instalacao/modulos";

import { conferirConteudoDeEmail } from "./conteudo-de-email";
import type { VariaveisDaCampanha } from "./modelo";
import { conferirModeloDaCampanha } from "./modelo-da-conexao";
import type { ModoDaMensagem, VelocidadeDaCampanha } from "./tipos";

export interface PedidoDeConteudo {
  message_mode?: ModoDaMensagem | undefined;
  message_body?: string | null | undefined;
  /** Só do canal de e-mail (#3441): assunto. Nos demais canais é recusado. */
  email_subject?: string | null | undefined;
  provider_template_name?: string | null | undefined;
  provider_template_language?: string | null | undefined;
  provider_template_variables?: VariaveisDaCampanha | undefined;
}

export type ColunasDoConteudo = {
  message_mode: ModoDaMensagem;
  provider_template_name: string | null;
  provider_template_language: string | null;
  provider_template_variables: VariaveisDaCampanha;
  /** Assunto do e-mail; `null` em todo modo que não é `email`. */
  email_subject: string | null;
};

export type DecisaoDoConteudo =
  | {
      ok: true;
      colunas: ColunasDoConteudo;
      modo: ModoDaMensagem;
      /**
       * O texto do e-mail já conferido e aparado. Vai junto porque `message_body`
       * não é coluna de `ColunasDoConteudo` (o texto do WhatsApp é escrito pela
       * rota, e o do e-mail precisa do MESMO `trim` que a validação fez).
       */
      conteudoDeEmail?: { assunto: string; corpo: string };
    }
  | { ok: false; codigo: ApiErrorCode; mensagem: string; status: number };

/**
 * O modo que o canal aceita, lido do banco. `null` = conexão inexistente nesta
 * organização. `channelSessionId` nulo é o canal de E-MAIL: ele não é um
 * `channel_sessions`, e por isso não há linha a procurar — quem responde o
 * formato continua sendo a capability, com o canal de e-mail.
 */
export async function lerModoDoCanal(
  db: SupabaseClient,
  organizationId: string,
  channelSessionId: string | null,
): Promise<{ existe: false } | { existe: true; modo: ModoDaMensagem | null; transmissao: boolean }> {
  if (channelSessionId === null) {
    return {
      existe: true,
      modo: modoDeCampanhaDoCanal(CANAL_DE_CAMPANHA_EMAIL),
      transmissao: false,
    };
  }
  const { data } = await db
    .from("channel_sessions")
    .select("id, provider")
    .eq("organization_id", organizationId)
    .eq("id", channelSessionId)
    .maybeSingle();
  if (!data) return { existe: false };
  const provider = (data as { provider?: string | null }).provider;
  return { existe: true, modo: modoDeCampanhaDoCanal(provider), transmissao: canalTemTransmissao(provider) };
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
    /** `null` = canal de e-mail (#3441): não há número, e não há linha a conferir. */
    channelSessionId: string | null;
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
      mensagem: "Este canal não envia campanhas.",
      status: 409,
    };
  }
  // Doc 305 (A): a campanha por e-mail é o módulo `campanha_por_email`, desligado
  // de fábrica enquanto não existir o envio com descadastro. Desligado, criar ou
  // editar uma responde 404 antes de qualquer outra conferência — esconder o
  // rádio na tela sem recusar aqui deixaria a chave só cosmética.
  if (modo === "email" && !(await moduloLigado(db, "campanha_por_email"))) {
    return {
      ok: false,
      codigo: "campanha_email_desligada",
      mensagem: "A campanha por e-mail está desligada nesta instalação.",
      status: 404,
    };
  }
  if (entrada.pedido.message_mode !== undefined && entrada.pedido.message_mode !== modo) {
    return {
      ok: false,
      codigo: "campanha_modo_do_canal",
      mensagem:
        modo === "email"
          ? "Campanha de e-mail manda assunto e corpo; o modo do WhatsApp (texto ou modelo) é do número."
          : modo === "template"
            ? "Número oficial só envia campanha com modelo aprovado: fora das 24 horas o texto livre é recusado."
            : "Número por QR envia texto livre; modelo aprovado é do número oficial.",
      status: 422,
    };
  }

  // ─── E-mail: assunto + corpo, e a conta de envio da organização ───
  // Vem antes dos ramos do WhatsApp porque o modo é OUTRO canal: nenhuma das
  // regras abaixo (modelo, rodízio de números, velocidade) se aplica.
  if (modo === "email") {
    // Assunto é do e-mail e de mais ninguém: aceitá-lo num número faria a tela
    // prometer um campo que o envio ignoraria.
    const assuntoPedido = (entrada.pedido.email_subject ?? "").trim();
    if (entrada.extras.length > 0) {
      return {
        ok: false,
        codigo: "campanha_modo_do_canal",
        mensagem: "Campanha de e-mail não usa número: não há rodízio de conexões.",
        status: 422,
      };
    }
    if (
      (entrada.pedido.provider_template_name ?? "").trim() !== "" ||
      (entrada.pedido.provider_template_language ?? "").trim() !== ""
    ) {
      return {
        ok: false,
        codigo: "campanha_modo_do_canal",
        mensagem: "Campanha de e-mail não usa modelo aprovado: o assunto e o corpo são texto livre.",
        status: 422,
      };
    }

    // A régua da conta: ausência de linha recusa com motivo próprio; falha de
    // leitura NÃO é ausência (recusar como "sem conta" faria a pessoa conectar
    // de novo uma conta que já existe).
    let conta: Awaited<ReturnType<typeof estadoDaContaResend>>;
    try {
      conta = await estadoDaContaResend(db, entrada.organizationId);
    } catch {
      return {
        ok: false,
        codigo: "campanha_email_conta_indisponivel",
        mensagem:
          "A conta de envio de e-mail desta organização não pôde ser lida agora. Tente de novo em instantes.",
        status: 503,
      };
    }
    if (conta === null) {
      return {
        ok: false,
        codigo: "campanha_email_sem_conta",
        mensagem:
          "Esta organização ainda não conectou a conta Resend: sem ela não há remetente, e a campanha de e-mail não pode ser salva.",
        status: 409,
      };
    }

    const conferencia = conferirConteudoDeEmail({
      email_subject: assuntoPedido,
      message_body: entrada.pedido.message_body,
    });
    if (!conferencia.ok) {
      return { ok: false, codigo: conferencia.codigo, mensagem: conferencia.mensagem, status: conferencia.status };
    }

    return {
      ok: true,
      modo,
      colunas: {
        message_mode: "email",
        provider_template_name: null,
        provider_template_language: null,
        provider_template_variables: {},
        email_subject: conferencia.conteudo.assunto,
      },
      conteudoDeEmail: conferencia.conteudo,
    };
  }

  // Do WhatsApp em diante, assunto não existe.
  if ((entrada.pedido.email_subject ?? "").trim() !== "") {
    return {
      ok: false,
      codigo: "campanha_modo_do_canal",
      mensagem:
        "Assunto é do e-mail: no WhatsApp a campanha manda texto livre (número por QR) ou modelo aprovado (número oficial).",
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
        email_subject: null,
      },
    };
  }

  const canalDoNumero = entrada.channelSessionId;
  if (canalDoNumero === null) {
    return {
      ok: false,
      codigo: "campanha_canal_indisponivel",
      mensagem: "Campanha com modelo aprovado exige o número oficial que tem o modelo.",
      status: 409,
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
      { organizationId: entrada.organizationId, channelSessionId: canalDoNumero, name, language },
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
      email_subject: null,
    },
  };
}

export type DecisaoDaVelocidade =
  | { ok: true; velocidade: VelocidadeDaCampanha }
  | {
      ok: false;
      codigo: ApiErrorCode;
      /** Com marcadores (`{variaveis}`) para a frase ser traduzida inteira; os valores vêm em `valores`. */
      mensagem: string;
      status: number;
      valores?: Record<string, string>;
    };

/**
 * As colunas que a GRAVAÇÃO recebe, a partir da decisão — a segunda metade da
 * porta única: a mesma decisão que valida vira a linha do banco, e a rota não
 * reescreve `message_body` por conta própria (foi assim que o corpo do e-mail
 * chegaria com espaço sobrando enquanto a tela mostrava o texto aparado).
 */
export function camposDeGravacao(
  decisao: Extract<DecisaoDoConteudo, { ok: true }>,
  messageBodyPedido: string | null | undefined,
): ColunasDoConteudo & { message_body: string | null } {
  return {
    message_body:
      decisao.modo === "template"
        ? null
        : (decisao.conteudoDeEmail?.corpo ?? messageBodyPedido ?? null),
    ...decisao.colunas,
  };
}

/** A frase da recusa já traduzida, com os marcadores trocados pelos valores. */
export function fraseDaRecusa(
  recusa: { mensagem: string; valores?: Record<string, string> },
  traduzir: (texto: string) => string,
): string {
  return Object.entries(recusa.valores ?? {}).reduce(
    (frase, [chave, valor]) => frase.replaceAll(`{${chave}}`, valor),
    traduzir(recusa.mensagem),
  );
}

/**
 * As variáveis que mudam de pessoa para pessoa (nome, campo do negócio) — as que
 * a transmissão não sabe mandar: o provedor recebe UM valor por variável, o
 * mesmo para toda a lista. Texto fixo serve.
 */
export function variaveisPorPessoa(variaveis: VariaveisDaCampanha): string[] {
  return Object.entries(variaveis)
    .filter(([, fonte]) => fonte.kind !== "fixed")
    .map(([chave]) => chave)
    .sort();
}

/**
 * A VELOCIDADE SEGUE O CONTEÚDO (migrations 0711 e 0712): rápida e transmissão
 * só com modelo aprovado, que é o número oficial. Pedir qualquer uma num número
 * por QR é recusado com a frase; trocar a campanha para um número por QR a
 * devolve a gradual — a única que ali existe —, em vez de travar a edição no
 * CHECK.
 *
 * A transmissão pede mais duas coisas: que o provedor do número a faça
 * (capability `transmissao`) e que toda variável seja texto fixo. Uma campanha
 * que estava em transmissão e trocou para um número sem ela vira rápida — o
 * envio de uma vez mais próximo do que a pessoa escolheu.
 */
export function decidirVelocidade(entrada: {
  pedida: VelocidadeDaCampanha | undefined;
  atual: VelocidadeDaCampanha;
  modo: ModoDaMensagem;
  /** O provedor do número faz transmissão (capability). */
  transmissao: boolean;
  /** De onde sai cada variável do modelo: a transmissão só aceita texto fixo. */
  variaveis: VariaveisDaCampanha;
}): DecisaoDaVelocidade {
  if ((entrada.pedida === "rapida" || entrada.pedida === "transmissao") && entrada.modo !== "template") {
    return {
      ok: false,
      codigo: "campanha_velocidade_do_canal",
      mensagem:
        entrada.pedida === "rapida"
          ? "Envio rápido é só do número oficial, com modelo aprovado: no número por QR a rajada leva ao banimento."
          : "Broadcast é só do número oficial, com modelo aprovado.",
      status: 422,
    };
  }
  const velocidade = entrada.modo === "template" ? (entrada.pedida ?? entrada.atual) : "gradual";
  if (velocidade !== "transmissao") return { ok: true, velocidade };

  if (!entrada.transmissao) {
    if (entrada.pedida === "transmissao") {
      return {
        ok: false,
        codigo: "campanha_velocidade_do_canal",
        mensagem: "Este número não faz broadcast: o provedor dele não recebe a lista inteira. Use o envio rápido.",
        status: 422,
      };
    }
    return { ok: true, velocidade: "rapida" };
  }

  const porPessoa = variaveisPorPessoa(entrada.variaveis);
  if (porPessoa.length > 0) {
    return {
      ok: false,
      codigo: "campanha_transmissao_variavel",
      mensagem:
        "O broadcast manda o mesmo texto a todos, e este modelo usa dados de cada pessoa ({variaveis}). " +
        "Escreva um texto fixo nessas variáveis ou use o envio rápido.",
      status: 422,
      valores: { variaveis: porPessoa.map((k) => `{{${k}}}`).join(", ") },
    };
  }
  return { ok: true, velocidade };
}
