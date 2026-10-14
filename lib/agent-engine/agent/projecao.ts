/**
 * A PROJEÇÃO — o que o Conversador pode ver (spec 16 §4).
 *
 * Fecha a TERCEIRA porta de vazamento, a que a doutrina subestimava. As duas
 * primeiras (nome e descrição da ferramenta) se fecham não mostrando a ferramenta.
 * A terceira não: ela é o DADO que a ferramenta devolveu, e foi medida em turno
 * real com LLM —
 *
 *   "As execuções mais recentes deram erro na ação de webhook: `unsafe_url:https_required`"
 *
 * — copiado do resultado direto para a tela do cliente. Na mesma resposta chegaram
 * UUIDs crus de usuários. Um Conversador que não vê ferramenta nenhuma, mas recebe
 * payload cru, continua vazando. Esconder não basta: é preciso PROJETAR.
 *
 * ═══ ALLOWLIST, NUNCA DENYLIST ═══
 *
 * O que não está declarado como projetável não passa. Uma denylist envelhece a cada
 * coluna nova — alguém acrescenta um campo ao contexto e ele chega ao cliente por
 * omissão, que é o modo de falha que este módulo existe para impedir. A allowlist
 * falha fechado: campo novo simplesmente não aparece até alguém decidir que aparece.
 *
 * ═══ A LINHA: identificador do SISTEMA sai, dado da PESSOA fica ═══
 *
 * `lead_id`, `conversation_id`, `media_storage_path` saem — são endereços internos,
 * não têm significado para quem está do outro lado e foi por eles que UUID chegou à
 * tela. Nome, telefone e e-mail FICAM: são dados que a própria pessoa conhece e diz,
 * e removê-los quebraria "confirma seu e-mail?" sem fechar porta nenhuma. Confundir
 * as duas coisas produz um agente que não sabe com quem fala.
 */
import { detectarVazamentoInterno } from '../guardrails/vazamento-interno';
import type { LeadContext } from '../edge/crm/get-lead-context';

/**
 * QUANDO a projeção arma — e a regra se justifica sozinha.
 *
 * As ferramentas do catálogo MCP recebem identificador como ARGUMENTO
 * (`lead_id: z.string().uuid()` e irmãos); as nativas do engine resolvem tudo pelo
 * closure do run, por desenho. Logo: um turno sem ferramenta de catálogo é um turno
 * em que nenhum UUID do contexto tem uso — e um dado sem uso que pode vazar é dado
 * que não devia estar ali.
 *
 * Ligar a projeção incondicionalmente HOJE quebraria o agente que opera: ele
 * perderia o `lead_id` que precisa passar para `crm_move_lead_stage`. Ligá-la por
 * env seria um botão a mais para o self-hoster errar. Esta condição é a única que
 * não tem esse custo — e, quando o Conversador perder as ferramentas de escrita
 * (spec 16, passo 6), ela passa a valer SOZINHA, sem nova linha de código.
 *
 * Enquanto não arma, quem cobre é o gate `internal_vocabulary` na saída. Rede, não
 * cura — exatamente como a doutrina descreve.
 */
export function turnoProjeta(toolNamesDoCatalogo: readonly string[]): boolean {
  return toolNamesDoCatalogo.length === 0;
}

/** Uma mensagem como o Conversador a lê — sem endereço interno de nada. */
export interface MensagemProjetada {
  de: 'cliente' | 'nós';
  texto: string;
  quando: string;
  /** marcador legível quando houve mídia ("[imagem]"); nunca o caminho dela. */
  anexo?: string;
  autoria?: string;
  estado_envio?: string;
}

/** O contexto como o Conversador o lê. Tudo o que não está aqui, ele não vê. */
export interface ContextoProjetado {
  contato: {
    nome: string | null;
    telefone: string | null;
    email: string | null;
    marcadores: string[];
  };
  ultima_decisao_humana: { sobre: string; decisao: 'aprovada' | 'recusada'; quando: string } | null;
  /**
   * N7: `LeadContext.last_proposal` já chegava resolvido, mas a allowlist não o
   * repassava — nenhum turno via o campo, então um agente sem a ferramenta de
   * catálogo oferecia de novo o que o cliente já tinha recusado. `status`
   * traduzido (mesmo padrão de `ultima_decisao_humana`: vocabulário do banco
   * não passa cru).
   */
  ultima_proposta: { numero_e_ano: string | null; status: string; motivo_recusa: string | null } | null;
  mensagens: MensagemProjetada[];
}

const ROTULO_STATUS_PROPOSTA: Record<string, string> = {
  rascunho: 'rascunho, ainda não enviada',
  enviada: 'enviada, aguardando resposta',
  aceita: 'aceita pelo cliente',
  recusada: 'recusada pelo cliente',
  vencida: 'vencida sem resposta',
  substituida: 'substituída por uma versão mais nova',
  cancelada: 'cancelada',
};

/**
 * `is_blocked` NÃO entra, e não é esquecimento: quando ele é `true` o turno sequer
 * chega ao modelo (o gate `stop` barra antes), então o campo só poderia informar o
 * modelo de um estado que nunca acompanha. O CÓDIGO continua lendo o valor do
 * contexto cru — a projeção é o que vai ao prompt, não o que o runtime usa.
 */
export function projetarContexto(ctx: LeadContext): ContextoProjetado {
  return {
    contato: {
      nome: ctx.contact.name,
      telefone: ctx.contact.phone,
      email: ctx.contact.email,
      marcadores: ctx.contact.tags,
    },
    ultima_decisao_humana:
      ctx.last_human_decision === null
        ? null
        : {
            sobre: ctx.last_human_decision.action,
            // 'approved'/'dismissed' são o vocabulário do banco. O que o
            // Conversador precisa saber é se pode ou não retomar aquilo.
            decisao: ctx.last_human_decision.decision === 'approved' ? 'aprovada' : 'recusada',
            quando: ctx.last_human_decision.at,
          },
    ultima_proposta:
      ctx.last_proposal == null
        ? null
        : {
            numero_e_ano:
              ctx.last_proposal.numero != null && ctx.last_proposal.ano != null
                ? `${ctx.last_proposal.numero}/${ctx.last_proposal.ano}`
                : null,
            status: ROTULO_STATUS_PROPOSTA[ctx.last_proposal.status] ?? ctx.last_proposal.status,
            motivo_recusa: ctx.last_proposal.decision_reason,
          },
    mensagens: ctx.messages.map((m) => {
      const base: MensagemProjetada = {
        // 'inbound'/'outbound' é vocabulário de sistema e já apareceu parafraseado
        // em resposta de modelo. Quem fala com uma pessoa pensa "ela disse" / "eu disse".
        de: m.direction === 'inbound' ? 'cliente' : 'nós',
        // O corpo passa INTACTO — e isto é decisão, não omissão. A tradução de
        // erro é calibrada para texto que o SISTEMA produziu; aplicá-la à fala
        // reescreveria o cliente. "Meu site tem um webhook quebrado" é frase
        // legítima de quem vende integração, e viraria "não consegui concluir
        // essa verificação": o agente passaria a responder a uma pergunta que
        // ninguém fez. A fala de quem está do outro lado é o único dado que
        // nunca se corrige — corrigi-la é perder a conversa para proteger a
        // conversa. Nossa própria outbound também passa: ela já foi filtrada
        // pelo gate de saída quando foi enviada.
        texto: m.body,
        quando: m.sent_at,
        ...(m.author ? { autoria: m.author } : {}),
        ...(m.status ? { estado_envio: m.status } : {}),
      };
      // O caminho de storage é endereço interno; o TIPO é informação útil ("ela
      // mandou uma imagem"). Fica o segundo, sai o primeiro.
      return m.type !== undefined && m.type !== null && m.type !== 'text'
        ? { ...base, anexo: `[${m.type}]` }
        : base;
    }),
  };
}

/**
 * Erro cru → consequência que a pessoa entende.
 *
 * O mapa cobre o que foi MEDIDO em turno real; o resto cai no fallback. Não tento
 * enumerar todo erro possível do sistema — uma lista que se pretende completa dá a
 * falsa garantia de que o que não está nela é seguro, quando é o contrário.
 */
const TRADUCAO_DE_ERRO: ReadonlyArray<{ quando: RegExp; vira: string }> = [
  {
    // O vazamento medido, literal (RELATORIO da medição, cenário 7).
    quando: /unsafe_url|https_required/i,
    vira: 'o endereço configurado para essa integração não usa conexão segura',
  },
  {
    quando: /\brole\b.*insufficient|insufficient.*\brole\b|forbidden|not_authorized|unauthorized/i,
    vira: 'essa alteração precisa de uma pessoa com mais permissão do que eu tenho aqui',
  },
  { quando: /not_found|does_not_exist|no_rows/i, vira: 'não encontrei esse registro' },
  { quando: /timeout|timed_out|econnrefused|unavailable/i, vira: 'o sistema não respondeu a tempo' },
  { quando: /rate_limit|too_many_requests/i, vira: 'houve tentativas demais em pouco tempo' },
];

/**
 * Traduz um texto de erro. Se nenhuma regra casa E o texto carrega vocabulário
 * interno, devolve uma frase neutra em vez do texto — **falhar fechado**: um erro
 * desconhecido é exatamente o caso em que não se sabe o que ele revela, e é o pior
 * momento para deixar passar. Texto limpo passa intacto.
 */
export function traduzirErroCru(texto: string): string {
  for (const regra of TRADUCAO_DE_ERRO) {
    if (regra.quando.test(texto)) return regra.vira;
  }
  return detectarVazamentoInterno(texto).achou ? 'não consegui concluir essa verificação' : texto;
}

/**
 * Projeta o RETORNO de uma ferramenta, recursivamente.
 *
 * Chaves cujo nome denuncia identificador (`*_id`, `id`, `*_path`, `*_url`) somem
 * com o valor junto — e a decisão é pela CHAVE, não pelo formato do valor, porque
 * um id pode ser qualquer coisa e um UUID pode aparecer em campo que não se chama
 * id. Toda string sobrevivente passa pela tradução de erro.
 *
 * Só é chamada quando `turnoProjeta` vale — num turno que opera, remover ids
 * quebraria a operação, e é o gate de saída que cobre.
 */
export function projetarRetornoDeTool(valor: unknown, chavePai?: string): unknown {
  // A tradução só alcança texto que é ERRO — e a restrição custou um bug para ser
  // entendida. Aplicá-la a toda string destruiria o `content` da base de
  // conhecimento: o detector considera "webhook" vazamento (com razão, na saída),
  // e a FAQ de qualquer empresa que venda integração fala "webhook". O RAG do
  // tenant viraria "não consegui concluir essa verificação" linha após linha.
  //
  // É a MESMA falha que a de reescrever a fala do cliente, numa irmã que não se
  // parece por fora: as duas nascem de aplicar num texto de terceiros um filtro
  // desenhado para texto do sistema.
  if (typeof valor === 'string') {
    return chavePai !== undefined && chaveDeErro(chavePai) ? traduzirErroCru(valor) : valor;
  }
  if (Array.isArray(valor)) return valor.map((v) => projetarRetornoDeTool(v, chavePai));
  if (valor !== null && typeof valor === 'object') {
    const saida: Record<string, unknown> = {};
    for (const [chave, v] of Object.entries(valor as Record<string, unknown>)) {
      if (chaveDeIdentificador(chave)) continue;
      saida[chave] = projetarRetornoDeTool(v, chave);
    }
    return saida;
  }
  return valor;
}

/**
 * Onde a tradução pode agir. Lista fechada e curta de propósito: cada nome aqui é
 * um campo que o SISTEMA preenche, nunca o tenant. Crescer esta lista é aumentar
 * a superfície em que conteúdo legítimo pode ser reescrito — pense duas vezes.
 */
function chaveDeErro(chave: string): boolean {
  return /^(erro|error|message|mensagem|code|codigo|reason|motivo|detail|detalhe)$/i.test(chave);
}

/**
 * `ok`/`error`/`code` NÃO entram aqui de propósito: são a estrutura pela qual o
 * runtime ensina o modelo a se corrigir, e removê-las cegaria o loop de erro que
 * esta base usa em toda tool. O `code` em si é curto e some pela tradução quando
 * carrega vocabulário interno.
 */
function chaveDeIdentificador(chave: string): boolean {
  return /^id$|_id$|_ids$|_path$|_url$|^uuid$/i.test(chave);
}
