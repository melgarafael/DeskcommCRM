/**
 * Quanto o modelo de voz espera antes de decidir que o cliente terminou de
 * falar (`eagerness` do `semantic_vad` da Realtime API).
 *
 * O padrão é "low", o mais paciente: segura a resposta até ter certeza de que
 * a fala acabou, o que protege contra ruído de linha e eco de viva-voz. O preço
 * é a pausa — no "low" a OpenAI pode esperar vários segundos de silêncio, e
 * numa ligação isso soa como demora para responder. Quem tem linha limpa troca
 * por "auto" (equivale a "medium") ou "high" pela variável
 * `VOICE_VAD_EAGERNESS`, sem mexer no código.
 *
 * Valor desconhecido ou vazio cai no padrão: errar a grafia não pode derrubar
 * a ligação nem mandar valor inválido para a API.
 */
export const ESPERAS_DA_VEZ = ["low", "medium", "high", "auto"] as const;
export type EsperaDaVez = (typeof ESPERAS_DA_VEZ)[number];

export const ESPERA_DA_VEZ_PADRAO: EsperaDaVez = "low";

export function esperaDaVez(valor: string | undefined): EsperaDaVez {
  const normalizado = valor?.trim().toLowerCase() ?? "";
  return (ESPERAS_DA_VEZ as readonly string[]).includes(normalizado)
    ? (normalizado as EsperaDaVez)
    : ESPERA_DA_VEZ_PADRAO;
}
