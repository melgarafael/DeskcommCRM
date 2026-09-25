/**
 * O DADO QUE O CLIENTE DISSE — proposto, nunca gravado (spec 17 §4b).
 *
 * A regra de negócio da fila, separada do wire da ferramenta pelo mesmo motivo
 * de `propoeReativacao`: quem decide se uma proposta pode nascer é esta função,
 * e ela precisa ser exercitável sem passar pelo MCP.
 *
 * ═══ O QUE ESTA PEÇA RECUSA, E POR QUÊ ═══
 *
 * Recusar cedo é o trabalho principal aqui. Uma proposta que não deveria ter
 * nascido custa atenção humana — e atenção gasta com ruído é o que faz uma fila
 * de confirmação virar um botão que todo mundo aprova sem ler.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Os campos que a IA pode propor. Fechado, e igual ao CHECK de
 * `contact_field_proposals.campo` — a 0123 nasceu com três, e a 0412 (issue
 * #1546) acrescentou `birthdate`. As DUAS listas têm de andar juntas: o que o
 * código aceita e o que o banco aceita é a mesma fronteira vista de lados
 * diferentes, e divergir faria a proposta nascer aqui e morrer em 23514 na
 * confirmação — com o erro aparecendo para quem não causou.
 */
export const CAMPOS_PROPONIVEIS = ["email", "name", "phone_number", "birthdate"] as const;
export type CampoProponivel = (typeof CAMPOS_PROPONIVEIS)[number];

export type MotivoSemProposta =
  | "contato_nao_encontrado"
  | "contato_anonimizado" // L-04: dado de quem exerceu o esquecimento não volta
  | "valor_invalido"
  | "valor_igual_ao_atual" // nada a decidir
  | "ja_existe_proposta"
  | "erro";

export type ResultadoDaProposta =
  | { criada: true; id: string; valorAnterior: string | null }
  | { criada: false; motivo: MotivoSemProposta; detalhe?: string };

export interface DadosDaProposta {
  organizationId: string;
  contactId: string;
  campo: CampoProponivel;
  valor: string;
  /** O que a pessoa escreveu. Sem isto, confirmar é um ato de fé. */
  trecho?: string | null;
  conversationId?: string | null;
  messageId?: string | null;
  agentId?: string | null;
  /** Dias até vencer. Proposta sem prazo vira badge permanente. */
  diasDePrazo?: number;
}

/** Prazo padrão. Uma semana é tempo de alguém abrir o CRM sem ser incômodo. */
const PRAZO_PADRAO_DIAS = 7;

/**
 * Validação por campo — a fronteira entre "o cliente disse" e "vai para o banco".
 *
 * Deliberadamente MODESTA: valida FORMA, não veracidade. Um e-mail sintaticamente
 * válido pode ser mentira, e nenhuma regex resolve isso — quem resolve é a
 * pessoa que confirma. Prometer mais aqui daria falsa segurança a quem aprova.
 */
export function valorAceitavel(campo: CampoProponivel, valor: string): boolean {
  const v = valor.trim();
  if (v === "" || v.length > 200) return false;

  if (campo === "email") {
    // Mesmo critério do CHECK `contacts_email_format`: tem arroba e ponto no
    // domínio. Divergir dele faria a proposta ser aceita aqui e explodir na
    // confirmação, com o erro aparecendo para quem não causou.
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
  }
  if (campo === "phone_number") {
    const digitos = v.replace(/\D/g, "");
    return digitos.length >= 8 && digitos.length <= 15;
  }
  if (campo === "birthdate") {
    // MESMA forma que `contactPatchSchema` exige de `birthdate` (`AAAA-MM-DD`),
    // mais o calendário de verdade: `1990-02-30` tem a forma e não existe, e a
    // ficha grava a data que o cron `contact-birthdays` nunca acionaria. E não
    // pode estar no futuro — data que ainda vai acontecer não é nascimento, e a
    // automação de parabéns correria atrás de um aniversário que ainda não deu.
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
    if (!m) return false;
    const [, a, mo, d] = m;
    const ano = Number(a);
    const mes = Number(mo);
    const dia = Number(d);
    const data = new Date(Date.UTC(ano, mes - 1, dia));
    const existe =
      data.getUTCFullYear() === ano && data.getUTCMonth() === mes - 1 && data.getUTCDate() === dia;
    return existe && data.getTime() <= Date.now();
  }
  // name: só recusa o que claramente não é nome de gente. A guarda forte é a
  // confirmação humana; ser rígido aqui recusaria nome legítimo, que é pior.
  return v.length >= 2 && !/^\d+$/.test(v);
}

/** Normaliza para comparar com o que já está gravado. */
function normalizar(campo: CampoProponivel, valor: string): string {
  const v = valor.trim();
  if (campo === "email") return v.toLowerCase();
  if (campo === "phone_number") return `+${v.replace(/\D/g, "")}`;
  return v;
}

/**
 * Registra a proposta. **Não grava em `contacts`** — esse é o ponto.
 */
export async function proporDadoDoContato(
  db: SupabaseClient,
  dados: DadosDaProposta,
): Promise<ResultadoDaProposta> {
  const { organizationId, contactId, campo } = dados;

  if (!valorAceitavel(campo, dados.valor)) {
    return { criada: false, motivo: "valor_invalido" };
  }
  const valor = normalizar(campo, dados.valor);

  const { data: contato, error: erroContato } = await db
    .from("contacts")
    .select("id,is_anonymized,email,name,phone_number,birthdate")
    .eq("organization_id", organizationId)
    .eq("id", contactId)
    .maybeSingle();

  if (erroContato) return { criada: false, motivo: "erro", detalhe: erroContato.message.slice(0, 120) };
  if (!contato) return { criada: false, motivo: "contato_nao_encontrado" };

  // L-04, exceção "Nenhuma": quem exerceu o direito ao esquecimento não recebe
  // dado de volta pela porta dos fundos. A proposta nem chega a existir — e o
  // gatilho da 0123 cobre o caso de a anonimização acontecer DEPOIS.
  if ((contato as { is_anonymized?: boolean }).is_anonymized === true) {
    return { criada: false, motivo: "contato_anonimizado" };
  }

  const atual = ((contato as Record<string, unknown>)[campo] as string | null) ?? null;
  if (atual !== null && normalizar(campo, atual) === valor) {
    // Não há decisão a tomar. Sem esta recusa, o cliente repetir o próprio
    // e-mail encheria a fila de propostas que confirmam o que já é verdade.
    return { criada: false, motivo: "valor_igual_ao_atual" };
  }

  const expiraEm = new Date(
    Date.now() + (dados.diasDePrazo ?? PRAZO_PADRAO_DIAS) * 24 * 3600_000,
  ).toISOString();

  const { data: criada, error } = await db
    .from("contact_field_proposals")
    .insert({
      organization_id: organizationId,
      contact_id: contactId,
      campo,
      valor_proposto: valor,
      // O `from` da L-06, capturado no nascimento: quem decide vê os dois lados,
      // e não precisa confiar que o valor anterior ainda estará lá depois.
      valor_anterior: atual,
      trecho: dados.trecho ?? null,
      conversation_id: dados.conversationId ?? null,
      message_id: dados.messageId ?? null,
      proposed_by_agent_id: dados.agentId ?? null,
      expires_at: expiraEm,
    })
    .select("id")
    .single();

  if (error) {
    // 23505 = o índice único parcial da 0123. Não é falha: é a idempotência
    // funcionando. A IA vai propor o mesmo e-mail em dez mensagens seguidas, e
    // quem barra é o BANCO — `where not exists` seria check-then-act, e dois
    // turnos concorrentes passariam pela janela.
    if ((error as { code?: string }).code === "23505") {
      return { criada: false, motivo: "ja_existe_proposta" };
    }
    return { criada: false, motivo: "erro", detalhe: error.message.slice(0, 120) };
  }

  return { criada: true, id: (criada as { id: string }).id, valorAnterior: atual };
}

// ---------------------------------------------------------------------------
// O VENCIMENTO
// ---------------------------------------------------------------------------

export interface ResultadoDoVencimento {
  vencidas: number;
  itensDeCaixa: number;
}

/**
 * Fecha as propostas que ninguém decidiu.
 *
 * **Vencer É uma decisão** — a do relógio, na ausência da humana. Sem isto, a
 * pendência fica na ficha para sempre: um badge permanente que simula atenção e
 * adia a decisão em vez de cobrá-la. Foi por isso que `expires_at` nasceu
 * obrigatório na 0123, e uma coluna de prazo que ninguém cobre é pior que
 * nenhuma — promete um limite que não existe.
 *
 * ⚠️ Devolve o número de vencidas, não `void`: quem chama precisa poder dizer
 * "rodei e não havia nada" em vez de "rodei". As duas frases têm a mesma cara
 * num log que só registra sucesso.
 */
export async function vencePropostasDeDado(
  db: SupabaseClient,
  organizationId: string,
  agora: Date,
): Promise<ResultadoDoVencimento> {
  const r: ResultadoDoVencimento = { vencidas: 0, itensDeCaixa: 0 };

  const { data, error } = await db
    .from("contact_field_proposals")
    .select("id, contact_id, campo")
    .eq("organization_id", organizationId)
    .eq("status", "pending")
    .lt("expires_at", agora.toISOString());
  if (error) throw new Error(`vencimento de proposta de dado: ${error.message}`);

  const vencidas = (data ?? []) as Array<{ id: string; contact_id: string; campo: string }>;
  if (vencidas.length === 0) return r;

  for (const p of vencidas) {
    const { error: upErr } = await db
      .from("contact_field_proposals")
      .update({ status: "expired", decided_at: agora.toISOString() })
      .eq("id", p.id)
      // Não atropela quem decidiu no MESMO instante: o `pending` no WHERE é a
      // mesma trava que a rota de decisão usa, do outro lado da corrida.
      .eq("status", "pending");
    if (upErr) continue;
    r.vencidas += 1;
  }

  if (r.vencidas > 0) {
    // UM item para o lote, não um por proposta: cinquenta avisos idênticos são
    // o mesmo ruído que a fila existe para evitar. E reusa o item aberto se já
    // houver — item que se duplica a cada tick é a praga que ele evitaria.
    const { data: jaAberto } = await db
      .from("agent_inbox_items")
      .select("id")
      .eq("organization_id", organizationId)
      .eq("kind", "contact_proposal_expired")
      .eq("status", "open")
      .maybeSingle();

    if (!jaAberto) {
      const n = r.vencidas;
      const { data: item } = await db
        .from("agent_inbox_items")
        .insert({
          organization_id: organizationId,
          kind: "contact_proposal_expired",
          severity: "info",
          title:
            n === 1
              ? "Uma informação de cliente venceu sem alguém conferir"
              : `${n} informações de clientes venceram sem alguém conferir`,
          // Diz o que ACONTECEU e o que fazer. Não repete o valor: o aviso é
          // lido por quem talvez não devesse ver o dado, e o dado continua na
          // ficha de quem tem acesso a ela.
          body:
            `O assistente ouviu ${n === 1 ? "um dado" : "alguns dados"} na conversa com ` +
            `${n === 1 ? "um cliente" : "clientes"} e ninguém confirmou a tempo. ` +
            `${n === 1 ? "Ele saiu" : "Eles saíram"} da ficha para não parecer que já estava salvo. ` +
            `Se a informação ainda importa, peça de novo ou preencha à mão.`,
          ref_kind: "organization",
          ref_id: organizationId,
        })
        .select("id")
        .maybeSingle();
      if (item) r.itensDeCaixa = 1;
    }
  }

  return r;
}
