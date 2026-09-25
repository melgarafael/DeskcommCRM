/**
 * O texto que vai para a pessoa.
 *
 * ═══ O vocabulário não é novo ═══
 *
 * `{{nome}}` e `{{primeiro_nome}}` são as MESMAS variáveis de
 * `lib/inbox/template-vars.ts`. Campanha não inventa vocabulário próprio: quem
 * aprendeu a escrever template no Inbox escreve igual aqui. A única que a
 * campanha acrescenta é `{{saudacao}}`, que sai do relógio.
 *
 * ═══ Por que `{{saudacao}}` é resolvida no ENVIO, e não na preparação ═══
 *
 * A janela de envio cobre o dia inteiro e a campanha anda devagar de propósito.
 * Um "Bom dia!" cravado no texto (ou congelado às 9h) chega às 16h dizendo bom
 * dia — numa mensagem que se apresenta como alguém escrevendo, isso denuncia o
 * disparo automático na primeira palavra, que é o que a lista não perdoa. Foi o
 * defeito do primeiro piloto desta feature.
 *
 * ═══ Por que variável sem valor PULA a pessoa ═══
 *
 * "Olá , tudo bem?" é pior que não mandar: é a mesma denúncia, com o agravante
 * de ir para um contato que se queima uma vez só. O renderizador devolve o que
 * faltou e quem chama decide — na preparação vira exclusão visível
 * (`variavel_ausente`), com o operador vendo o número antes de apertar.
 *
 * Sem `eval`, sem HTML, sem travessia de propriedade: é `replace` sobre um mapa
 * fechado de resolvedores.
 */

import { horaNoFuso } from "./relogio";

/** As variáveis que existem. Oferecer uma que não resolve é prometer dado que não há. */
export const VARIAVEIS_DA_CAMPANHA = ["nome", "primeiro_nome", "saudacao"] as const;

export type VariavelDaCampanha = (typeof VARIAVEIS_DA_CAMPANHA)[number];

/** O que a tela mostra ao lado de cada variável. */
export const DESCRICAO_DA_VARIAVEL: Record<VariavelDaCampanha, string> = {
  nome: "Nome do contato, como está no cadastro",
  primeiro_nome: "Só a primeira palavra do nome",
  saudacao: "Bom dia / Boa tarde / Boa noite, na hora do envio",
};

/** Os valores congelados no snapshot. `saudacao` não entra: ela é da hora do envio. */
export interface ValoresDoDestinatario {
  nome: string | null;
}

const TOKEN = /\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g;

export interface TextoRenderizado {
  texto: string;
  /** Variáveis usadas no texto que não tinham valor. Vazio = pode enviar. */
  faltando: VariavelDaCampanha[];
  /** Tokens que não são variáveis conhecidas — ficam literais, como no Inbox. */
  desconhecidas: string[];
}

export function renderizar(
  template: string,
  valores: ValoresDoDestinatario,
  quando?: { agora: Date; fuso: string },
): TextoRenderizado {
  const nome = (valores.nome ?? "").trim();
  const faltando = new Set<VariavelDaCampanha>();
  const desconhecidas = new Set<string>();

  const texto = template.replace(TOKEN, (literal, bruto: string) => {
    const chave = bruto.toLowerCase();
    switch (chave) {
      case "nome": {
        if (nome === "") return marcarFalta(faltando, "nome", literal);
        return nome;
      }
      case "primeiro_nome": {
        const primeiro = nome.split(/\s+/)[0] ?? "";
        if (primeiro === "") return marcarFalta(faltando, "primeiro_nome", literal);
        return primeiro;
      }
      case "saudacao": {
        // Sem instante, a saudação fica literal: quem renderiza a PRÉVIA não
        // sabe a hora do envio, e cravar uma ali ensinaria o operador a esperar
        // aquela. A prévia mostra `{{saudacao}}`; o envio resolve.
        if (!quando) return literal;
        return saudacaoDaHora(quando.agora, quando.fuso);
      }
      default:
        desconhecidas.add(bruto);
        return literal;
    }
  });

  return { texto, faltando: [...faltando], desconhecidas: [...desconhecidas] };
}

function marcarFalta(
  destino: Set<VariavelDaCampanha>,
  variavel: VariavelDaCampanha,
  literal: string,
): string {
  destino.add(variavel);
  return literal;
}

/** Quais variáveis um texto usa — para a tela avisar antes, não depois. */
export function variaveisUsadas(template: string): VariavelDaCampanha[] {
  const achadas = new Set<VariavelDaCampanha>();
  for (const [, bruto] of template.matchAll(TOKEN)) {
    const chave = (bruto ?? "").toLowerCase();
    if ((VARIAVEIS_DA_CAMPANHA as readonly string[]).includes(chave)) {
      achadas.add(chave as VariavelDaCampanha);
    }
  }
  return [...achadas];
}

/**
 * "Bom dia" / "Boa tarde" / "Boa noite" — no fuso do canal, nunca no do servidor.
 *
 * Os cortes são os do português falado, não os do relógio: tarde começa ao
 * meio-dia e noite às 18h.
 */
export function saudacaoDaHora(agora: Date, fuso: string): string {
  const hora = horaNoFuso(agora, fuso);
  if (hora < 12) return "Bom dia";
  if (hora < 18) return "Boa tarde";
  return "Boa noite";
}
