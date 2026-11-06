/**
 * O texto que vai para a pessoa.
 *
 * ═══ O vocabulário não é novo ═══
 *
 * `{{nome}}` e `{{primeiro_nome}}` são as MESMAS variáveis de
 * `lib/inbox/template-vars.ts`. Campanha não inventa vocabulário próprio: quem
 * aprendeu a escrever template no Inbox escreve igual aqui. A única que a
 * campanha acrescenta é `{{saudacao}}`, que sai do relógio — e desde o #3687 ela
 * também existe na automação, no follow-up e na resposta rápida, resolvida pela
 * mesma conta (`lib/variaveis/resolvedor.ts`). A lista daqui vem do CATÁLOGO.
 *
 * ═══ Campos personalizados: `{{lead.gancho}}` e `{{contato.link_previa}}` ═══
 *
 * Prospeccão é a primeira mensagem que precisa ser DIFERENTE para cada pessoa:
 * o que a pesquisa achou daquele negócio, o link da prévia montado só para ele.
 * Sem isto cada lead viraria uma campanha — e aí perdem a lista conferida antes
 * de apertar, as métricas, a pausa, o teto diário e a janela.
 *
 * As raízes são duas, e só duas: `lead` (o negócio, `crm_leads.custom_fields`)
 * e `contato` (`contacts.custom_fields`) — o mesmo caminho que a automação já
 * fala (`{{lead.custom_fields.servico}}` também resolve aqui). Raiz desconhecida
 * (`{{sobrenome}}`, `{{contact.name}}`) continua LITERAL, como no Inbox.
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
 * A regra é a MESMA para `{{nome}}` e para `{{lead.gancho}}`: campo que não
 * existe, campo vazio e campo sem mapa nenhum (contato sem negócio) são FALTA,
 * nunca texto pela metade.
 *
 * Sem `eval`, sem HTML, sem travessia de propriedade: o resolvedor lê o mapa
 * fechado do catálogo e o campo personalizado só como PROPRIEDADE PRÓPRIA do
 * jsonb do banco — `{{lead.__proto__}}` não atravessa protótipo.
 */

import { variavelDoCatalogo, variaveisDe } from "@/lib/variaveis/catalogo";
import {
  MARCACAO_DE_VARIAVEL,
  resolverVariaveis,
  saudacaoDaHora,
} from "@/lib/variaveis/resolvedor";

/** As variáveis que existem — a lista sai do catálogo único (#3687). */
export const VARIAVEIS_DA_CAMPANHA: readonly string[] = variaveisDe("campanha");

export type VariavelDaCampanha = string;

/** As duas raízes de campo personalizado. Fechadas de propósito: sem elas o token fica literal. */
export const RAIZES_DE_CAMPO = ["lead", "contato"] as const;

/** O que a tela mostra ao lado de cada variável — a descrição é a do catálogo. */
export const DESCRICAO_DA_VARIAVEL: Readonly<Record<string, string>> = Object.fromEntries(
  VARIAVEIS_DA_CAMPANHA.map((nome) => [nome, variavelDoCatalogo(nome)?.descricao ?? nome]),
);

/** Os campos personalizados de um lado só — jsonb lido do banco, nunca percorrido além do próprio mapa. */
export type CamposPersonalizados = Readonly<Record<string, unknown>>;

/** Os valores congelados no snapshot. `saudacao` não entra: ela é da hora do envio. */
export interface ValoresDoDestinatario {
  nome: string | null;
  /** `{{lead.x}}` — campos do negócio. Sem mapa (contato sem negócio), a variável FALTA. */
  lead?: CamposPersonalizados | null;
  /** `{{contato.x}}` — campos do contato. */
  contato?: CamposPersonalizados | null;
}

/** A mesma marcação das quatro telas — a forma mora no resolvedor único. */
const TOKEN_DA_CAMPANHA = MARCACAO_DE_VARIAVEL;

export interface TextoRenderizado {
  texto: string;
  /** Variáveis usadas no texto que não tinham valor. Vazio = pode enviar. */
  faltando: string[];
  /** Tokens que não são variáveis conhecidas — ficam literais, como no Inbox. */
  desconhecidas: string[];
}

/**
 * O texto da campanha, resolvido pelo MESMO resolvedor das outras telas.
 *
 * `quando` é o instante do envio: só com ele `{{saudacao}}` resolve (na prévia
 * o token fica literal, porque cravar uma saudação ali ensinaria o operador a
 * esperar aquela). `quandoVazio: "pular"` é a política desta tela: o token fica
 * visível na prévia e a pessoa sai da lista com o motivo.
 */
export function renderizar(
  template: string,
  valores: ValoresDoDestinatario,
  quando?: { agora: Date; fuso: string },
): TextoRenderizado {
  const resolvido = resolverVariaveis(
    template,
    {
      nome: valores.nome,
      camposDoNegocio: valores.lead ?? null,
      camposDoContato: valores.contato ?? null,
    },
    {
      fonte: "campanha",
      quandoVazio: "pular",
      agora: quando ? { instante: quando.agora, fuso: quando.fuso } : undefined,
      // O corpo é renderizado DUAS vezes (preparação e envio): o valor entra
      // blindado para a segunda passada não reler o dado como token.
      blindarValores: true,
      desblindarValores: quando !== undefined,
    },
  );

  return {
    texto: resolvido.texto,
    faltando: resolvido.vazias,
    desconhecidas: resolvido.desconhecidas,
  };
}

/** `lead.gancho` → `lead`; `{{lead}}` (sem campo) → `null`, que é token desconhecido. */
function raizDeCampo(bruto: string): string | null {
  const ponto = bruto.indexOf(".");
  if (ponto <= 0) return null;
  const raiz = bruto.slice(0, ponto).toLowerCase();
  return (RAIZES_DE_CAMPO as readonly string[]).includes(raiz) ? raiz : null;
}

/**
 * Quais variáveis um texto usa — para a tela avisar antes, não depois.
 * Inclui os campos personalizados no caminho que o texto escreveu (`lead.gancho`).
 */
export function variaveisUsadas(template: string): string[] {
  const achadas = new Set<string>();
  for (const [, bruto] of template.matchAll(TOKEN_DA_CAMPANHA)) {
    const chave = (bruto ?? "").toLowerCase();
    if ((VARIAVEIS_DA_CAMPANHA as readonly string[]).includes(chave) || raizDeCampo(chave)) {
      achadas.add(chave);
    }
  }
  return [...achadas];
}

/**
 * O corpo usa campo personalizado de cada raiz?
 *
 * Existe para a consulta de audiência não puxar `custom_fields` de 5.000
 * linhas quando o texto é só `{{nome}}`: coluna que ninguém lê custa em toda
 * prévia, e a prévia roda antes de cada clique.
 */
export function camposUsadosNoTexto(template: string): { lead: boolean; contato: boolean } {
  let lead = false;
  let contato = false;
  for (const [, bruto] of template.matchAll(TOKEN_DA_CAMPANHA)) {
    const raiz = raizDeCampo(bruto ?? "");
    if (raiz === "lead") lead = true;
    if (raiz === "contato") contato = true;
  }
  return { lead, contato };
}

export { saudacaoDaHora };
