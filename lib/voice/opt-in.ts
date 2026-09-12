/**
 * A CHAMADA DE VOZ SÓ EXISTE ONDE A INSTALAÇÃO A OFERECE **E** A ORGANIZAÇÃO A PEDIU.
 *
 * ═══ POR QUE SÃO DUAS PERGUNTAS, E NÃO UMA ═══
 *
 * `WACALLS_API_BASE_URL` responde **capacidade**: o serviço de voz está de pé
 * nesta instalação? Quem responde é quem administra a VPS, e a resposta vale
 * para todas as organizações do processo.
 *
 * `org_voice_calls.enabled` responde **consentimento**: esta organização aceita
 * vincular um segundo aparelho ao número dela? Quem responde é o admin dela, e
 * a resposta vale só para ela.
 *
 * São eixos diferentes, e por isso a combinação é `&&` — não a precedência
 * `escolhaDaOrg ?? padraoDoAmbiente` de `lib/agent-engine/guardrails/camadas-da-org.ts`.
 * Copiar aquela forma aqui seria copiar a razão errada: lá as duas pontas
 * respondem a MESMA pergunta ("esta camada roda?"), e a mais específica vence.
 * Aqui não vencem uma à outra — uma organização não consente a si mesma um
 * serviço que não está rodando, e um serviço rodando não consente por ninguém.
 *
 * O efeito de inverter isso para `??` seria exatamente o que o dono do produto
 * proibiu: uma variável de ambiente ligada entregaria a capacidade a TODAS as
 * organizações da instalação de uma vez.
 *
 * ═══ AUSÊNCIA DE LINHA É "DESLIGADO" ═══
 *
 * A capacidade é nova: ninguém a tem, e não há decisão anterior a preservar.
 * `false` por ausência é a leitura verdadeira do estado do mundo — e é a
 * condição do dono: ninguém ganha a capacidade por atualizar. Ver o cabeçalho
 * da migration 0234 para o contraste deliberado com a 0142.
 */

/** O que a organização escolheu. `null` = nunca escolheu, e isso é "desligado". */
export type EscolhaDeVoz = boolean | null;

/**
 * A regra inteira, isolada em função pura para ser testável sem banco e sem env.
 *
 * `instalacaoOferece` vem da presença de `WACALLS_API_BASE_URL`;
 * `escolhaDaOrg` vem de `org_voice_calls.enabled` (ou `null`, sem linha).
 */
export function chamadaDeVozLigada(
  escolhaDaOrg: EscolhaDeVoz,
  instalacaoOferece: boolean,
): boolean {
  return instalacaoOferece && (escolhaDaOrg ?? false);
}

/**
 * Como a tela precisa enxergar o estado: três respostas, não uma.
 *
 * Um booleano só diria "não" e deixaria o admin adivinhando se o problema é a
 * escolha dele ou a instalação. `motivo` é o que permite a tela dizer a frase
 * certa — e é a diferença entre "ligue aqui" e "peça a quem administra o
 * servidor".
 */
export type EstadoDaVoz = {
  ligada: boolean;
  instalacaoOferece: boolean;
  escolhaDaOrg: EscolhaDeVoz;
  motivo: "ligada" | "instalacao_nao_oferece" | "organizacao_nao_ligou";
};

export function estadoDaVoz(
  escolhaDaOrg: EscolhaDeVoz,
  instalacaoOferece: boolean,
): EstadoDaVoz {
  const ligada = chamadaDeVozLigada(escolhaDaOrg, instalacaoOferece);
  // A ordem importa: sem serviço na instalação, a escolha da organização é
  // irrelevante e dizer "você não ligou" mandaria o admin clicar um botão que
  // não resolveria nada.
  const motivo = ligada
    ? "ligada"
    : !instalacaoOferece
      ? "instalacao_nao_oferece"
      : "organizacao_nao_ligou";
  return { ligada, instalacaoOferece, escolhaDaOrg, motivo };
}

/**
 * A instalação oferece o serviço?
 *
 * String vazia é o valor que `lib/env.ts` dá quando a chave não está no `.env`,
 * e é também o que o `install.sh` grava por padrão. `.trim()` porque um `.env`
 * escrito à mão com espaço sobrando não pode ligar a feature por acidente.
 */
export function instalacaoOfereceVoz(baseUrl: string | undefined | null): boolean {
  return (baseUrl ?? "").trim() !== "";
}
