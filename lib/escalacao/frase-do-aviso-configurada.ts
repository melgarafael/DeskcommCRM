/**
 * A FRASE DO AVISO DE PASSAGEM, QUANDO O AGENTE TEM A DELE.
 *
 * ## Por que existe (issue #3725)
 *
 * O aviso que o cliente lê quando a IA sai de campo era uma frase FIXA do
 * código — e a escolhida para o motivo genérico era "Prefiro não arriscar aqui:
 * passei seu pedido para um atendente humano." O autor mediu o tamanho do
 * descompasso: o prompt do agente pede tom caloroso, curto, sem frase técnica,
 * e o cliente recebia isso no meio de uma conversa de venda. Texto de marca é
 * do tenant; texto de sistema não deveria ser imutável.
 *
 * ## Onde ele mora, e por que aqui
 *
 * `ai_agents.config` — o JSON que a tela do agente já grava e já lê. SEM
 * MIGRATION: o campo é livre por definição, e uma coluna nova obrigaria todo
 * clone a migrar antes de poder personalizar uma frase.
 *
 * Chave: `aviso_de_handoff`. Duas irmãs são aceitas por compatibilidade com
 * configurações escritas à mão antes desta issue: `aviso_de_passagem` e
 * `handoff_notice`. A PRIMEIRA que existir e for válida vence.
 *
 * ## Validação — o que NÃO é frase configurada
 *
 * Devolver `null` é a resposta para tudo que não serve, e quem chama cai no
 * texto padrão (curto e humano). Isso vale para: tipo errado, string vazia,
 * frase acima do teto (o aviso é UMA mensagem de WhatsApp, não um parágrafo) e
 * frase que fica só de pontuação. Não se valida "tom" aqui — isso é do tenant.
 *
 * ⚠️ A frase configurada SUBSTITUI o aviso inteiro, inclusive o fecho que
 * respeita a disponibilidade da equipe (`textoDoAviso`). A troca é consciente:
 * quem escreve a própria frase assume o que ela promete. Prometer "já te
 * chamam" para uma conta sem ninguém configurado é decisão de quem escreveu —
 * e é justamente por isso que o padrão do produto não promete.
 */

/** Teto do aviso: uma bolha de WhatsApp, não um parágrafo. */
export const TETO_DA_FRASE_DO_AVISO = 320;

/** As chaves aceitas em `ai_agents.config`, na ordem de precedência. */
export const CHAVES_DA_FRASE_DO_AVISO = [
  "aviso_de_handoff",
  "aviso_de_passagem",
  "handoff_notice",
] as const;

/**
 * Lê a frase configurada do agente. `config` é o JSON cru de
 * `ai_agents.config` (`unknown` de propósito: o formato é do banco, e um tipo
 * aqui obrigaria a interface do agente a carregar o campo inteiro).
 */
export function lerFraseDoAvisoConfigurada(config: unknown): string | null {
  if (config === null || typeof config !== "object") return null;
  const bruto = config as Record<string, unknown>;
  for (const chave of CHAVES_DA_FRASE_DO_AVISO) {
    const valor = bruto[chave];
    if (typeof valor !== "string") continue;
    const frase = normalizarFraseDoAviso(valor);
    if (frase !== null) return frase;
  }
  return null;
}

/**
 * Espaços colapsados e bordas aparadas: a frase vai para o cliente como UMA
 * linha, e uma quebra de linha colada do JSON apareceria como bolha vazia.
 * `null` quando o resultado não tem letra nem número ou passa do teto.
 */
export function normalizarFraseDoAviso(bruta: string): string | null {
  const frase = bruta.replace(/\s+/g, " ").trim();
  if (frase.length < 3 || frase.length > TETO_DA_FRASE_DO_AVISO) return null;
  if (!/[\p{L}\p{N}]/u.test(frase)) return null;
  return frase;
}
