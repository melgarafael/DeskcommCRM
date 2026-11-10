/**
 * Push para o CELULAR dos avisos que pedem gente.
 *
 * O som da Central (`sons-da-org.ts`) só toca com o CRM aberto na tela. Quem
 * atende pelo WhatsApp passa o dia com o CRM fechado no bolso, e os avisos que
 * pedem uma pessoa esperavam sem ninguém saber. Três momentos vão ao celular:
 *
 *   - a IA passou a conversa para uma pessoa (aviso `handoff`);
 *   - a IA ficou sem saldo no provedor e as respostas estão esperando a
 *     recarga (`lib/agent-engine/queue/espera-de-saldo.ts`);
 *   - a IA rascunhou uma proposta que só uma pessoa pode revisar e enviar
 *     (`lib/propostas/aviso-de-revisao.ts`);
 *   - um negócio entrou numa etapa que avisa (migration 0440) — com o valor
 *     do negócio no título e quantos entraram hoje no corpo
 *     (`./push-de-venda.ts`), para quem PODE VER aquele negócio: a gestão vê
 *     todos, o atendente vê a própria carteira (#3981).
 *
 * São os MESMOS que têm som próprio: a regra de quais avisos pedem gente é uma
 * só (`somDoAviso`). Todos chegam pelo barramento como `central.aviso_criado`
 * (migration 0442); o resto da Central fica só na tela.
 *
 * O texto sai no idioma da ORGANIZAÇÃO — ninguém está logado quando o push sai
 * — e, com UMA exceção que é decisão do dono do produto, não carrega dado do
 * cliente: o aviso de proposta rascunhada usa o `title` da Central, que nomeia a
 * proposta e a contraparte (ver o ramo dele abaixo). Nos outros, o push aparece
 * na tela bloqueada sem nome de ninguém, e quem precisa do dado toca e abre o
 * contexto com a permissão que tem. O destino é o mesmo que a Central daria ao
 * aviso (`REFERENCIAS_DE_AVISO`).
 *
 * Os corpos são frases fixas, por isso todo ramo declara `corpoSemPrevia`
 * igual ao `body` — menos a etapa que avisa, cujo corpo pode levar a soma do
 * dia: aí o corpo sem prévia é a frase fixa, sem número. O que de fato aparece
 * com a tela bloqueada segue, além disso, a opção da empresa, aplicada pelo
 * funil `./web_push.ts`.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { PAPEL_MINIMO_DA_CENTRAL, REFERENCIAS_DE_AVISO } from "@/lib/ai/inbox-destino";
import type { VisibilityMode } from "@/lib/auth/types";
import { traduzir } from "@/lib/i18n/dicionario";
import { normalizarIdioma, type Idioma } from "@/lib/i18n/idiomas";

import {
  entradasDeHoje,
  inicioDoDia,
  linhaDoDia,
  modoDeVisibilidade,
  tituloComValor,
  valorDoNegocio,
} from "./push-de-venda";
import { truncar, type PushPayload } from "./push_payload";
import { somDoAviso } from "./sons-da-org";
import type { DestinoDoPush } from "./web_push";

/** Sem destino próprio, o push abre a Central — onde o aviso está. */
const CENTRAL = "/app/ai/inbox";

/**
 * Idioma, fuso e visibilidade da organização: o push sai sem ninguém logado, o
 * fuso diz onde começa o "hoje" da soma do dia, e o `visibility_mode` decide,
 * em `./push-de-venda.ts`, o que a GESTÃO vê — quem vê apenas a própria
 * carteira tem o escopo próprio (`escopoDoPapel`). No push da etapa que avisa,
 * é essa régua que separa os textos (#3981).
 */
export async function organizacaoDoPush(
  admin: SupabaseClient,
  orgId: string,
): Promise<{ idioma: Idioma; fuso: string | null; visibilidade: VisibilityMode }> {
  const { data } = await admin
    .from("organizations")
    .select("locale, timezone, settings")
    .eq("id", orgId)
    .maybeSingle();
  const org = data as { locale?: string | null; timezone?: string | null; settings?: unknown } | null;
  return {
    idioma: normalizarIdioma(org?.locale ?? null),
    fuso: org?.timezone ?? null,
    visibilidade: modoDeVisibilidade(org?.settings ?? null),
  };
}

type Aviso = {
  id: string;
  kind: string;
  ref_kind: string | null;
  ref_id: string | null;
  title: string;
  body: string | null;
  para_user_id: string | null;
};

/**
 * O push de um aviso e para quem ele vai. `etapa` só existe na etapa que avisa
 * (#3981): lá o texto não é um só para a organização inteira — o valor e a soma
 * do dia seguem a régua de quem VÊ o negócio (`./web_push.ts`).
 */
export type PushDoAviso = {
  payload: PushPayload;
  para: DestinoDoPush;
  etapa?: { leadId: string; daCarteira: PushPayload; semValor: PushPayload };
};

type Montagem = { payload: PushPayload; etapa?: PushDoAviso["etapa"] };

function destinoDaPassagem(item: Aviso): string {
  if (!item.ref_id) return CENTRAL;
  if (item.ref_kind === "conversation") return REFERENCIAS_DE_AVISO.conversation.href(item.ref_id);
  if (item.ref_kind === "contact") return REFERENCIAS_DE_AVISO.contact.href(item.ref_id);
  // A proposta rascunhada pela IA: o aviso pede uma pessoa, e o botão precisa
  // cair na proposta — o mesmo destino que a Central daria (`proposal`).
  if (item.ref_kind === "proposal") return REFERENCIAS_DE_AVISO.proposal.href(item.ref_id);
  return CENTRAL;
}

/**
 * O push de um aviso da Central e para quem ele vai, ou `null` quando o aviso
 * não vai ao celular. Lê o aviso do banco em vez de confiar no payload: o
 * evento carrega só o id.
 *
 * Vai a quem vê o aviso na Central: o papel mínimo da Central e, quando o aviso
 * tem destinatário (`para_user_id`), só ele — a mesma regra de `avisoVisivelPara`.
 */
export async function pushDoAvisoDaCentral(
  admin: SupabaseClient,
  orgId: string,
  itemId: string,
): Promise<PushDoAviso | null> {
  // ⚠️ Organização junto do id: o client é service-role e ignora RLS.
  const { data, error } = await admin
    .from("agent_inbox_items")
    .select("id, kind, ref_kind, ref_id, title, body, para_user_id")
    .eq("organization_id", orgId)
    .eq("id", itemId)
    .maybeSingle();
  // Ainda não enviamos nada: falha de leitura deve chegar ao dispatcher para
  // a retentativa do dreno. Retornar null consumiria o aviso como skipped.
  if (error) throw new Error(`Não foi possível ler o aviso da Central: ${error.message}`);
  const item = data as Aviso | null;
  if (!item) return null;
  const montagem = await montarPush(admin, orgId, item);
  if (!montagem) return null;
  // Aviso com destinatário (`para_user_id`) vai a UMA pessoa, por fora da régua
  // de quem vê o negócio: na etapa ele sai sem valor, para nunca levar número
  // que a tela dela não mostra. Hoje nenhum aviso de etapa grava destinatário.
  if (item.para_user_id) {
    return {
      payload: montagem.etapa?.semValor ?? montagem.payload,
      para: { papelMinimo: PAPEL_MINIMO_DA_CENTRAL, soUsuario: item.para_user_id },
    };
  }
  return { ...montagem, para: { papelMinimo: PAPEL_MINIMO_DA_CENTRAL } };
}

async function montarPush(admin: SupabaseClient, orgId: string, item: Aviso): Promise<Montagem | null> {
  const som = somDoAviso(item);
  if (som === null) return null;
  const { idioma, fuso, visibilidade } = await organizacaoDoPush(admin, orgId);
  const tag = `aviso:${item.id}`;

  // Sem saldo no provedor: o título já nasceu no idioma da organização
  // (`espera-de-saldo.ts`); o corpo diz o remédio, que fica fora do CRM.
  if (item.kind === "other" && item.ref_kind === "ai_provider_credential") {
    const body = traduzir("Recarregue o saldo na conta do provedor: as respostas saem sozinhas quando ele voltar.", idioma);
    return {
      payload: {
        title: truncar(item.title),
        body,
        corpoSemPrevia: body,
        tag,
        href: REFERENCIAS_DE_AVISO.ai_provider_credential.href(),
      },
    };
  }

  // ⚠️ A proposta rascunhada pela IA é o ÚNICO aviso que carrega o nome de quem
  // é a contraparte, e isso é decisão do dono do produto, não esquecimento: o
  // título aqui é o `title` do aviso da Central — o mesmo que o cartão da tela
  // mostra — e o corpo é a MESMA frase do cartão. Quem recebe o push precisa
  // saber de quem é o orçamento antes de abrir, e o aviso é lido por quem já tem
  // papel de gestor. Os outros ramos continuam sem nome de cliente (ver o
  // cabeçalho).
  //
  // Antes disto não existia: o aviso caía no `pessoa` abaixo e saía ao celular
  // como "A IA passou uma conversa para a equipe" / "Abra a conversa para
  // responder o cliente" — falso, e mandava quem atendia procurar uma conversa
  // que não existe.
  if (item.kind === "proposta_pronta_para_revisao") {
    const body = traduzir("A IA preparou uma proposta. Confira antes de enviar.", idioma);
    return {
      payload: {
        title: truncar(item.title),
        body,
        corpoSemPrevia: body,
        tag,
        href: destinoDaPassagem(item),
      },
    };
  }

  if (som === "pessoa") {
    const body = traduzir("Abra a conversa para responder o cliente.", idioma);
    return {
      payload: {
        title: traduzir("A IA passou uma conversa para a equipe", idioma),
        body,
        corpoSemPrevia: body,
        tag,
        href: destinoDaPassagem(item),
        tipo: "handoff",
      },
    };
  }

  // Etapa que avisa: título e corpo já nasceram no idioma da organização, só
  // com o nome da etapa (`lib/leads/aviso-de-etapa.ts`). O destino é o negócio
  // dentro do funil dele — o mesmo botão «Abrir negócio» da Central.
  //
  // O VALOR do negócio vai depois do título, e o corpo vira quantos negócios
  // entraram hoje nesta etapa, com a soma na mesma moeda (`./push-de-venda.ts`).
  //
  // O aviso não tem destinatário: vai a todo membro ativo que alcança o papel
  // mínimo. Por isso o texto NÃO é um só — quem decide é quem VÊ o negócio
  // (`fn_can_view_lead`, aplicada por `./web_push.ts`), não o `visibility_mode`
  // da organização (#3981):
  //
  //   - a GESTÃO vê a organização inteira: recebe o valor e a soma do dia;
  //   - o DONO fora do «Todos veem tudo» vê a própria carteira: recebe o valor,
  //     mas não a soma do dia — esse número é da organização e ele não o veria
  //     na tela (o mesmo cuidado do #3909);
  //   - quem NÃO vê o negócio recebe a frase fixa de antes, sem valor nenhum.
  //
  // Com `visibility_mode = 'all'` todos veem tudo, e os dois primeiros textos
  // coincidem: o que chega ao celular é exatamente o que chegava antes. O corpo
  // sem prévia segue a frase fixa, sem número, nos três casos.
  let href = CENTRAL;
  let valor: ReturnType<typeof valorDoNegocio> = null;
  if (item.ref_kind === "lead" && item.ref_id) {
    const { data: lead } = await admin
      .from("crm_leads")
      .select("pipeline_id, value_cents, currency")
      .eq("organization_id", orgId)
      .eq("id", item.ref_id)
      .maybeSingle();
    const linha = lead as { pipeline_id?: string | null; value_cents?: number | null; currency?: string | null } | null;
    if (linha?.pipeline_id) href = REFERENCIAS_DE_AVISO.lead.href(item.ref_id, linha.pipeline_id);
    valor = valorDoNegocio(linha);
  }
  const fixo = truncar(item.body ?? "");
  const semValor: PushPayload = { title: truncar(item.title), body: fixo, corpoSemPrevia: fixo, tag, href, tipo: "stage_alert" };
  // Etapa sem negócio ligado (não deveria acontecer: `aviso-de-etapa` sempre
  // grava `ref_kind = 'lead'`) ou sem id: nada a dividir, sai o texto de antes.
  if (item.ref_kind !== "lead" || !item.ref_id) return { payload: semValor };
  const moeda = valor?.moeda ?? null;
  const hoje = await entradasDeHoje(admin, orgId, item.title, moeda, inicioDoDia(new Date(), fuso));
  const dia = linhaDoDia(traduzir("Hoje nesta etapa: {quantidade}", idioma), hoje, moeda);
  const ampla: PushPayload = {
    title: truncar(tituloComValor(item.title, valor)),
    body: dia ? truncar(dia) : fixo,
    corpoSemPrevia: fixo,
    tag,
    href,
    tipo: "stage_alert",
  };
  // Em 'all' o dono vê a organização inteira: o texto dele é o mesmo da gestão.
  const daCarteira: PushPayload = visibilidade === "all" ? ampla : { ...ampla, body: fixo };
  return { payload: ampla, etapa: { leadId: item.ref_id, daCarteira, semValor } };
}
