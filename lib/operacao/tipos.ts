/**
 * O FORMATO da Operação do dia — o mesmo que a tela desenha e o relatório
 * diário guarda em `relatorios_operacao_diarios.conteudo`.
 *
 * ─── O que é FATO e o que é DADO PESSOAL ────────────────────────────────────
 *
 * Os campos marcados "pessoal" (nome, telefone, @, prévia de mensagem, resumo,
 * título de tarefa ou de negócio, motivo escrito, mensagem de erro, nome de
 * quem atende) só existem na leitura AO VIVO. O relatório guardado passa por
 * `congelar` (`conteudo.ts`), que tira essas chaves: a cascata de anonimização
 * da LGPD não alcança um jsonb guardado, então ele não pode ter o que ela
 * precisaria apagar. A tela do relatório os resolve de novo, na hora, pela RLS
 * da sessão (`hidratar`) — e um contato anonimizado aparece anonimizado.
 *
 * `versao` existe porque o relatório é guardado: campo novo entra OPCIONAL;
 * mudar o sentido de um campo existente é `versao: 2`.
 *
 * Arquivo sem import de propósito: é lido pelo componente cliente.
 */

export interface ContatoDaLinha {
  contact_id: string | null;
  /** Pessoal. Nome de gente (`name` → `display_name`); `null` = não registrado. */
  nome?: string | null;
  /** Pessoal. `contacts.phone_number`; `null` em canal sem telefone (Instagram). */
  telefone?: string | null;
  /** Pessoal. `contacts.social_identity` (o @ no Instagram, por exemplo). */
  identidade?: string | null;
}

export interface ProximaAcao {
  /** Pessoal (texto livre da tarefa). */
  titulo?: string | null;
  /** `crm_tasks.due_date`; `null` = tarefa sem prazo. */
  vence_em: string | null;
}

export interface LinhaDeConversa {
  conversation_id: string;
  contato: ContatoDaLinha;
  /** `conversations.channel`: whatsapp | instagram | facebook | telegram. */
  canal: string;
  /** Rótulo do NOSSO número/conta (`channel_sessions.display_name` → telefone). Não é dado do contato. */
  numero: string | null;
  /** Pessoal. Resumo da passagem para a equipe, quando houve; senão a prévia da última mensagem. */
  resumo?: string | null;
  resumo_origem?: "passagem" | "ultima_mensagem" | null;
  /** `conversations.status`. */
  status: string;
  /** `conversations.comando_da_conversa`: humano | automatico | aguardando | encerrada | ninguem. */
  comando: string | null;
  /** Código do motivo da última passagem (`passagens_de_atendimento.motivo_codigo`). */
  motivo_codigo: string | null;
  proxima_acao: ProximaAcao | null;
  /** `conversations.assigned_to_user_id`. */
  responsavel_user_id: string | null;
  /** Pessoal (nome de quem atende): resolvido na leitura. */
  responsavel?: string | null;
  responsavel_tipo: "pessoa" | "ia" | null;
  ultima_atividade_em: string | null;
  /** Desde quando o cliente espera resposta; `null` quando a última palavra é nossa. */
  esperando_desde: string | null;
  tags: string[];
  /**
   * Só nas linhas de produto: o que a busca da IA registrou na conversa naquele
   * dia. `termos` é o que o cliente escreveu — só na leitura ao vivo, nunca no
   * relatório guardado; `encontrados` são nomes do catálogo.
   */
  produtos?: { termos?: string[]; encontrados: string[] };
}

export interface LinhaDeNegocio {
  lead_id: string;
  /** Pessoal (o título do negócio costuma levar o nome do cliente). */
  titulo?: string | null;
  contato: ContatoDaLinha;
  /** Conversa mais recente do contato — o link da linha. `null` = contato sem conversa. */
  conversation_id: string | null;
  etapa: string | null;
  status: string;
  /** `value_cents` só quando registrado; `null` = não registrado (nunca zero inventado). */
  valor_cents: number | null;
  moeda: string | null;
  /** Pessoal (texto livre). */
  motivo_da_perda?: string | null;
  /** `crm_leads.owner_user_id`. */
  responsavel_user_id: string | null;
  /** Pessoal (nome do dono): resolvido na leitura. */
  responsavel?: string | null;
  /** Quando fechou (ganho/perdido) ou quando entrou na etapa atual. */
  quando: string | null;
}

export interface FalhaDeMensagem {
  message_id: string;
  conversation_id: string;
  contato: ContatoDaLinha;
  status: "failed" | "sending";
  codigo: string | null;
  /** Pessoal (a mensagem do provedor pode trazer o número do contato). */
  erro?: string | null;
  quando: string;
}

export interface FalhaDaIa {
  run_id: string;
  conversation_id: string | null;
  contato: ContatoDaLinha;
  codigo: string | null;
  /** Pessoal (pode citar o que o cliente escreveu). */
  erro?: string | null;
  quando: string;
}

export interface CanalForaDoAr {
  channel_session_id: string;
  numero: string | null;
  provedor: string;
  status: string;
  motivo: string | null;
  desde: string | null;
}

export interface AvisoAberto {
  id: string;
  kind: string;
  /** Pessoal (o título de um aviso pode citar o cliente); a tela usa o rótulo do `kind`. */
  titulo?: string | null;
  severidade: string;
  quando: string;
}

export interface ContagemPorCanal {
  whatsapp: number;
  instagram: number;
  outros: number;
  total: number;
}

export interface OperacaoDoDia {
  versao: 1;
  dia: string;
  fuso: string;
  /** Início e fim do dia no fuso, em UTC ISO — `[inicio, fim)`. */
  inicio: string;
  fim: string;
  /** Quando a leitura foi feita. A espera é medida contra este instante. */
  lido_em: string;
  tags: { produto: string; projeto: string; reclamacao: string; urgente: string };
  contadores: {
    /** Conversas cuja PRIMEIRA mensagem recebida (de sempre) caiu neste dia. */
    novas: ContagemPorCanal;
    /** Conversas que receberam pelo menos uma mensagem do cliente neste dia. */
    com_entrada: ContagemPorCanal;
  };
  aguardando: LinhaDeConversa[];
  projetos: LinhaDeConversa[];
  reclamacoes: LinhaDeConversa[];
  produtos: LinhaDeConversa[];
  funil: {
    ganhos: LinhaDeNegocio[];
    perdidos: LinhaDeNegocio[];
    em_proposta: LinhaDeNegocio[];
    /** Negócios que mudaram de etapa neste dia (`crm_leads.stage_changed_at`). */
    mudaram_de_etapa: number | null;
  };
  falhas: {
    mensagens: FalhaDeMensagem[];
    execucoes_da_ia: FalhaDaIa[];
    canais: CanalForaDoAr[];
    avisos: AvisoAberto[];
  };
  /**
   * Leituras AO VIVO que falharam ao hidratar um relatório guardado
   * (`hidratar`): os campos pessoais delas ficam ausentes e a tela diz "não foi
   * possível ler agora", que é diferente de "não registrado".
   */
  leitura_falhou?: Array<"contatos" | "conversas" | "passagens" | "tarefas" | "negocios" | "nomes">;
  /** Seções que bateram no teto de linhas: a lista mostrada não é a inteira. */
  truncado: string[];
}
