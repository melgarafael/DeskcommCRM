/**
 * OS PROVEDORES DE SERVIÇO QUE O SISTEMA SABE USAR — irmã de
 * `lib/ai/pontos/provedores.ts`, para quem NÃO conversa com o cliente.
 *
 * `PROVEDORES` (o arquivo irmão) é a lista de quem responde um turno de chat —
 * e está casada, por `tests/unit/provedores-x-registry.test.ts`, com o registry
 * que executa modelo de conversa. ElevenLabs (voz: ouvir e falar) não executa
 * turno nenhum, então colocá-lo naquela lista faria o primeiro assert daquele
 * teste reprovar com razão: a tela ofereceria um provedor que toda chamada de
 * CONVERSA recusaria com `llm_provider_unknown` — porque não é disso que ele
 * trata.
 *
 * A credencial em si usa a MESMA tabela (`ai_provider_credentials`), a mesma
 * cifra AES-GCM, o mesmo audit e a mesma view segura — DIRC (CLAUDE.md) diz
 * não duplicar isso por uma lista de provedores diferente. O que precisa ser
 * SEPARADO é só o vocabulário que a tela oferece e o validador que prova a
 * chave, porque o executor de voz não é um `LanguageModel` da AI SDK.
 *
 * Mesma defesa em profundidade do arquivo irmão:
 *  - **Esta lista** é o que a tela OFERECE como serviço de voz.
 *  - **O validador** (`lib/ai/provider-validators.ts`) é quem PROVA a chave.
 *  - **O executor de cada ponto** (transcrição, síntese) é quem de fato chama
 *    a API — cada um na sua Onda, não um registry genérico como o de chat,
 *    porque STT e TTS não compartilham a mesma forma de chamada.
 */

/** Como a chave daquele serviço é validada e o que a tela precisa pedir. */
export interface ProvedorDeServico {
  id: string;
  /** Nome como o operador conhece. */
  rotulo: string;
  /** Uma frase sobre quando escolher este, para quem não acompanha o mercado. */
  quandoUsar: string;
  /** Onde o operador pega a chave — a tela mostra o link. */
  ondePegarAChave: string;
  /** Como a chave começa — vira placeholder do campo, para a pessoa reconhecer que copiou a coisa certa. */
  prefixoDaChave: string;
}

export const PROVEDORES_DE_SERVICO = [
  {
    id: "elevenlabs",
    rotulo: "ElevenLabs (voz)",
    quandoUsar:
      "Para o agente ouvir o áudio que o cliente manda com mais precisão (inclusive diferenciando quem fala) e para responder falando, em nota de voz, quando fizer sentido.",
    ondePegarAChave: "https://elevenlabs.io/app/settings/api-keys",
    prefixoDaChave: "sk_…",
  },
] as const satisfies readonly ProvedorDeServico[];
// `as const satisfies`, mesma razão do arquivo irmão: anotar o tipo apagaria os
// literais e `ServiceProvider` (em provider-validators.ts) viraria `string`.

/** Só os ids, na forma que o `z.enum` exige (tupla não-vazia de literais). */
export const IDS_DE_SERVICO = PROVEDORES_DE_SERVICO.map((p) => p.id) as unknown as readonly [
  (typeof PROVEDORES_DE_SERVICO)[number]["id"],
  ...(typeof PROVEDORES_DE_SERVICO)[number]["id"][],
];

export const PROVEDOR_DE_SERVICO_POR_ID: ReadonlyMap<string, ProvedorDeServico> = new Map(
  PROVEDORES_DE_SERVICO.map((p) => [p.id, p]),
);

export function ehProvedorDeServicoSuportado(id: string): boolean {
  return PROVEDOR_DE_SERVICO_POR_ID.has(id);
}
