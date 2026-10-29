/**
 * QUAIS VOZES A RESPOSTA EM ÁUDIO ACEITA — a regra, sem rede.
 *
 * Puro de propósito: o schema da config do agente (`lib/ai/guardrails-schema.ts`,
 * que também roda no navegador), as rotas de IA › Provedores e o worker leem a
 * MESMA regra. Uma cópia por leitor é como a tela aceita uma voz que o worker
 * recusa, e o cliente que pediu áudio recebe texto sem ninguém saber por quê.
 *
 * **Só Google Cloud Text-to-Speech Standard em português do Brasil**
 * (`pt-BR-Standard-A` … `-Z`), a família de menor custo. WaveNet, Neural2, Chirp, Studio, Polyglot e Gemini custam várias vezes
 * mais e são recusadas no servidor — vindas do navegador, do `.env` ou da
 * lista do Google. Abrir outra família é mudança desta regra, que vale para todos os leitores.
 */

/** Voz padrão: feminina, família Standard (a de menor custo). */
export const VOZ_PADRAO = 'pt-BR-Standard-A';

/** A frase do "Ouvir amostra". Fixa no servidor: a rota não sintetiza texto de ninguém. */
export const FRASE_DA_AMOSTRA = 'Olá! Esta é uma amostra da voz que vai responder aos seus clientes.';

/** `pt-BR-Standard-<Letra>` — e nada mais. */
export const VOZ_ACEITA = /^pt-BR-Standard-[A-Z]$/;

export function ehVozAceita(nome: unknown): nome is string {
  return typeof nome === 'string' && VOZ_ACEITA.test(nome);
}

export type GeneroDaVoz = 'feminina' | 'masculina' | 'neutra';

/** Uma voz como a tela a mostra. Nada além do nome e do gênero sai do Google para o navegador. */
export interface VozDisponivel {
  nome: string;
  genero: GeneroDaVoz;
}

function generoDoGoogle(ssmlGender: unknown): GeneroDaVoz {
  if (ssmlGender === 'FEMALE') return 'feminina';
  if (ssmlGender === 'MALE') return 'masculina';
  return 'neutra';
}

/**
 * A resposta de `GET /v1/voices?languageCode=pt-BR` → só as Standard pt-BR, sem
 * repetição, pela letra. Qualquer outra família que o Google devolva é descartada.
 */
export function vozesAceitasDaLista(bruto: unknown): VozDisponivel[] {
  const lista = (bruto as { voices?: unknown } | null)?.voices;
  if (!Array.isArray(lista)) return [];
  const vistas = new Set<string>();
  const vozes: VozDisponivel[] = [];
  for (const item of lista) {
    const v = item as { name?: unknown; ssmlGender?: unknown; languageCodes?: unknown } | null;
    if (!v || !ehVozAceita(v.name) || vistas.has(v.name)) continue;
    if (Array.isArray(v.languageCodes) && !v.languageCodes.includes('pt-BR')) continue;
    vistas.add(v.name);
    vozes.push({ nome: v.name, genero: generoDoGoogle(v.ssmlGender) });
  }
  return vozes.sort((a, b) => a.nome.localeCompare(b.nome));
}
