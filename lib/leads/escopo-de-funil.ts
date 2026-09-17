/**
 * EM QUE FUNIS ESTE AGENTE PODE MEXER (spec 17 passo 3).
 *
 * ═══ O PROBLEMA, MEDIDO ═══
 *
 * Uma organização da produção tem **4 funis e 5 agentes**, de negócios
 * diferentes: um SDR de vendas, dois de suporte ao produto e uma atendente de
 * clínica. Os funis são "Pedidos", "Comercial - Andrea", "Comercial - Julia" e
 * "Suporte - IA". Qualquer um dos cinco alcança qualquer um dos quatro.
 *
 * ═══ POR QUE UMA FUNÇÃO PURA, E NÃO UMA CHECAGEM EM CADA FERRAMENTA ═══
 *
 * Os handlers são COMPARTILHADOS: `moveLeadHandler` serve o agente, a rota HTTP
 * sob sessão de cookie E as automações. Um gate lá dentro cobraria de uma regra
 * de automação cujo funil foi escolhido por um humano de propósito, e de um
 * atendente que está fazendo o trabalho dele.
 *
 * Então a decisão mora aqui, pura e testável, e é CHAMADA nos poucos pontos que
 * sabem que quem age é o agente. "Lembrar de cada ferramenta" é a família de
 * defeito que este repositório já mediu mais de uma vez.
 */

/** Nenhum funil marcado. Vazio significa NENHUM, nunca "todos". */
export const ESCOPO_VAZIO: readonly string[] = [];

/**
 * ONDE ESTÁ O FUNIL, para cada ferramenta que ESCREVE.
 *
 * Tabela declarativa no molde de `EQUIVALENTE_NO_OPERADOR`: uma lista que se lê
 * de uma vez vale mais que a mesma regra espalhada por vinte arquivos.
 *
 * ⚠️ **REGRA DE VACUIDADE:** ferramenta de escrita AUSENTE desta tabela é
 * RECUSADA, não liberada. É o que impede a ferramenta nova de escapar por
 * esquecimento — e `tests/unit/escopo-de-funil-cobre-as-escritas.test.ts`
 * reprova quando alguém acrescenta uma escrita sem decidir o alvo dela.
 */
export type AlvoDeFunil =
  /** O modelo informa `pipeline_id` direto no argumento. */
  | "pipeline_no_argumento"
  /** O modelo informa `lead_id`; o funil sai do lead (uma consulta). */
  | "funil_vem_do_lead"
  /** `target_kind`/`target_id`: só conta quando o alvo é um lead. */
  | "alvo_polimorfico"
  /**
   * O modelo informa `contact_id`; o funil sai do NEGÓCIO ABERTO daquele contato.
   *
   * Existe porque a agenda opera por CONTATO — quem é atendido — e não por lead:
   * `crm_book_appointment` tem `contact_id` obrigatório e nenhum `lead_id`. Sem
   * este alvo, ela só poderia ser `sem_funil`, e o escopo não valeria para ela em
   * caso nenhum.
   */
  | "funil_vem_do_contato"
  /**
   * Não toca funil nenhum. Declarado — e não ausente — porque "não se aplica" e
   * "ninguém decidiu" precisam ser distinguíveis: a segunda é bloqueada.
   */
  | "sem_funil";

export const ALVO_DE_FUNIL: Record<string, AlvoDeFunil> = {
  // ---- escrevem em crm_leads: o coração do escopo ----
  crm_create_lead: "pipeline_no_argumento",
  crm_update_lead: "funil_vem_do_lead",
  crm_move_lead_stage: "funil_vem_do_lead",
  // Encerrar é a escrita de MAIOR dano do inventário e não aparece na frase
  // "mover card": dá o negócio por ganho ou perdido, tira do radar e das
  // cobranças.
  crm_close_demand: "funil_vem_do_lead",
  crm_manage_tags: "alvo_polimorfico",
  // Não muda o card, mas pendura uma decisão humana nele — encher o funil da
  // Andrea de sugestões da IA é ocupar a atenção de quem cuida dele.
  crm_propose_reactivation: "funil_vem_do_lead",

  // ---- tocam o lead de lado: RETORNO INTERNO, não estado do card ----
  // ⚠️ Este comentário dizia "agenda", e a palavra passou a apontar para a coisa
  // errada quando o produto ganhou agenda de verdade (compromisso com hora marcada,
  // `calendar_appointments`). Retorno é decisão nossa de voltar a falar e não ocupa o
  // tempo de ninguém; compromisso é combinado com o cliente e reserva a agenda de um
  // atendente. As duas famílias de ferramenta se espelham nos verbos (schedule/cancel/
  // list), então o vocabulário aqui tem de separar o que o nome não separa.
  crm_schedule_followup: "funil_vem_do_lead",
  crm_cancel_followup: "funil_vem_do_lead",

  // ---- agenda: DECLARADAS `sem_funil`, e a declaração é o ponto ----
  //
  // As três operam por `contact_id` (marcar) ou `appointment_id` (remarcar e
  // cancelar). NENHUMA recebe `lead_id`. Classificá-las `funil_vem_do_lead` seria
  // TEATRO: o gate procuraria um argumento que nunca vem, cairia no ramo de
  // "sem lead" e liberaria 100% das vezes — com aparência de escopado. Quem lesse
  // a tabela concluiria "está protegido" e estaria errado.
  //
  // `sem_funil` e `funil_vem_do_lead`-que-nunca-resolve têm comportamento IDÊNTICO
  // e legibilidade oposta. Declarar o que não protege é o uso correto deste valor,
  // que existe — nas palavras do próprio tipo — "porque 'não se aplica' e 'ninguém
  // decidiu' precisam ser distinguíveis".
  //
  // Quem limita estas três é o RBAC (agent+ escreve compromisso) e o risco
  // `critico` do cancelar, que não entra por pacote. O alvo `funil_vem_do_contato`
  // (DECISÃO 27) fecharia `crm_book_appointment` de verdade, porque ali o
  // `contact_id` é OBRIGATÓRIO — entra em seguida, com resolvedor próprio.
  // DECISÃO 27: `contact_id` é OBRIGATÓRIO aqui, então o alvo resolve de verdade —
  // diferente de remarcar e cancelar, que operam por `appointment_id` e continuam
  // `sem_funil` declarado enquanto não houver resolvedor por agendamento.
  crm_book_appointment: "funil_vem_do_contato",
  // Consulta E marca numa chamada só (issue #831): o `contact_id` é OBRIGATÓRIO
  // como no marcar puro (DECISÃO 27), então o alvo resolve de verdade.
  crm_find_and_book_appointment: "funil_vem_do_contato",
  crm_reschedule_appointment: "sem_funil",
  crm_cancel_appointment: "sem_funil",
  // Mesmo argumento das duas acima, e pela mesma razão: operam por
  // `appointment_id` e nunca recebem `lead_id`. Classificá-las
  // `funil_vem_do_lead` seria teatro — o gate procuraria um argumento que não
  // vem e liberaria 100% das vezes, com aparência de escopado.
  crm_confirm_appointment: "sem_funil",
  crm_set_appointment_outcome: "sem_funil",

  // ---- não têm funil, e isso é declarado ----
  crm_send_whatsapp_message: "sem_funil",
  // Abre conversa nova (contato pode nem ter negócio ainda) e manda a primeira
  // mensagem — não recebe `lead_id` nem `pipeline_id`. Como as de configuração
  // logo abaixo, a barreira dela é OUTRA: `requiresRole: manager` +
  // `apenasHumano` no catálogo já a tiram do alcance do agente publicado (ver
  // tests/unit/capacidade-alcancavel-pelo-agente.test.ts), então o escopo de
  // funil nunca chega a ser perguntado para ela.
  crm_start_conversation_and_send: "sem_funil",
  crm_add_case_note: "sem_funil",
  crm_close_human_case: "sem_funil",
  crm_assign_conversation: "sem_funil",
  crm_resume_ai_attendance: "sem_funil",
  crm_save_org_memory: "sem_funil",
  crm_propose_contact_field: "sem_funil",
  // Configuração da casa. Já não é alcançável pelo agente (papel acima do dele);
  // entram aqui para o teste de vacuidade não as acusar, e com a nota de que a
  // barreira delas é OUTRA.
  crm_create_stage: "sem_funil",
  crm_update_stage: "sem_funil",
  crm_archive_stage: "sem_funil",
  crm_create_webhook_source: "sem_funil",
  crm_set_webhook_source_active: "sem_funil",
  crm_set_automation_rule_active: "sem_funil",
};

/**
 * Os TRÊS desfechos de resolver o negócio de um contato — e o terceiro é o que
 * quase passou batido.
 *
 * `resolveActiveLeadForContact` (lib/leads/active-lead.ts) já distingue os três, e
 * o cabeçalho dele diz por que não adivinha no ambíguo: *"mover o card errado do
 * cliente errado é o único bug desta entrega visível para o cliente final"*.
 */
export type ResolucaoDeContato =
  | { tipo: "lead"; leadId: string }
  /** Contato sem negócio aberto — o paciente novo, que é o caso mais comum. */
  | { tipo: "sem_lead" }
  /** Mais de um negócio aberto: não dá para dizer em qual funil isto conta. */
  | { tipo: "ambiguo"; quantos: number };

export type VereditoDoEscopo =
  | { permitido: true }
  /** O funil existe e não está marcado: restrição DELIBERADA de quem configurou. */
  | { permitido: false; motivo: "funil_fora_do_escopo"; pipelineId: string }
  /** Nenhum funil marcado: acidente de CONFIGURAÇÃO, não decisão sobre este card. */
  | { permitido: false; motivo: "escopo_vazio" }
  /** Escrita nova que ninguém classificou. Recusa por vacuidade. */
  | { permitido: false; motivo: "ferramenta_nao_classificada"; ferramenta: string }
  /** Não deu para descobrir o funil. **Não é recusa de escopo** — ver abaixo. */
  | { permitido: false; motivo: "indisponivel"; detalhe?: string };

/**
 * A pergunta central.
 *
 * ⚠️ `escopo` vazio devolve `escopo_vazio`, e não `funil_fora_do_escopo`. Os dois
 * negam a ação, e é aí que a semelhança acaba: o primeiro é "ninguém configurou
 * este agente" (quem resolve é quem cuida do sistema) e o segundo é "este card
 * não é seu" (a configuração está certa e funcionou). Colapsar os dois faria o
 * agente novo receber uma explicação que não ajuda ninguém.
 */
export function podeOperarNoFunil(
  escopo: readonly string[] | null | undefined,
  pipelineId: string | null | undefined,
): VereditoDoEscopo {
  const marcados = escopo ?? ESCOPO_VAZIO;
  if (marcados.length === 0) return { permitido: false, motivo: "escopo_vazio" };
  if (!pipelineId) {
    // Sem saber o funil não há como autorizar — mas isto é falta de INFORMAÇÃO,
    // não veredito sobre o card. Ver `indisponivel` abaixo.
    return { permitido: false, motivo: "indisponivel", detalhe: "funil do alvo não resolvido" };
  }
  return marcados.includes(pipelineId)
    ? { permitido: true }
    : { permitido: false, motivo: "funil_fora_do_escopo", pipelineId };
}

/**
 * O veredito para uma CHAMADA de ferramenta.
 *
 * `resolvePipelineDoLead` é injetado para esta função continuar pura: quem sabe
 * consultar o banco é o chamador, e o teste não precisa de banco para exercitar
 * a decisão.
 *
 * ⚠️ **ERRO DE CONSULTA NUNCA VIRA "fora do escopo".** Se a resolução do funil
 * falhar (rede, timeout, lead apagado no meio), o veredito é `indisponivel` — e
 * quem chama re-tenta. Traduzir falha de infraestrutura em recusa de permissão
 * ensinaria ao modelo que o card não é dele, e ele pararia de tentar para
 * sempre por causa de um erro passageiro.
 */
export async function podeChamarFerramenta(entrada: {
  ferramenta: string;
  argumentos: Record<string, unknown>;
  escopo: readonly string[] | null | undefined;
  ehEscrita: boolean;
  resolvePipelineDoLead: (leadId: string) => Promise<string | null>;
  /**
   * Só é chamado por `funil_vem_do_contato`. Opcional para não obrigar os
   * chamadores que não têm ferramenta desse alvo a inventar uma implementação —
   * e a ausência é tratada como `indisponivel`, nunca como liberação.
   */
  resolveLeadDoContato?: (contactId: string) => Promise<ResolucaoDeContato>;
}): Promise<VereditoDoEscopo> {
  // Leitura não é escopada por funil — decisão declarada na spec 17 §5, com a
  // consequência escrita: a superfície de DESCOBERTA continua aberta (o modelo
  // vê os funis e os negócios da organização). Filtrar leitura é trabalho de
  // outro dia, atrás de medição do que isso quebra no contexto do turno.
  if (!entrada.ehEscrita) return { permitido: true };

  const alvo = ALVO_DE_FUNIL[entrada.ferramenta];
  if (alvo === undefined) {
    // VACUIDADE: escrita que ninguém classificou é recusada. O contrário —
    // liberar o desconhecido — faria toda ferramenta nova nascer fora do gate,
    // que é exatamente como um escopo morre em silêncio.
    return {
      permitido: false,
      motivo: "ferramenta_nao_classificada",
      ferramenta: entrada.ferramenta,
    };
  }

  // ⚠️ SWITCH EXAUSTIVO, E O `never` NO DEFAULT É O PONTO DESTE BLOCO.
  //
  // Antes isto era uma cadeia de `if`s com o último ramo IMPLÍCITO
  // (`funil_vem_do_lead` sem `case`). Um valor novo em `AlvoDeFunil` — e a
  // entrega da agenda acrescenta dois — caía nesse ramo, procurava um
  // `lead_id` que aquela ferramenta nem tem, não achava, e LIBERAVA. Escopo
  // que morre em silêncio é o modo de falha que este arquivo inteiro existe
  // para impedir, e ele estava aberto na porta de trás.
  //
  // Agora quem acrescenta valor ao tipo sem tratar aqui é reprovado pelo
  // COMPILADOR, não por teste: `const naoTratado: never = alvo` só compila
  // enquanto todos os casos estiverem cobertos. É impossível de esquecer, que
  // é a diferença entre guarda e lembrete.
  switch (alvo) {
    case "sem_funil":
      return { permitido: true };

    case "pipeline_no_argumento": {
      const p = entrada.argumentos.pipeline_id;
      return podeOperarNoFunil(entrada.escopo, typeof p === "string" ? p : null);
    }

    case "alvo_polimorfico": {
      // `crm_manage_tags` marca conversa, contato OU lead. Só o terceiro tem funil.
      if (entrada.argumentos.target_kind !== "lead") return { permitido: true };
      const id = entrada.argumentos.target_id;
      if (typeof id !== "string") {
        return { permitido: false, motivo: "indisponivel", detalhe: "target_id ausente" };
      }
      return resolverPeloLead(entrada, id);
    }

    case "funil_vem_do_lead": {
      const leadId = entrada.argumentos.lead_id;
      if (typeof leadId !== "string") {
        // A ferramenta aceita alvo por contato (é o caso do follow-up). Sem lead
        // não há funil a checar — e recusar aqui bloquearia um caminho legítimo.
        // A consequência está medida em `tests/unit/escopo-de-funil.test.ts`:
        // com `lead_id` opcional, o escopo vira opcional na prática.
        return { permitido: true };
      }
      return resolverPeloLead(entrada, leadId);
    }

    case "funil_vem_do_contato": {
      const contactId = entrada.argumentos.contact_id;
      if (typeof contactId !== "string") {
        return { permitido: false, motivo: "indisponivel", detalhe: "contact_id ausente" };
      }
      if (!entrada.resolveLeadDoContato) {
        // Falha FECHADA: chamador sem o resolvedor não vira liberação. Um alvo que
        // depende de uma dependência opcional precisa recusar quando ela falta,
        // senão basta esquecer de passá-la para o escopo sumir.
        return { permitido: false, motivo: "indisponivel", detalhe: "resolvedor de contato ausente" };
      }

      let r: ResolucaoDeContato;
      try {
        r = await entrada.resolveLeadDoContato(contactId);
      } catch (e) {
        return {
          permitido: false,
          motivo: "indisponivel",
          detalhe: e instanceof Error ? e.message.slice(0, 120) : "falha ao resolver o contato",
        };
      }

      // ── SEM LEAD: LIBERA, e é decisão, não fall-through ──────────────────────
      // O escopo de funil responde "este agente pode operar NESTE funil?". Contato
      // sem negócio aberto não está em funil nenhum, e marcar consulta não move
      // card: não há escopo a ferir porque não há funil envolvido. Recusar aqui
      // mudaria a PERGUNTA do gate — de escopo para triagem.
      //
      // E o custo de errar cai no caso mais comum de uma clínica: contato sem lead
      // É O PACIENTE NOVO. Recusar faria a IA não marcar justamente para quem está
      // chegando, e o dono não teria como ligar isso à configuração de funil.
      if (r.tipo === "sem_lead") return { permitido: true };

      // ── AMBÍGUO: RECUSA, e o motivo ensina ───────────────────────────────────
      // Mais de um negócio aberto: não dá para dizer em qual funil o compromisso
      // conta, e um deles pode estar fora do escopo. O precedente do repo é não
      // adivinhar — `resolveActiveLeadForContact` devolve `ambiguous_open_leads`
      // em vez de escolher o primeiro, pela razão escrita no cabeçalho dele.
      // Aqui fechar na dúvida é barato: o modelo pergunta qual negócio é.
      if (r.tipo === "ambiguo") {
        return {
          permitido: false,
          motivo: "indisponivel",
          detalhe: `contato com ${r.quantos} negócios abertos: confirme qual antes de marcar`,
        };
      }

      return resolverPeloLead(entrada, r.leadId);
    }

    default: {
      // O compilador já garantiu que isto é inalcançável em TypeScript. O ramo
      // existe para o RUNTIME: `ALVO_DE_FUNIL` é um Record indexado por string,
      // e um valor escrito à mão (ou vindo de JS puro) chega aqui. Falha
      // FECHADA, pela mesma razão da vacuidade acima — liberar o desconhecido
      // é como o escopo morre.
      const naoTratado: never = alvo;
      return {
        permitido: false,
        motivo: "ferramenta_nao_classificada",
        ferramenta: `${entrada.ferramenta} (alvo não tratado: ${String(naoTratado)})`,
      };
    }
  }
}

async function resolverPeloLead(
  entrada: {
    escopo: readonly string[] | null | undefined;
    resolvePipelineDoLead: (leadId: string) => Promise<string | null>;
  },
  leadId: string,
): Promise<VereditoDoEscopo> {
  let pipelineId: string | null;
  try {
    pipelineId = await entrada.resolvePipelineDoLead(leadId);
  } catch (e) {
    return {
      permitido: false,
      motivo: "indisponivel",
      detalhe: e instanceof Error ? e.message.slice(0, 120) : "falha ao resolver o funil",
    };
  }
  // `null` aqui é "o lead não existe (ou não é desta organização)". Não é
  // veredito de escopo: quem responde isso é o handler, com 404.
  if (pipelineId === null) {
    return { permitido: false, motivo: "indisponivel", detalhe: "lead não encontrado" };
  }
  return podeOperarNoFunil(entrada.escopo, pipelineId);
}

/**
 * O que o MODELO lê quando é recusado.
 *
 * Duas frases diferentes para dois problemas diferentes — no molde do que o
 * repositório já faz em `recusa-para-o-modelo.ts`. O modelo age em cima disto:
 * dizer "não é seu" quando o problema é falta de configuração o faria desistir
 * de um caminho que funcionaria assim que alguém marcasse o funil.
 */
export function recusaParaOModelo(v: VereditoDoEscopo): string | null {
  if (v.permitido) return null;
  switch (v.motivo) {
    case "escopo_vazio":
      return (
        "este assistente ainda não tem nenhum funil liberado para mexer em negócios. " +
        "Não tente por outro caminho — quem cuida do sistema precisa liberar isso na configuração."
      );
    case "funil_fora_do_escopo":
      return (
        "este negócio está num funil que não é da sua alçada. Você pode conversar sobre ele, " +
        "mas não alterar o cartão. Não tente por outra ferramenta."
      );
    case "ferramenta_nao_classificada":
      return "esta capacidade ainda não foi liberada para uso com negócios.";
    case "indisponivel":
      return "não consegui confirmar a qual funil este negócio pertence agora. Tente de novo em instantes.";
  }
}
