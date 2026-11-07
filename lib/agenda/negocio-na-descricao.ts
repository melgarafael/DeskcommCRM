/**
 * OS DADOS DO NEGÓCIO NO EVENTO DO GOOGLE (#4006, item 3).
 *
 * Quem abre o compromisso no celular via o evento "cru": título e descrição do
 * CRM. Não sabe de qual negócio se trata, qual produto está em jogo nem o
 * telefone do cliente. Este módulo monta o bloco que vai no FIM da descrição —
 * o Google aceita HTML simples (`<b>`, `<br>`, `<ul>`, `<li>`, `<a>`).
 *
 * ─── As três decisões que este arquivo toma ────────────────────────────────
 *
 * 1. **O texto da pessoa vem primeiro e nunca é apagado.** O bloco é acrescido
 *    ao fim; o que já estava escrito (no CRM, e por consequência no evento)
 *    continua acima dele. Reenviar o mesmo bloco não duplica: a marca é
 *    reconhecida e o bloco anterior é trocado pelo novo.
 * 2. **Contato anonimizado (LGPD) não leva nome nem telefone.** Quem chama
 *    passa `cliente: null` quando `contacts.is_anonymized` — este módulo não
 *    tem como saber, e inventar um rótulo aqui seria vazamento silencioso.
 * 3. **A escolha da proposta é uma só régua:** a ACEITA; sem aceita, a ENVIADA
 *    mais recente. Rascunho, recusada, vencida, cancelada e substituída não
 *    entram — um rascunho no evento do cliente é um preço que ninguém aprovou.
 */

import { phoneForDisplay } from "@/lib/channels/phone-variants";

/** A marca que identifica o bloco. É por ela que o reenvio reconhece o anterior. */
export const MARCA_DO_BLOCO = "<b>Negócio:</b>";

/** Um item da proposta, no recorte que o evento mostra. */
export interface ItemDoNegocio {
  descricao: string;
  quantidade: number | string;
}

/** O que a descrição precisa do negócio. Tudo já resolvido por quem chama. */
export interface NegocioParaDescricao {
  /** `crm_leads.id` — só para o link. */
  id: string;
  /** `crm_leads.title`. */
  titulo: string;
  /** `crm_stages.name`, quando existe. */
  etapa?: string | null;
  /** Itens da proposta escolhida por `escolherItensDaProposta`. */
  produtos?: ItemDoNegocio[];
  /**
   * Nome e telefone do cliente. `null` quando não há contato OU quando ele é
   * anonimizado — as duas coisas são a mesma decisão daqui para a frente: o
   * evento não leva PII de titular apagado.
   */
  cliente?: { nome?: string | null; telefone?: string | null } | null;
  /** URL pública do CRM, já montada. Sem ela, o link não aparece. */
  urlDoCrm?: string | null;
}

/**
 * Escapa o que veio do banco e vai virar HTML no Google.
 *
 * Sem isto, um produto chamado `Plano <Anual>` quebraria o bloco inteiro (e um
 * título com `<script>` viraria marcação no evento de todo convidado).
 */
export function escaparHtml(valor: string): string {
  return valor
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** `1` para inteiro, `1,5` para fracionário — o jeito que a proposta lê. */
function quantidadeLegivel(quantidade: number | string): string {
  const n = typeof quantidade === "number" ? quantidade : Number(quantidade);
  if (!Number.isFinite(n)) return "";
  return Number.isInteger(n) ? String(n) : n.toFixed(2).replace(/0+$/, "").replace(/\.$/, "").replace(".", ",");
}

/**
 * O bloco, ou string vazia quando não há negócio.
 *
 * Sem negócio NADA sai — nem a linha "Negócio:", nem um bloco vazio. É o caso
 * do compromisso que não está ligado a nenhum card do funil.
 */
export function blocoDoNegocioNoEvento(negocio: NegocioParaDescricao | null | undefined): string {
  if (!negocio || !negocio.titulo?.trim()) return "";

  const linhas: string[] = [];
  linhas.push(`${MARCA_DO_BLOCO} ${escaparHtml(negocio.titulo.trim())}<br>`);

  const etapa = negocio.etapa?.trim();
  if (etapa) linhas.push(`<b>Etapa:</b> ${escaparHtml(etapa)}<br>`);

  const produtos = (negocio.produtos ?? []).filter((p) => p.descricao?.trim());
  if (produtos.length > 0) {
    const itens = produtos
      .map((p) => {
        const qtd = quantidadeLegivel(p.quantidade);
        const sufixo = qtd ? ` (${escaparHtml(qtd)}×)` : "";
        return `<li>${escaparHtml(p.descricao.trim())}${sufixo}</li>`;
      })
      .join("");
    linhas.push(`<b>Produtos / serviços:</b><ul>${itens}</ul>`);
  }

  const nome = negocio.cliente?.nome?.trim();
  if (nome) linhas.push(`<b>Cliente:</b> ${escaparHtml(nome)}<br>`);

  const telefone = phoneForDisplay(negocio.cliente?.telefone ?? null);
  if (telefone) linhas.push(`<b>Telefone:</b> ${escaparHtml(telefone)}<br>`);

  const url = negocio.urlDoCrm?.trim();
  if (url) linhas.push(`<a href="${escaparHtml(url)}">Abrir no CRM</a>`);

  return linhas.join("");
}

/**
 * A descrição que vai ao Google: o texto da pessoa e, depois dele, o bloco.
 *
 * `description` vazio + bloco vazio devolve `undefined` (o campo não vai no
 * corpo). Quando o texto já termina com o bloco de uma passada anterior, ele é
 * SUBSTITUÍDO — assim o evento não acumula uma cópia por sincronização.
 */
export function descricaoComNegocio(
  texto: string | null | undefined,
  bloco: string,
): string | undefined {
  const limpo = (texto ?? "").trim();
  const semBlocoAnterior = limpo.includes(MARCA_DO_BLOCO)
    ? limpo.slice(0, limpo.indexOf(MARCA_DO_BLOCO)).trim()
    : limpo;
  const partes = [semBlocoAnterior, bloco.trim()].filter(Boolean);
  return partes.length > 0 ? partes.join("\n\n") : undefined;
}

/** Uma proposta no recorte da escolha. */
export interface PropostaParaEscolha {
  status: string;
  /** `crm_proposals.created_at` — desempate da "enviada mais recente". */
  criadaEm?: string | null;
  itens: ItemDoNegocio[];
}

/**
 * Qual proposta manda os itens para o evento.
 *
 * Aceita ganha sempre, mesmo que exista uma enviada mais nova. Sem aceita, vale
 * a enviada mais recente. Os outros estados não entram: rascunho é preço que
 * ninguém viu, recusada/vencida/cancelada é preço que não vale, e substituída é
 * a versão anterior de uma proposta que já tem sucessora.
 */
export function escolherItensDaProposta(propostas: readonly PropostaParaEscolha[]): ItemDoNegocio[] {
  const aceitas = propostas.filter((p) => p.status === "aceita");
  if (aceitas.length > 0) {
    const recente = maisRecente(aceitas);
    return recente?.itens ?? [];
  }
  const enviadas = propostas.filter((p) => p.status === "enviada");
  const recente = maisRecente(enviadas);
  return recente?.itens ?? [];
}

function maisRecente(propostas: readonly PropostaParaEscolha[]): PropostaParaEscolha | null {
  let melhor: PropostaParaEscolha | null = null;
  let melhorData = Number.NEGATIVE_INFINITY;
  for (const p of propostas) {
    const t = p.criadaEm ? Date.parse(p.criadaEm) : 0;
    if (!Number.isFinite(t)) continue;
    if (t > melhorData) {
      melhorData = t;
      melhor = p;
    }
  }
  return melhor;
}

/**
 * O negócio ligado a um compromisso, pronto para `blocoDoNegocioNoEvento`.
 *
 * O vínculo não é uma coluna do agendamento: mora em `crm_lead_links`
 * (`target_kind = 'appointment'`, migration 0225). É por ali que o evento
 * remarcado no Google continua sabendo de qual card veio.
 *
 * Falha de leitura NÃO é falha de sincronização: devolve `null` e o evento sai
 * como sempre saiu. O caminho contrário — segurar a publicação do compromisso
 * porque o funil não respondeu — esconderia a reunião do atendente.
 */
export async function carregarNegocioParaDescricao(
  db: { from: (tabela: string) => any },
  org: string,
  appointmentId: string,
  contactId: string | null,
  urlBase: string | null,
): Promise<NegocioParaDescricao | null> {
  try {
    const { data: link } = await db
      .from("crm_lead_links")
      .select("lead_id")
      .eq("organization_id", org)
      .eq("target_kind", "appointment")
      .eq("target_id", appointmentId)
      .maybeSingle();
    const leadId = typeof link?.lead_id === "string" ? link.lead_id : "";
    if (!leadId) return null;

    const { data: lead } = await db
      .from("crm_leads")
      .select("id,title,stage_id")
      .eq("organization_id", org)
      .eq("id", leadId)
      .maybeSingle();
    if (!lead) return null;

    const { data: etapa } = await db
      .from("crm_stages")
      .select("name")
      .eq("organization_id", org)
      .eq("id", lead.stage_id)
      .maybeSingle();

    const { data: propostas } = await db
      .from("crm_proposals")
      .select("id,status,created_at")
      .eq("organization_id", org)
      .eq("lead_id", leadId)
      .in("status", ["aceita", "enviada"]);

    const ids = (propostas ?? []).map((p: { id: string }) => p.id);
    const itensPorProposta = new Map<string, ItemDoNegocio[]>();
    if (ids.length > 0) {
      const { data: itens } = await db
        .from("crm_proposal_items")
        .select("proposal_id,descricao,quantidade")
        .eq("organization_id", org)
        .in("proposal_id", ids)
        .order("position", { ascending: true });
      for (const item of (itens ?? []) as { proposal_id: string; descricao: string; quantidade: number | string }[]) {
        const lista = itensPorProposta.get(item.proposal_id) ?? [];
        lista.push({ descricao: item.descricao, quantidade: item.quantidade });
        itensPorProposta.set(item.proposal_id, lista);
      }
    }

    const produtos = escolherItensDaProposta(
      ((propostas ?? []) as { id: string; status: string; created_at: string | null }[]).map((p) => ({
        status: p.status,
        criadaEm: p.created_at,
        itens: itensPorProposta.get(p.id) ?? [],
      })),
    );

    const cliente = await carregarCliente(db, org, contactId);
    const caminho = `/app/leads/${leadId}`;
    const urlDoCrm = urlBase ? `${urlBase.replace(/\/+$/, "")}${caminho}` : null;

    return {
      id: leadId,
      titulo: String(lead.title ?? ""),
      etapa: typeof etapa?.name === "string" ? etapa.name : null,
      produtos,
      cliente,
      urlDoCrm,
    };
  } catch {
    return null;
  }
}

/** Nome e telefone do cliente — ou `null` quando anonimizado/sem ficha. */
async function carregarCliente(
  db: { from: (tabela: string) => any },
  org: string,
  contactId: string | null,
): Promise<NegocioParaDescricao["cliente"]> {
  if (!contactId) return null;
  try {
    const { data } = await db
      .from("contacts")
      .select("name,display_name,phone_number,is_anonymized")
      .eq("organization_id", org)
      .eq("id", contactId)
      .maybeSingle();
    if (!data || data.is_anonymized) return null;
    const { nomeDoContato } = await import("@/lib/contacts/rotulo-do-contato");
    return {
      nome: nomeDoContato(data),
      telefone: typeof data.phone_number === "string" ? data.phone_number : null,
    };
  } catch {
    return null;
  }
}

/**
 * O bloco que a sincronização manda para UM compromisso — ou `null`.
 *
 * Três guardas, nesta ordem:
 *
 * 1. **Só compromisso FUTURO.** A feature não faz backfill: sem esta régua, a
 *    primeira passada depois da atualização tocaria TODO compromisso já
 *    publicado (um PATCH por evento, em toda organização).
 * 2. **O tipo manda.** `calendar_event_types.levar_dados_do_negocio` desligado
 *    não leva bloco — é o interruptor de quem escreve informação interna no
 *    nome do negócio e sabe que o cliente também é convidado.
 * 3. **Sem negócio, sem bloco.** `blocoDoNegocioNoEvento` devolve `""` e o
 *    evento sai como sempre saiu.
 */
export async function carregarBlocoDoNegocioDoEvento(
  db: { from: (tabela: string) => any },
  org: string,
  input: { appointmentId: string; contactId: string | null; startsAt: string },
  urlBase: string | null,
  agora: Date = new Date(),
): Promise<string | null> {
  const inicio = Date.parse(input.startsAt);
  if (!Number.isFinite(inicio) || inicio <= agora.getTime()) return null;
  try {
    const { data: linha } = await db
      .from("calendar_appointments")
      .select("calendar_event_types(levar_dados_do_negocio)")
      .eq("organization_id", org)
      .eq("id", input.appointmentId)
      .maybeSingle();
    const embutido = (linha as { calendar_event_types?: unknown } | null)?.calendar_event_types;
    const tipo = (Array.isArray(embutido) ? embutido[0] : embutido) as
      | { levar_dados_do_negocio?: boolean | null }
      | null
      | undefined;
    if (tipo && tipo.levar_dados_do_negocio === false) return null;

    const negocio = await carregarNegocioParaDescricao(
      db,
      org,
      input.appointmentId,
      input.contactId,
      urlBase,
    );
    return blocoDoNegocioNoEvento(negocio) || null;
  } catch {
    return null;
  }
}
