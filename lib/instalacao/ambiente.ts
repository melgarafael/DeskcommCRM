/**
 * O retrato do que a INSTALAÇÃO já trouxe pronta — lido do ambiente do próprio
 * processo, sem banco.
 *
 * Existe porque o onboarding pergunta coisas que o instalador já perguntou. Quem
 * roda o `install.sh` escolhe a IA, cola a chave, sobe o WhatsApp e o Redis; e
 * então abre a primeira tela e é tratado como se tivesse acabado de chegar. A
 * detecção automática que falta começa aqui.
 *
 * ⚠️ Desfaz uma premissa escrita no código: `app/api/v1/ai/providers/route.ts`
 * afirma que "o servidor web não enxerga o env do worker" e por isso nunca
 * mostra a origem `variavel_de_ambiente`. Medido: `docker-compose.prod.yml` dá
 * `env_file: .env` ao serviço `app` (linha 34) E ao `worker` (linha 71) — o
 * MESMO arquivo. O que de fato só existe do lado do worker são os knobs de
 * nome de modelo, que vivem apenas no schema Zod de `lib/agent-engine/env.ts`;
 * `process.env` continua alcançável nos dois lados.
 *
 * Fonte injetável de propósito, como `listClassifierModels` recebe as chaves de
 * plataforma: é o que permite testar sem mexer no `process.env` do processo.
 */
import { IDS_DE_PROVEDOR } from "@/lib/ai/pontos/provedores";
import { lerTransporteDeWhatsapp, type TransporteDeWhatsapp } from "@/lib/channels/transporte";

/**
 * A fonte é um mapa simples, e não `NodeJS.ProcessEnv`: o tipo global é
 * aumentado por declarações do projeto, e exigir a forma completa obrigaria
 * cada teste a montar um ambiente inteiro só para checar duas variáveis.
 */
export type FonteDeAmbiente = Record<string, string | undefined>;

export interface AmbienteDaInstalacao {
  /** Por provedor: existe chave de plataforma no `.env` desta instalação? */
  chavesDeProvedor: Record<string, boolean>;
  /** Gateway de IA configurado (alternativa a chave direta de provedor). */
  gateway: boolean;
  /** Envio de e-mail configurado no ambiente da instalação. */
  email: boolean;
  /**
   * O transporte de WhatsApp está apontado e com chave?
   *
   * ⚠️ O CAMPO TINHA O NOME DO PROVEDOR, e a leitura vivia aqui. A doutrina de
   * restrição de canal proíbe nomear provider fora de `lib/channels/` — e a
   * proibição tinha razão de produto: uma instalação com OUTRO transporte seria
   * descrita pela tela como "o WhatsApp desta instalação ainda não subiu" mesmo
   * com o dela funcionando. Quem responde agora é `lib/channels/transporte.ts`.
   */
  transporteDeWhatsapp: TransporteDeWhatsapp;
}

/** O nome da variável de chave de plataforma de cada provedor. */
const VARIAVEL_DA_CHAVE: Record<string, string> = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  openrouter: "OPENROUTER_API_KEY",
  // O Google não tem chave de plataforma: `resolveOrgLlmConfig` não tem ramo de
  // fallback para ele, e nenhuma variável existe em `lib/env.ts` nem no
  // `.env.example`. Declarar aqui um nome inventado faria o leitor prometer um
  // caminho que o runtime recusa.
};

function preenchida(source: FonteDeAmbiente, nome: string | undefined): boolean {
  if (!nome) return false;
  // Vazio é ausente — é o contrato do `.env` do projeto: o template gera
  // `CHAVE=` e o README promete "deixe vazio e cadastre depois na tela".
  return (source[nome] ?? "").trim() !== "";
}

export function lerAmbiente(source: FonteDeAmbiente = process.env): AmbienteDaInstalacao {
  const chavesDeProvedor: Record<string, boolean> = {};
  for (const id of IDS_DE_PROVEDOR) {
    chavesDeProvedor[id] = preenchida(source, VARIAVEL_DA_CHAVE[id]);
  }

  return {
    chavesDeProvedor,
    gateway: preenchida(source, "AI_GATEWAY_API_KEY"),
    email: preenchida(source, "SMTP_HOST") && preenchida(source, "SMTP_FROM_EMAIL"),
    transporteDeWhatsapp: lerTransporteDeWhatsapp(source),
  };
}

/**
 * O nome que o instalador dá à organização quando ninguém perguntou o nome real
 * do negócio. Exportado para o produto poder detectar esse estado em vez de
 * repetir a string — hoje ela está duplicada entre o `install.sh` e o
 * `scripts/bootstrap-owner.ts`.
 */
export const NOME_PLACEHOLDER_DA_INSTALACAO = "Minha Empresa";
export const SLUG_PLACEHOLDER_DA_INSTALACAO = "minha-empresa";

/** A organização ainda está com o nome que o instalador deixou? */
export function nomeAindaEhPlaceholder(org: {
  slug?: string | null;
  display_name?: string | null;
}): boolean {
  return (
    org.slug === SLUG_PLACEHOLDER_DA_INSTALACAO ||
    org.display_name?.trim() === NOME_PLACEHOLDER_DA_INSTALACAO
  );
}
