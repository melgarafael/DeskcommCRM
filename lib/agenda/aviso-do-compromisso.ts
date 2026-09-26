/**
 * O CORPO do aviso de compromisso — o que quem recebe por webhook precisa ler
 * sem fazer uma segunda consulta (#1612).
 *
 * ─── O defeito ──────────────────────────────────────────────────────────────
 * O payload de `appointment.*` saia com quatro chaves (`appointment_id`,
 * `contact_id`, `event_type_name`, `time_zone`, `transicao`): o receptor
 * sabia QUEM e QUE tipo de evento, mas não QUANDO nem em que situação — e a
 * consulta por token que ele faria para descobrir é limitada. Para pôr o
 * compromisso na agenda de outro sistema, o horário tem de vir junto.
 *
 * ─── Por que aqui e não dentro de `fecharOLaco` ─────────────────────────────
 * Porque isto é puro: montar o objeto não depende de banco, de sessão nem de
 * RLS, então é a parte que se testa sem nada em volta. O laço continua
 * decidindo QUANDO emitir (que é dele) e busca as linhas; este módulo só
 * responde o que o corpo contém — e é a pergunta que um receptor faz.
 *
 * ─── Os nomes das chaves ────────────────────────────────────────────────────
 * `inicio` · `fim` · `situacao` · `tipo {slug,nome}` · `local {tipo}` ·
 * `lead_ids[]`. As chaves antigas ficam intactas: `transicao`
 * e `event_type_name` são contrato congelado (as condições de regra existentes
 * leem `event.event_type_name`), e `time_zone` É o fuso pedido na issue —
 * duplicá-lo como `fuso` criaria dois vocabulários para o mesmo dado, que é o
 * defeito que `responsavel-do-painel` e `autorParaTimeline` já pagaram caro
 * para evitar.
 *
 * ─── O que NÃO entra aqui: o endereço e o link da reunião ───────────────────
 * Este objeto é gravado em `event_log.payload`, e nenhuma anonimização nem
 * retenção alcança o `event_log`: o redact do contato anula `location_details`
 * e `meeting_url` do compromisso (0184), e o Meet declara que derivado não é
 * segundo cofre de URL. Uma cópia aqui sobreviveria aos dois, para sempre.
 * Por isso o texto livre do local e o link saem só na ação `call_webhook`,
 * lidos da linha ATUAL do compromisso (`context.appointment`) — já redigida
 * ou cancelada quando for o caso.
 */

/** O recorte da linha do compromisso que o corpo carrega. */
export interface RecorteDoCompromisso {
  starts_at?: unknown;
  ends_at?: unknown;
  status?: unknown;
  location_kind?: unknown;
  event_type_id?: unknown;
}

/** O tipo de atendimento, lido de `calendar_event_types`. `null` quando sumiu. */
export interface TipoDoAtendimento {
  slug?: unknown;
  name?: unknown;
}

export interface EntradaDoAviso {
  appointmentId: string;
  contactId: string | null;
  transicao: string;
  /** O fuso da JORNADA — já saía no payload, continua saindo. */
  fuso: string;
  /**
   * O nome que os emissores sempre tiveram em mãos. Vira o fallback de
   * `tipo.nome` quando a linha do tipo não pôde ser lida: um nome que existe é
   * melhor que um `null`, e o campo é o mesmo de sempre (`event_type_name`).
   */
  nomeDoTipo: string;
  compromisso?: RecorteDoCompromisso | null;
  tipo?: TipoDoAtendimento | null;
  leadIds?: string[];
}

const texto = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v : null);

/**
 * Uma string que é DATA vira como o banco devolveu — sem reformatar.
 *
 * Reformatar aqui seria arriscar o fuso: `starts_at` já chega como ISO com
 * offset, e transformá-lo em outro formato derrubaria o receptor que faz
 * `new Date(payload.inicio)` com um valor que ele não esperava.
 */
const dataISO = (v: unknown): string | null => (typeof v === "string" && v ? v : null);

/**
 * O corpo do evento — sempre com as MESMAS chaves, mesmo quando a leitura da
 * linha falhou.
 *
 * A falha vira `null` nos campos novos e nunca some com o que já funcionava:
 * um payload que muda de FORMA conforme o banco respondeu é um contrato que o
 * receptor não consegue programar contra.
 */
export function payloadDoAviso(entrada: EntradaDoAviso): Record<string, unknown> {
  const compromisso = entrada.compromisso ?? null;
  const tipo = entrada.tipo ?? null;

  const leadIds = (entrada.leadIds ?? []).filter((id, i, a) => a.indexOf(id) === i);

  return {
    // ── o que já saía — contrato congelado, não se mexe ──
    appointment_id: entrada.appointmentId,
    contact_id: entrada.contactId,
    event_type_name: entrada.nomeDoTipo,
    time_zone: entrada.fuso,
    transicao: entrada.transicao,
    // ── o que faltava (#1612) ──
    inicio: dataISO(compromisso?.starts_at),
    fim: dataISO(compromisso?.ends_at),
    // `situacao` é a COLUNA, `transicao` é o CAMINHO: um compromisso remarcado
    // transiciona para `rescheduled` e continua `confirmed` na linha. São duas
    // perguntas diferentes, e responder uma com a outra enganaria quem filtra
    // por "só os confirmados".
    situacao: texto(compromisso?.status),
    tipo: {
      slug: texto(tipo?.slug),
      // O nome do TIPO é o que a condição da regra já usa; o fallback é o que
      // o emissor tinha em mãos — nunca `null` quando o nome era conhecido.
      nome: texto(tipo?.name) ?? entrada.nomeDoTipo,
    },
    // Só o TIPO do local: a descrição e o link não moram no event_log (ver o
    // cabeçalho) — o `call_webhook` os acrescenta da linha atual.
    local: { tipo: texto(compromisso?.location_kind) },
    lead_ids: leadIds,
  };
}
