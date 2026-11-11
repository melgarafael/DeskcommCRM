/**
 * A IDENTIDADE VISUAL de cada rede — um lugar só (issue #4094).
 *
 * O aviso de mensagem nova precisa dizer DE ONDE veio sem que a pessoa leia, e
 * a lista de conversas já dizia isso pelo logo colorido. Duas cópias da mesma
 * tabela divergem na primeira cor ajustada, então a tabela mora aqui e é
 * consumida pelos dois: `components/inbox/ChannelLogo.tsx` (lista e cabeçalho)
 * e `lib/notifications/marca-do-aviso.tsx` (toast).
 *
 * Duas regras que este arquivo carrega:
 *
 * 1. **Cor é TOKEN, não hex.** Os valores vivem em `app/globals.css`
 *    (`--color-canal-*`, claro e escuro), porque um verde de marca pensado para
 *    fundo claro some no escuro. Todos os quatro passam no piso de componente
 *    da WCAG (3:1) contra o `--color-bg` do próprio tema — é o que
 *    `lib/channels/marca-do-canal.test.ts` mede.
 * 2. **Canal desconhecido não é erro.** O mapa tem fallback neutro, sem ícone,
 *    para que uma rede nova (ou um payload sem `channel_sessions`) não quebre o
 *    aviso nem exija mexer em quem chama. Quem decide o canal é
 *    `channelBrand()` (../presentation), que traduz transporte em rede.
 */
import type { Icon as PhosphorIcon } from "@phosphor-icons/react";

import { traduzir } from "@/lib/i18n/dicionario";
import type { Idioma } from "@/lib/i18n/idiomas";
import { ChatText, InstagramLogo, MessengerLogo, TelegramLogo, WhatsappLogo } from "@/lib/ui/icons";

/** As redes que o produto sabe desenhar. Rede nova entra aqui E em `channelBrand`. */
export type CanalConhecido = "whatsapp" | "instagram" | "messenger" | "telegram" | "sms";

export interface MarcaDeCanal {
  /** `unknown` é o fallback: sem ícone, cor neutra, rótulo genérico. */
  id: CanalConhecido | "unknown";
  /** Nome da rede. Para o fallback é a chave "Canal" do dicionário. */
  rotulo: string;
  /** Token de cor do tema (`var(--color-canal-…)` ou o neutro de borda). */
  cor: string;
  Icone: PhosphorIcon | null;
}

const MARCAS: Record<CanalConhecido, MarcaDeCanal> = {
  whatsapp: {
    id: "whatsapp",
    rotulo: "WhatsApp",
    cor: "var(--color-canal-whatsapp)",
    Icone: WhatsappLogo,
  },
  instagram: {
    id: "instagram",
    rotulo: "Instagram",
    cor: "var(--color-canal-instagram)",
    Icone: InstagramLogo,
  },
  messenger: {
    id: "messenger",
    rotulo: "Messenger",
    cor: "var(--color-canal-messenger)",
    Icone: MessengerLogo,
  },
  telegram: {
    id: "telegram",
    rotulo: "Telegram",
    cor: "var(--color-canal-telegram)",
    Icone: TelegramLogo,
  },
  // SMS (#4415): não é marca de ninguém — o ícone é o balão de texto genérico,
  // e o rótulo é igual em todo idioma.
  sms: {
    id: "sms",
    rotulo: "SMS",
    cor: "var(--color-canal-sms)",
    Icone: ChatText,
  },
};

/**
 * Sem marca: canal desconhecido, ausente, ou rede que ainda não tem cor. A cor
 * é a da borda forte do tema — neutra nos dois — e NÃO há ícone, porque
 * desenhar o logo errado é pior que não desenhar logo nenhum.
 */
const SEM_MARCA: MarcaDeCanal = {
  id: "unknown",
  rotulo: "Canal",
  cor: "var(--color-text-muted)",
  Icone: null,
};

/** Identidade de um canal pelo id da rede; qualquer outra coisa cai no neutro. */
export function marcaDoCanal(canal?: string | null): MarcaDeCanal {
  if (!canal) return SEM_MARCA;
  // `hasOwnProperty.call` e não `MARCAS[canal]`: a string vem do banco e
  // `"constructor"`/`"toString"` alcançariam o protótipo, devolvendo um objeto
  // que não é marca (o teste de fallback pegou exatamente isso).
  if (!Object.prototype.hasOwnProperty.call(MARCAS, canal)) return SEM_MARCA;
  return MARCAS[canal as CanalConhecido];
}

/**
 * O que o leitor de tela anuncia. Cor não é informação acessível: o nome do
 * canal viaja em TEXTO, ao lado do ícone (que fica `aria-hidden`).
 */
export function rotuloAcessivelDoCanal(marca: MarcaDeCanal, idioma: Idioma): string {
  const nome = traduzir(marca.rotulo, idioma);
  if (marca.id === "unknown") return nome;
  return `${traduzir("Canal", idioma)}: ${nome}`;
}
