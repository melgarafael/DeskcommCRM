/**
 * QUANDO O AVISO DE CASO **NÃO** VAI DISPARAR — a regra, pura.
 *
 * ## Por que esta regra é um módulo e não um punhado de `if` na tela
 *
 * O aviso de caso falha de um jeito MUDO. A pessoa escolhe um número, liga o
 * switch, a tela fica verde — e nenhuma mensagem chega, porque a conexão
 * escolhida é um canal oficial (só manda modelo aprovado), ou porque nenhum
 * agente publicado tem "abrir casos" ligado, ou porque esta instalação ainda
 * está com `NEXT_PUBLIC_APP_URL` no padrão e o link do aviso não abriria nada.
 * Cada um desses é invisível de dentro da tela de configuração.
 *
 * O invariante 6 do Sistema Vivo — *"a configuração mostra o estado EFETIVO,
 * não só o que foi digitado"* — só vira mecanismo se a regra puder ser medida
 * sem React, sem banco e sem rota. É esse o motivo deste arquivo existir
 * separado do componente.
 *
 * ## A divisão: CÓDIGO aqui, FRASE na tela
 *
 * Este módulo devolve códigos; quem os traduz em português (e espanhol) é o
 * componente, por `t()`. Duas razões: `tests/unit/i18n-espanhol-cobre-a-tela`
 * só varre `app/` e `components/` — prosa de tela escrita aqui escaparia do
 * gate de tradução —, e o mesmo código precisa servir a mais de uma superfície
 * sem carregar a redação de uma delas.
 *
 * ## O que é BLOQUEIO e o que é ALERTA
 *
 * `bloqueia: true` trava o switch: são os estados em que ligar produziria uma
 * configuração que não pode funcionar. `bloqueia: false` é informação — a
 * decisão continua de quem opera. A conexão que atende clientes é o caso
 * exemplar: **decisão do dono do produto** (DEC-006 #5, opção A) é PERMITIR,
 * com alerta. Transformar esse alerta em bloqueio seria decidir por cima de uma
 * decisão registrada.
 *
 * ## `null` NÃO é `false`
 *
 * `agentesPublicados: null` significa *não deu para medir*, e nesse caso nenhum
 * alerta nasce. Um "nenhum agente abre casos" afirmado a partir de uma consulta
 * que falhou manda a pessoa mexer numa configuração que já estava certa —
 * falhar ABERTO na informação, que é a regra deste repositório para tudo que a
 * tela AFIRMA.
 */

/**
 * Os onze estados. Tupla e não união solta: `satisfies` e varredura precisam de
 * um valor em runtime, e um código novo sem frase para de compilar na tela.
 */
export const CODIGOS_DO_ESTADO_DO_AVISO = [
  "sem_conexao",
  "so_canal_oficial",
  "sem_endereco_publico",
  "conexao_removida",
  "conexao_fora_do_ar",
  "conexao_atende_clientes",
  "casos_desligados",
  "agente_assistido",
  "atendimento_externo",
  "aquecimento",
  "descarte_acontecendo",
] as const;
export type CodigoDoEstadoDoAviso = (typeof CODIGOS_DO_ESTADO_DO_AVISO)[number];

/**
 * A MESMA forma do CHECK `config_aviso_de_caso_e164` (migration 0292).
 *
 * Copiada de propósito, e a cópia está declarada: o CHECK mora no banco e o
 * campo mora no navegador. Sem a validação daqui, o erro só apareceria depois
 * de a pessoa preencher a tela inteira e apertar salvar, como
 * `aviso_de_caso_telefone_invalido` — um código cru vindo do Postgres.
 */
const E164 = /^\+[1-9][0-9]{7,14}$/;

/** Quantos dias de recência fazem o descarte valer uma frase na tela. */
export const JANELA_DO_DESCARTE_DIAS = 7;

/** Uma conexão oferecível, já com as duas perguntas que a tela precisa fazer. */
export interface ConexaoParaAviso {
  id: string;
  nome: string;
  /** `channel_sessions.status` — `WORKING` é o único que envia agora. */
  status: string;
  /**
   * CAPACIDADE, nunca provedor: quem resolve é `lib/channels/selectable.ts`.
   * `pnpm lint:channels` reprova nome de provedor fora de `lib/channels/`.
   */
  aceitaMensagemLivre: boolean;
  /** Alguma versão publicada de agente ou roteador fala com cliente por este número. */
  atendeClientes: boolean;
}

/** A configuração como ela está no banco, projetada para a tela. */
export interface ConfiguracaoNaTela {
  /** `null` depois de a conexão ser excluída (`on delete set null` + trigger). */
  channelSessionId: string | null;
  telefone: string;
  rotulo: string | null;
  ligado: boolean;
  sem_link?: boolean;
}

/** O que o `pacing_ledger` responde sobre o número que ENVIA os avisos. */
export interface AquecimentoDoNumero {
  enviadosHoje: number;
  /** `null` = número fora do aquecimento, sem teto diário. */
  teto: number | null;
  /** ISO do fim do aquecimento; `null` = não dá para dizer quando termina. */
  fimEm: string | null;
}

/** Quantos agentes publicados existem, e quantos deles fazem o quê. */
export interface AgentesPublicados {
  total: number;
  /** Com `cases_enabled = true` na versão publicada. */
  comCasos: number;
  /** Com `operation_mode = 'assisted'`. */
  assistidos: number;
}

/** Tudo o que a regra precisa saber. Nada aqui é lido: é entregue pronto. */
export interface FatosDaTelaDeAviso {
  conexoes: ConexaoParaAviso[];
  config: ConfiguracaoNaTela | null;
  /** `urlPublicaUsavel(env.NEXT_PUBLIC_APP_URL)`, já avaliado no servidor. */
  urlPublicaOk: boolean;
  /** `null` = a consulta não respondeu. Ver o cabeçalho. */
  agentesPublicados: AgentesPublicados | null;
  /** `organizations.settings.ai_dispatch_mode === 'external'`. */
  atendimentoExterno: boolean;
  /** Os contadores do corte da ingestão (onda 6). */
  descarte: { ignoradas: number; ultimaEm: string | null };
  /** `null` = não há conexão escolhida, ou não deu para ler o ledger. */
  aquecimento: AquecimentoDoNumero | null;
  agora: Date;
}

export interface AvisoDaTela {
  codigo: CodigoDoEstadoDoAviso;
  /** `true` ⇒ o switch fica travado. Ver "O que é BLOQUEIO e o que é ALERTA". */
  bloqueia: boolean;
  /** Os números que entram na frase. Nunca texto — a frase é da tela. */
  dados?: Record<string, string | number>;
}

/** `true` quando este texto passaria pelo CHECK do banco. */
export function telefoneDeAvisoValido(bruto: string | null | undefined): boolean {
  return typeof bruto === "string" && E164.test(bruto.trim());
}

/**
 * O que a pessoa digitou, na forma que o banco aceita.
 *
 * ⚠️ NÃO há máscara por país, e é decisão. Agrupar `+55 31 99896-6398` exige
 * saber o plano de numeração de cada DDI; inventá-lo produz um campo que
 * reformata errado o número de quem está fora do Brasil — e este produto é
 * distribuído. A máscara aqui é a única que vale em todo lugar: `+` na frente,
 * dígitos atrás. A tela mostra um exemplo ao lado do campo.
 *
 * Campo vazio devolve vazio, e não `+`: um `+` sozinho reprovaria na validação
 * e diria à pessoa que ela digitou algo errado quando ela não digitou nada.
 */
export function normalizarTelefoneDeAviso(bruto: string): string {
  const digitos = bruto.replace(/\D/g, "");
  return digitos === "" ? "" : `+${digitos}`;
}

/** A conexão escolhida, quando ela ainda existe na lista. */
function conexaoEscolhida(f: FatosDaTelaDeAviso): ConexaoParaAviso | null {
  const id = f.config?.channelSessionId;
  if (!id) return null;
  return f.conexoes.find((c) => c.id === id) ?? null;
}

/**
 * As três condições do switch: uma conexão que MANDA o aviso, um número que o
 * RECEBE e, quando não está no modo sem link, um endereço público para abrir.
 *
 * Elas são as mesmas três que o motor checa nos passos 8, 9 e 12 — travar aqui
 * é o que evita uma configuração que nasce ligada e nunca entrega.
 */
export function podeLigarOAviso(f: FatosDaTelaDeAviso): boolean {
  if (!f.urlPublicaOk && !f.config?.sem_link) return false;
  if (!telefoneDeAvisoValido(f.config?.telefone)) return false;
  const canal = conexaoEscolhida(f);
  return canal !== null && canal.aceitaMensagemLivre;
}

/**
 * Os estados em vigor, do que trava para o que só informa.
 *
 * A ordem é contrato (há um caso de teste sobre ela): quem abre a tela com um
 * bloqueio e um informativo precisa ler primeiro o que a impede de seguir. Um
 * "3 mensagens foram ignoradas" acima de "você não tem nenhuma conexão" é a
 * mesma tela dizendo a coisa menos útil primeiro.
 */
export function avisosDaTela(f: FatosDaTelaDeAviso): AvisoDaTela[] {
  const bloqueios: AvisoDaTela[] = [];
  const alertas: AvisoDaTela[] = [];

  const temAlgumaLivre = f.conexoes.some((c) => c.aceitaMensagemLivre);

  // ── Bloqueios ────────────────────────────────────────────────────────────
  if (f.conexoes.length === 0) {
    bloqueios.push({ codigo: "sem_conexao", bloqueia: true });
  } else if (!temAlgumaLivre) {
    // Há número conectado — ele é que não serve. Dizer "você não tem conexão"
    // aqui mandaria a pessoa parear de novo um número que já está no ar.
    bloqueios.push({ codigo: "so_canal_oficial", bloqueia: true });
  }

  if (!f.urlPublicaOk) {
    bloqueios.push({ codigo: "sem_endereco_publico", bloqueia: !f.config?.sem_link });
  }

  // A conexão escolhida sumiu — e ela some de DOIS jeitos, não de um:
  //
  //   1. excluída de vez: o `on delete set null` anulou a coluna e o trigger
  //      `trg_aviso_de_caso_coerente` desligou o aviso sozinho;
  //   2. ARQUIVADA: a coluna continua apontando para a linha, mas
  //      `listSelectableChannels` já não a oferece (ela filtra `archived_at`).
  //
  // Tratar só o primeiro deixava o segundo mudo: o switch travava, o seletor
  // aparecia vazio e nada na tela dizia por quê. Para quem opera, os dois casos
  // são a mesma frase — "a conexão que enviava os avisos não existe mais".
  if (f.config && (f.config.channelSessionId === null || conexaoEscolhida(f) === null)) {
    bloqueios.push({ codigo: "conexao_removida", bloqueia: true });
  }

  // ── Alertas ──────────────────────────────────────────────────────────────
  const canal = conexaoEscolhida(f);
  if (canal && canal.status !== "WORKING") {
    // Alerta e NÃO bloqueio: a entrega fica `pendente` e o motor reenvia por até
    // 24 h. Travar o switch aqui apagaria a configuração de quem está só
    // reconectando o número.
    alertas.push({ codigo: "conexao_fora_do_ar", bloqueia: false, dados: { conexao: canal.nome } });
  }
  if (canal?.atendeClientes) {
    alertas.push({
      codigo: "conexao_atende_clientes",
      bloqueia: false,
      dados: { conexao: canal.nome },
    });
  }

  const agentes = f.agentesPublicados;
  if (agentes) {
    // Zero agente publicado e zero agente com casos dizem a MESMA coisa a quem
    // opera: ninguém está autorizado a abrir caso, então nenhum aviso vai sair.
    if (agentes.comCasos === 0) {
      alertas.push({ codigo: "casos_desligados", bloqueia: false });
    } else if (agentes.total > 0 && agentes.assistidos === agentes.total) {
      // TODOS assistidos. Um assistido entre dois não alerta: o outro abre caso,
      // e o alerta seria falso — e alerta falso treina a ignorar o verdadeiro.
      alertas.push({ codigo: "agente_assistido", bloqueia: false });
    }
  }

  if (f.atendimentoExterno) {
    alertas.push({ codigo: "atendimento_externo", bloqueia: false });
  }

  // ── Informativos ─────────────────────────────────────────────────────────
  if (f.aquecimento && f.aquecimento.teto !== null) {
    alertas.push({
      codigo: "aquecimento",
      bloqueia: false,
      dados: {
        enviadosHoje: f.aquecimento.enviadosHoje,
        teto: f.aquecimento.teto,
        ...(f.aquecimento.fimEm ? { fimEm: f.aquecimento.fimEm } : {}),
      },
    });
  }

  // ⚠️ `mensagens_ignoradas` é um contador ACUMULADO desde que o número foi
  // configurado — não uma janela. Por isso a condição é a RECÊNCIA da última
  // (`ultima_mensagem_ignorada_em`), e a frase da tela diz o total e a data,
  // nunca "N nos últimos 7 dias": esse número não existe em lugar nenhum, e
  // escrevê-lo seria pôr na tela um dado que o banco não guarda.
  if (f.descarte.ignoradas > 0 && f.descarte.ultimaEm) {
    const quando = Date.parse(f.descarte.ultimaEm);
    const limite = f.agora.getTime() - JANELA_DO_DESCARTE_DIAS * 24 * 60 * 60 * 1000;
    if (Number.isFinite(quando) && quando >= limite) {
      alertas.push({
        codigo: "descarte_acontecendo",
        bloqueia: false,
        dados: { ignoradas: f.descarte.ignoradas, ultimaEm: f.descarte.ultimaEm },
      });
    }
  }

  return [...bloqueios, ...alertas];
}
