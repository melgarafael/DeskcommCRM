/**
 * O FILTRO DE SPAM/GOLPE DA ENTRADA (#4026) — classificação POR MENSAGEM.
 *
 * Devolve um veredito com confiança (0 a 1) e os sinais que o produziram. Acima
 * do limiar da organização, a mensagem vai para a QUARENTENA: continua gravada
 * em `messages`, mas não abre demanda, não acorda a IA, não dispara ligação,
 * notificação nem automação, até uma pessoa liberar.
 *
 * ─── Isto é um CLASSIFICADOR DE REGRAS, e o PR diz isso ─────────────────────
 *
 * Nenhum modelo foi treinado nem calibrado com mensagens de produção: o que
 * existe aqui são sinais léxicos que aparecem nas ondas de golpe medidas pela
 * operação (prêmio que ninguém pediu, link encurtado, falso suporte pedindo
 * Pix). O limiar é PROVISÓRIO e está declarado. O que a issue exige — "o pior
 * caso é quarentena, jamais perda" — NÃO depende da qualidade do classificador:
 * depende de a mensagem nunca ser apagada e de a quarentena ser liberável. Um
 * falso positivo custa alguns minutos de atraso; um falso negativo é o que é
 * hoje.
 *
 * ─── Por que o veredito é "sim/não" com confiança, e não uma classe ─────────
 *
 * Porque a única decisão a jusante é binária ("retém ou não") e o número serve
 * para auditar o corte: quem olhar a fila vê `0.85` e os sinais, e pode dizer
 * "esse aqui o filtro errou". Uma categoria ("golpe do Pix") convidaria a
 * automatizar tratamento diferente por categoria — e não há tratamento
 * diferente: tudo que é retido é retido do mesmo jeito.
 */

/** Limiar de fábrica. Acima dele, quarentena. */
export const LIMIAR_PADRAO = 0.65;

/** Piso e teto aceitos de configuração: abaixo do piso o filtro vira ruído. */
export const LIMIAR_MINIMO = 0.3;
export const LIMIAR_MAXIMO = 0.95;

export interface OpcaoDoFiltroDeSpam {
  ligado: boolean;
  limiar: number;
}

export interface VereditoDaEntrada {
  /**
   * `true` = pelo menos um sinal casou. Quem decide reter é `vaiParaQuarentena`,
   * que compara a `confianca` com o limiar DA ORGANIZAÇÃO — um veredito
   * "suspeito" com confiança 0.2 não retém nada no limiar padrão.
   */
  suspeito: boolean;
  confianca: number;
  /** Os sinais que somaram, do mais pesado ao mais leve. Vai para a fila. */
  sinais: string[];
}

interface Sinal {
  nome: string;
  peso: number;
  casar: RegExp;
}

/**
 * Os sinais, com o peso de cada um. `peso` é quanto ele soma na confiança; a
 * soma é limitada a 1.
 *
 * Os pesos foram escolhidos para que UM sinal forte (link encurtado, falso
 * suporte) sozinho já passe do limiar padrão, e dois médios também — enquanto
 * um único sinal fraco (maiúsculas, exclamação) nunca retenha nada.
 */
const SINAIS: readonly Sinal[] = [
  {
    nome: "link_encurtado",
    peso: 0.5,
    casar: /\b(?:bit\.ly|tinyurl\.com|t\.co|is\.gd|cutt\.ly|encurtador|linktr\.ee|shorturl)\b/i,
  },
  {
    // "Sou do suporte do banco" sozinho já é 0.55: quem é do suporte não
    // apresenta credencial por mensagem fria. A ameaça de bloqueio é um sinal
    // SEPARADO (abaixo) porque ela reaparece sozinha em golpe sem apresentação.
    nome: "falso_suporte",
    peso: 0.55,
    casar: /\b(?:sou do (?:suporte|banco|setor de segurança)|central de segurança)\b/i,
  },
  {
    nome: "ameaca_de_bloqueio",
    peso: 0.3,
    casar:
      /\b(?:sua conta (?:será|vai ser) (?:bloqueada|suspensa)|regularize (?:seu|o) cadastro|evite o bloqueio)\b/i,
  },
  {
    nome: "premio_nao_pedido",
    peso: 0.4,
    casar:
      /\b(?:você (?:foi|é o) (?:sorteado|ganhador)|parabéns.{0,20}(?:ganhou|sorteio|prêmio|premio)|resgate (?:seu|o) (?:prêmio|premio|bônus|bonus)|brinde grátis)\b/i,
  },
  {
    nome: "pedido_de_pix",
    peso: 0.35,
    casar:
      /\b(?:faça (?:um )?pix|mande (?:um )?pix|pix (?:agora|urgente)|transferência (?:urgente|imediata)|pague (?:a )?taxa)\b/i,
  },
  {
    nome: "click_aqui",
    peso: 0.25,
    casar: /\b(?:clique (?:aqui|no link)|acesse (?:o|este) link|baixe (?:o )?app|instale (?:o )?aplicativo)\b/i,
  },
  {
    nome: "promessa_de_dinheiro",
    peso: 0.3,
    casar:
      /\b(?:ganhe|receba|lucre)\s+r?\$?\s?\d|renda extra (?:garantida|fácil)|dinheiro (?:fácil|garantido)\b/i,
  },
  {
    nome: "numero_estrangeiro_no_texto",
    peso: 0.2,
    casar: /(?:\+\d{1,3}[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}\b(?!.*\b(?:pedido|nota|os|orcamento|orçamento)\b)/,
  },
  {
    nome: "grito",
    peso: 0.12,
    casar: /[A-ZÁÉÍÓÚÂÊÔÃÕÇ]{12,}/,
  },
];

/** Teto de sinais que entram no `jsonb` da quarentena (fila legível, não log). */
const TETO_DE_SINAIS = 6;

/**
 * A leitura da opção em `organizations.settings.filtro_de_spam`.
 *
 * DESLIGADO DE FÁBRICA: nada configurado ⇒ `ligado: false`. Um limiar fora da
 * faixa é IGNORADO (cai no padrão) em vez de grampeado: um `0` gravado por
 * engano não pode transformar toda mensagem em quarentena, e um `1` não pode
 * transformar o filtro em decoração — nos dois casos o número mentiria sobre o
 * que está acontecendo.
 */
export function lerOpcaoDoFiltroDeSpam(settings: unknown): OpcaoDoFiltroDeSpam {
  const raiz = (settings ?? {}) as Record<string, unknown>;
  const bloco = (raiz.filtro_de_spam ?? null) as Record<string, unknown> | null;
  const limiar = Number(bloco?.limiar);
  return {
    ligado: bloco?.ligado === true,
    limiar:
      Number.isFinite(limiar) && limiar >= LIMIAR_MINIMO && limiar <= LIMIAR_MAXIMO
        ? limiar
        : LIMIAR_PADRAO,
  };
}

/**
 * Classifica UMA mensagem. Puro: mesma entrada, mesma saída, sem banco e sem
 * relógio — o teste do limiar não pode depender de rede.
 *
 * Texto vazio (mídia sem legenda, reação) nunca é suspeito: não há o que ler, e
 * reter uma figurinha por precaução seria reter mensagem legítima em massa.
 */
export function classificarEntrada(texto: string | null | undefined): VereditoDaEntrada {
  const conteudo = (texto ?? "").trim();
  if (conteudo.length < 4) return { suspeito: false, confianca: 0, sinais: [] };

  const achados = SINAIS.filter((sinal) => sinal.casar.test(conteudo)).sort(
    (a, b) => b.peso - a.peso,
  );
  if (achados.length === 0) return { suspeito: false, confianca: 0, sinais: [] };

  const soma = achados.reduce((total, sinal) => total + sinal.peso, 0);
  const confianca = Math.min(1, Math.round(soma * 1000) / 1000);
  return {
    suspeito: true,
    confianca,
    sinais: achados.slice(0, TETO_DE_SINAIS).map((sinal) => sinal.nome),
  };
}

/**
 * A decisão final: a mensagem vai para a quarentena?
 *
 * Precisa das DUAS coisas: a organização ligou o filtro E a confiança alcançou
 * o limiar dela. Desligado, a resposta é sempre "não" — inclusive para uma
 * mensagem com confiança 1, que é o que "desligado por padrão" significa.
 */
export function vaiParaQuarentena(
  veredito: VereditoDaEntrada,
  opcao: OpcaoDoFiltroDeSpam,
): boolean {
  return opcao.ligado === true && veredito.suspeito && veredito.confianca >= opcao.limiar;
}
