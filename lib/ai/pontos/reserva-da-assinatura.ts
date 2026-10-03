/**
 * A RESERVA DO PROVEDOR POR ASSINATURA — a política da queda, antes do fluxo.
 *
 * A issue #1639 pede um provedor a mais: conversar com a OpenAI pela ASSINATURA
 * do ChatGPT (o mesmo login do Codex), cobrada por janela de uso, com a CHAVE DE
 * API da organização como RESERVA. O caminho por chave não é substituído: ele é
 * o degrau de baixo, e os provedores de hoje seguem byte a byte como estão.
 *
 * Três decisões de produto dessa issue ainda estão ABERTAS — o próprio corpo as
 * lista como perguntas ao mantenedor: como o login do Codex é obtido, guardado e
 * renovado; onde mora o token cifrado (mesma tabela das chaves ou tabela própria);
 * e se o provedor nasce desligado, liberado por variável de ambiente. Nada disso
 * se resolve adivinhando, e nada disso é pré-requisito do que está aqui.
 *
 * Porque a issue é LITERAL em um ponto, e é este: o item 3 — "quando a assinatura
 * devolve limite de uso, token expirado ou erro de autorização, a chamada cai
 * para a chave de API da organização (se existir) e o painel registra a troca.
 * Sem chave de reserva, o agente passa a conversa para um humano em vez de ficar
 * calado". Este módulo é exatamente essa decisão, e só ela.
 *
 * ## Por que a política vem separada do fluxo
 *
 *  - **Ela não depende de nenhuma das três perguntas.** A assinatura pode ser
 *    conectada por OAuth com PKCE ou por código de dispositivo, com o token em
 *    qualquer uma das duas tabelas, ligada ou desligada por ambiente: o que fazer
 *    DEPOIS de uma chamada falhar é o mesmo em todos os desenhos.
 *  - **É onde errar dói.** Uma queda mal classificada não devolve "erro": ela
 *    troca a conta da empresa errada, manda o mesmo corpo recusado para outra
 *    credencial, ou deixa o cliente sem resposta. É o ponto que a issue pede
 *    testado ("testes cobrindo o caminho novo e o fallback"), e é testável sem
 *    rede, sem token e sem banco.
 *
 * ## A queda é assimétrica, de propósito
 *
 * Vai da ASSINATURA para a CHAVE, nunca o contrário: `provedorDeReserva` devolve
 * `null` para todo provedor que não é o da assinatura — inclusive `openai`, que é
 * quem RECEBE a queda. É o que garante por construção, e não por cuidado, que
 * "nada dos provedores nativos muda de comportamento": quem não tem reserva não
 * tem por onde cair.
 *
 * ## O que este módulo NÃO faz
 *
 * Não fala com a OpenAI, não lê nem guarda token, não escolhe modelo, não grava
 * linha de auditoria e não conhece tela. Quem executar a queda é o caminho do
 * agente, e ele entra quando as perguntas abertas da issue forem respondidas —
 * até lá este arquivo é a metade decidida, e não uma configuração que promete o
 * que ainda não existe.
 */

/**
 * O id proposto no corpo da issue ("um provedor novo, `openai-assinatura`, ao
 * lado dos que já existem"). Não é um dos ids nativos e não reaproveita `openai`:
 * a credencial de um não vale para o outro, e a reserva depende de serem dois.
 */
export const PROVEDOR_POR_ASSINATURA = "openai-assinatura";

/**
 * A chave de API da MESMA OpenAI é a reserva (item 3). Poderia ser outro
 * provedor; a issue escolheu este, e a escolha tem consequência prática: quando a
 * queda acontece, o prompt, as ferramentas e o modelo já vinham no formato da
 * OpenAI, então nada precisa ser traduzido no meio do turno.
 */
export const PROVEDOR_DE_RESERVA_DA_ASSINATURA = "openai";

const RESERVA_POR_ASSINATURA: Readonly<Record<string, string>> = {
  [PROVEDOR_POR_ASSINATURA]: PROVEDOR_DE_RESERVA_DA_ASSINATURA,
};

/**
 * Para onde este provedor cai — `null` quando ele não é o provedor por
 * assinatura. Só o id da assinatura tem reserva: os nativos (e o personalizado)
 * devolvem `null` e seguem com o desfecho de sempre.
 */
export function provedorDeReserva(provider: string): string | null {
  return RESERVA_POR_ASSINATURA[provider] ?? null;
}

/**
 * O que aconteceu, na linguagem do produto — não o status cru.
 *
 * São cinco porque os cinco levam a lugares diferentes: os quatro primeiros
 * justificam a queda (a credencial da assinatura é o problema, não a chamada); o
 * quinto diz que o pedido está errado, e nele cair para a outra credencial
 * mandaria o MESMO corpo recusado para a chave da empresa — gastando duas
 * chamadas para colher dois erros, e escondendo de quem opera a informação de que
 * o defeito é nosso.
 */
export type MotivoDaQueda =
  /** Janela de uso da assinatura estourada (429, ou 402 de crédito esgotado). */
  | "limite_de_uso"
  /** O token do login venceu e precisa ser renovado (401/403 com sinal de expiração). */
  | "token_expirado"
  /** A assinatura recusou a credencial sem dizer que ela venceu (401/403). */
  | "sem_autorizacao"
  /** A assinatura respondeu 5xx: a reserva existe para não deixar o cliente sem resposta. */
  | "falha_do_provedor"
  /** Não houve resposta (rede, DNS, timeout): a assinatura não chegou a julgar a credencial. */
  | "rede";

/** Sinais de expiração no que o provedor devolveu. Comparados em caixa baixa. */
const SINAIS_DE_EXPIRACAO: readonly RegExp[] = [
  /expir/, // expired / expiration / expirado / expirou
  /invalid_grant/,
  /vencid/,
];

/**
 * Traduz o desfecho de uma chamada da assinatura em motivo de queda.
 *
 * `status` é o HTTP; `null` significa que não houve resposta (exceção de rede,
 * timeout, endereço inalcançável) — o caso em que o token não foi julgado por
 * ninguém. `detalhe` é o texto que o provedor devolveu, usado SÓ para separar
 * "expirado" de "não autorizado": os dois chegam como 401, e o tratamento é
 * diferente (um pede renovação do login, o outro pede reconexão/assinatura ativa).
 *
 * Devolve `null` quando não há queda a decidir — status 4xx que não é de
 * credencial (400 de payload, 404 de rota, 422 de parâmetro). O detalhe nunca é
 * guardado nem devolvido: pode carregar material da credencial.
 */
export function classificarFalhaDaAssinatura(
  status: number | null,
  detalhe?: string | null,
): MotivoDaQueda | null {
  if (status === null) return "rede";
  if (status === 429 || status === 402) return "limite_de_uso";
  if (status === 401 || status === 403) {
    const texto = (detalhe ?? "").toLowerCase();
    return SINAIS_DE_EXPIRACAO.some((sinal) => sinal.test(texto))
      ? "token_expirado"
      : "sem_autorizacao";
  }
  if (status >= 500) return "falha_do_provedor";
  return null;
}

/** A chamada cai para a chave de API da organização — a reserva existe. */
export interface QuedaParaAReserva {
  acao: "tentar_reserva";
  /** Quem atende a chamada agora: o provedor cuja chave já está cadastrada. */
  provedorDeReserva: string;
  motivo: MotivoDaQueda;
}

/** Não há para onde cair: a conversa vai para um humano, com o motivo. */
export interface PassarParaHumano {
  acao: "passar_para_humano";
  motivo: MotivoDaQueda;
}

export type DecisaoDaQueda = QuedaParaAReserva | PassarParaHumano;

/**
 * A decisão do item 3, em uma função pura: aconteceu (`motivo`) e existe reserva
 * (`temChaveDeReserva`) → cai; aconteceu e não existe → humano; não aconteceu
 * (`motivo === null`) → `null`, e quem chamou segue com o desfecho normal.
 *
 * "Passar para um humano" é decisão de produto já tomada na issue: sem chave de
 * reserva o agente não pode ficar calado. O TEXTO que o atendente lê não mora
 * aqui (é tela, e tela tem i18n) — o que sai daqui é o motivo, e é ele que o
 * chamador registra no painel para explicar a troca.
 */
export function decidirQuedaDaAssinatura(entrada: {
  motivo: MotivoDaQueda | null;
  temChaveDeReserva: boolean;
}): DecisaoDaQueda | null {
  const { motivo } = entrada;
  if (motivo === null) return null;
  if (entrada.temChaveDeReserva) {
    return {
      acao: "tentar_reserva",
      provedorDeReserva: PROVEDOR_DE_RESERVA_DA_ASSINATURA,
      motivo,
    };
  }
  return { acao: "passar_para_humano", motivo };
}

/**
 * O atalho que o caminho da chamada usa: junta "de quem era a chamada" com o
 * desfecho e devolve a decisão — ou `null` quando não é assunto deste provedor.
 *
 * O primeiro freio é o provedor: nativo que falhou continua falhando como
 * sempre. Sem essa guarda, um 401 da Anthropic cairia para a chave da OpenAI e a
 * conta de uma empresa pagaria a chamada de outra configuração.
 */
export function decidirQuedaDoProvedor(entrada: {
  provider: string;
  status: number | null;
  detalhe?: string | null;
  temChaveDeReserva: boolean;
}): DecisaoDaQueda | null {
  if (provedorDeReserva(entrada.provider) === null) return null;
  return decidirQuedaDaAssinatura({
    motivo: classificarFalhaDaAssinatura(entrada.status, entrada.detalhe),
    temChaveDeReserva: entrada.temChaveDeReserva,
  });
}
