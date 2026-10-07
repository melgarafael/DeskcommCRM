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
 * ═══ Campos personalizados: `{{lead.gancho}}` e `{{contato.link_previa}}` ═══
 *
 * Prospeccão é a primeira mensagem que precisa ser DIFERENTE para cada pessoa:
 * o que a pesquisa achou daquele negócio, o link da prévia montada só para ele.
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
 * Sem `eval`, sem HTML, sem travessia de propriedade: é `replace` sobre um mapa
 * fechado de resolvedores, e o campo personalizado só é lido como PROPRIEDADE
 * PRÓPRIA do jsonb do banco — `{{lead.__proto__}}` não atravessa protótipo.
 */

import { horaNoFuso } from "./relogio";

/** As variáveis que existem. Oferecer uma que não resolve é prometer dado que não há. */
export const VARIAVEIS_DA_CAMPANHA = ["nome", "primeiro_nome", "saudacao"] as const;

export type VariavelDaCampanha = (typeof VARIAVEIS_DA_CAMPANHA)[number];

/** As duas raízes de campo personalizado. Fechadas de propósito: sem elas o token fica literal. */
export const RAIZES_DE_CAMPO = ["lead", "contato"] as const;

/** O que a tela mostra ao lado de cada variável. */
export const DESCRICAO_DA_VARIAVEL: Record<VariavelDaCampanha, string> = {
  nome: "Nome do contato, como está no cadastro",
  primeiro_nome: "Só a primeira palavra do nome",
  saudacao: "Bom dia / Boa tarde / Boa noite, na hora do envio",
};

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

/**
 * O token aceita ponto — `{{lead.gancho}}`. Só palavra e ponto: um caminho com
 * espaço ou símbolo não casa e vira literal, que é o destino de todo token que
 * este módulo não conhece.
 */
const TOKEN = /\{\{\s*([a-zA-Z0-9_]+(?:\.[a-zA-Z0-9_]+)*)\s*\}\}/g;

/**
 * Nomes que um jsonb pode trazer gravados e que NÃO são campo nenhum: são
 * propriedade do protótipo do objeto. Lidos, dariam `{{lead.constructor}}` um
 * texto que o operador nunca escreveu (ou código, num mapa malformado).
 */
const CHAVES_DE_PROTOTIPO = new Set(["__proto__", "constructor", "prototype"]);

export interface TextoRenderizado {
  texto: string;
  /** Variáveis usadas no texto que não tinham valor. Vazio = pode enviar. */
  faltando: string[];
  /** Tokens que não são variáveis conhecidas — ficam literais, como no Inbox. */
  desconhecidas: string[];
}

export function renderizar(
  template: string,
  valores: ValoresDoDestinatario,
  quando?: { agora: Date; fuso: string },
): TextoRenderizado {
  const nome = (valores.nome ?? "").trim();
  const faltando = new Set<string>();
  const desconhecidas = new Set<string>();

  const texto = template.replace(TOKEN, (literal, bruto: string) => {
    const chave = bruto.toLowerCase();
    switch (chave) {
      case "nome": {
        if (nome === "") return marcarFalta(faltando, "nome", literal);
        return blindar(nome);
      }
      case "primeiro_nome": {
        const primeiro = nome.split(/\s+/)[0] ?? "";
        if (primeiro === "") return marcarFalta(faltando, "primeiro_nome", literal);
        return blindar(primeiro);
      }
      case "saudacao": {
        // Sem instante, a saudação fica literal: quem renderiza a PRÉVIA não
        // sabe a hora do envio, e cravar uma ali ensinaria o operador a esperar
        // aquela. A prévia mostra `{{saudacao}}`; o envio resolve.
        if (!quando) return literal;
        return saudacaoDaHora(quando.agora, quando.fuso);
      }
      default: {
        const raiz = raizDeCampo(bruto);
        if (raiz) {
          const mapa = raiz === "lead" ? valores.lead : valores.contato;
          const valor = lerCampo(mapa, nomeDoCampo(bruto));
          // Sem valor = FALTA, igual a `{{nome}}` sem nome: o literal fica
          // visível na prévia e quem chama tira a pessoa da lista.
          if (valor === null) return marcarFalta(faltando, chave, literal);
          return blindar(valor);
        }
        desconhecidas.add(bruto);
        return literal;
      }
    }
  });

  // A renderização com instante é a FINAL (envio e envio de teste): só aqui a
  // blindagem sai. Sem instante (preparação), ela fica no corpo congelado e
  // protege o valor da segunda passada que o envio faz — ver `blindar`.
  const final = quando ? texto.replaceAll(CHAVE_BLINDADA, "{") : texto;
  return { texto: final, faltando: [...faltando], desconhecidas: [...desconhecidas] };
}

/**
 * Valor do cadastro entra no texto como DADO, nunca como template.
 *
 * O corpo é renderizado DUAS vezes: na preparação (nome e campos, congelados em
 * `rendered_body`) e no envio (`rodada.ts`, pela saudação). Um campo com
 * `{{saudacao}} {{nome}}` dentro seria lido na segunda passada como token e
 * sairia "Boa tarde Ana" — texto que o operador nunca escreveu nem viu na
 * prévia. O WORD JOINER depois de cada `{` faz o `TOKEN` não casar (ele não é
 * `\s`), é invisível, e a renderização final o tira.
 */
const CHAVE_BLINDADA = "{\u2060";

function blindar(valor: string): string {
  return valor.replaceAll("{", CHAVE_BLINDADA);
}

function marcarFalta(destino: Set<string>, variavel: string, literal: string): string {
  destino.add(variavel);
  return literal;
}

/** `lead.gancho` → `lead`; `{{lead}}` (sem campo) → `null`, que é token desconhecido. */
function raizDeCampo(bruto: string): string | null {
  const ponto = bruto.indexOf(".");
  if (ponto <= 0) return null;
  const raiz = bruto.slice(0, ponto).toLowerCase();
  return (RAIZES_DE_CAMPO as readonly string[]).includes(raiz) ? raiz : null;
}

/**
 * O nome do campo depois da raiz. `lead.custom_fields.gancho` e `lead.gancho`
 * são o MESMO campo: quem veio da automação já escreve o caminho interno e não
 * precisa aprender outro aqui.
 */
function nomeDoCampo(bruto: string): string {
  const depois = bruto.slice(bruto.indexOf(".") + 1);
  return /^custom_fields\./i.test(depois) ? depois.slice("custom_fields.".length) : depois;
}

/**
 * O valor em texto, ou `null` quando não há valor utilizável.
 *
 * Só PROPRIEDADE PRÓPRIA do mapa — `Object.hasOwn`, nunca `in`: um jsonb com
 * `__proto__` gravado não vira caminho para o protótipo. Lista (multiselect) sai
 * separada por vírgula, que é como a pessoa leria; objeto e array vazio não
 * viram texto, viram falta.
 */
function lerCampo(mapa: CamposPersonalizados | null | undefined, campo: string): string | null {
  if (!mapa || typeof mapa !== "object") return null;
  if (campo === "" || CHAVES_DE_PROTOTIPO.has(campo)) return null;
  const chave = Object.hasOwn(mapa, campo)
    ? campo
    : Object.hasOwn(mapa, campo.toLowerCase())
      ? campo.toLowerCase()
      : null;
  if (chave === null) return null;
  const texto = textoDeCampo((mapa as Record<string, unknown>)[chave]);
  return texto.trim() === "" ? null : texto;
}

function textoDeCampo(valor: unknown): string {
  if (valor === null || valor === undefined) return "";
  if (Array.isArray(valor)) {
    return valor
      .filter((v) => v !== null && v !== undefined && typeof v !== "object")
      .map((v) => String(v))
      .join(", ");
  }
  if (typeof valor === "object") return "";
  return String(valor);
}

/**
 * Quais variáveis um texto usa — para a tela avisar antes, não depois.
 * Inclui os campos personalizados no caminho que o texto escreveu (`lead.gancho`).
 */
export function variaveisUsadas(template: string): string[] {
  const achadas = new Set<string>();
  for (const [, bruto] of template.matchAll(TOKEN)) {
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
  for (const [, bruto] of template.matchAll(TOKEN)) {
    const raiz = raizDeCampo(bruto ?? "");
    if (raiz === "lead") lead = true;
    if (raiz === "contato") contato = true;
  }
  return { lead, contato };
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
