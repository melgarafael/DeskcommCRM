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
 *   - um negócio entrou numa etapa que avisa (migration 0440).
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
 * Os corpos são frases fixas, por isso todo ramo declara `corpoSemPrevia` igual
 * ao `body`. O que de fato aparece com a tela bloqueada segue, além disso, a
 * opção da empresa, aplicada pelo funil `./web_push.ts`.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { PAPEL_MINIMO_DA_CENTRAL, REFERENCIAS_DE_AVISO } from "@/lib/ai/inbox-destino";
import { traduzir } from "@/lib/i18n/dicionario";
import { normalizarIdioma, type Idioma } from "@/lib/i18n/idiomas";

import { truncar, type PushPayload } from "./push_payload";
import { somDoAviso } from "./sons-da-org";
import type { DestinoDoPush } from "./web_push";

/** Sem destino próprio, o push abre a Central — onde o aviso está. */
const CENTRAL = "/app/ai/inbox";

async function idiomaDaOrganizacao(admin: SupabaseClient, orgId: string): Promise<Idioma> {
  const { data } = await admin.from("organizations").select("locale").eq("id", orgId).maybeSingle();
  return normalizarIdioma((data as { locale?: string | null } | null)?.locale ?? null);
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
): Promise<{ payload: PushPayload; para: DestinoDoPush } | null> {
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
  const payload = await montarPush(admin, orgId, item);
  if (!payload) return null;
  const para: DestinoDoPush = item.para_user_id
    ? { papelMinimo: PAPEL_MINIMO_DA_CENTRAL, soUsuario: item.para_user_id }
    : { papelMinimo: PAPEL_MINIMO_DA_CENTRAL };
  return { payload, para };
}

async function montarPush(admin: SupabaseClient, orgId: string, item: Aviso): Promise<PushPayload | null> {
  const som = somDoAviso(item);
  if (som === null) return null;
  const idioma = await idiomaDaOrganizacao(admin, orgId);
  const tag = `aviso:${item.id}`;

  // Sem saldo no provedor: o título já nasceu no idioma da organização
  // (`espera-de-saldo.ts`); o corpo diz o remédio, que fica fora do CRM.
  if (item.kind === "other" && item.ref_kind === "ai_provider_credential") {
    const body = traduzir("Recarregue o saldo na conta do provedor: as respostas saem sozinhas quando ele voltar.", idioma);
    return {
      title: truncar(item.title),
      body,
      corpoSemPrevia: body,
      tag,
      href: REFERENCIAS_DE_AVISO.ai_provider_credential.href(),
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
      title: truncar(item.title),
      body,
      corpoSemPrevia: body,
      tag,
      href: destinoDaPassagem(item),
    };
  }

  if (som === "pessoa") {
    const body = traduzir("Abra a conversa para responder o cliente.", idioma);
    return {
      title: traduzir("A IA passou uma conversa para a equipe", idioma),
      body,
      corpoSemPrevia: body,
      tag,
      href: destinoDaPassagem(item),
    };
  }

  // Etapa que avisa: título e corpo já nasceram no idioma da organização, só
  // com o nome da etapa (`lib/leads/aviso-de-etapa.ts`). O destino é o negócio
  // dentro do funil dele — o mesmo botão «Abrir negócio» da Central.
  let href = CENTRAL;
  if (item.ref_kind === "lead" && item.ref_id) {
    const { data: lead } = await admin
      .from("crm_leads")
      .select("pipeline_id")
      .eq("organization_id", orgId)
      .eq("id", item.ref_id)
      .maybeSingle();
    const pipelineId = (lead as { pipeline_id?: string | null } | null)?.pipeline_id;
    if (pipelineId) href = REFERENCIAS_DE_AVISO.lead.href(item.ref_id, pipelineId);
  }
  const body = truncar(item.body ?? "");
  return { title: truncar(item.title), body, corpoSemPrevia: body, tag, href };
}
