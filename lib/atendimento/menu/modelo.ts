/**
 * O MODELO DO MENU DE ATENDIMENTO SEM IA (#4594, fatia 1) — `settings.menu_de_atendimento`.
 *
 * ─── O que este módulo é ────────────────────────────────────────────────────
 *
 * Um menu de UM nível: uma mensagem de boas-vindas com opções NUMERADAS e, em
 * cada opção, uma ação. Quem responde o número escolhe o caminho — e a conversa
 * segue por ele sem uma única chamada de modelo. É o pedido de três comentários
 * do canal (15/10, 27/10 e 11/11) que abriu a #4594: parte de quem usa quer
 * atender a ENTRADA sem gastar token.
 *
 * ─── Por que `settings` jsonb, e não tabela ─────────────────────────────────
 *
 * É configuração de UMA empresa, lida uma vez por mensagem que chega, e não tem
 * invariante que o banco prove sozinho (ao contrário de uma manifestação da
 * ouvidoria, que precisa de protocolo e unicidade). A régua é a MESMA de
 * `settings.ouvidoria.ativa` (`lib/schemas/settings.ts`): só o `true` EXPLÍCITO
 * liga; ausente, `false`, `"true"` ou lixo é DESLIGADO — e desligado é o estado
 * de toda instalação que já existe. Este arquivo não pede migration.
 *
 * ─── A numeração NÃO é dado, é POSIÇÃO ──────────────────────────────────────
 *
 * O menu não guarda "numero": a opção 1 é `opcoes[0]`. Um campo `numero` livre
 * abriria três defeitos de uma vez — número repetido, buraco na sequência e
 * número que não casa com a ordem impressa — e nenhum deles apareceria como
 * erro: o cliente digitaria 3 e cairia na opção errada. A posição não pode
 * divergir do que foi impresso, porque é a mesma lista que imprime e que lê.
 *
 * ─── O que a validação recusa, e por que cada recusa existe ─────────────────
 *
 *   • lista vazia ou com mais de 9 opções — o teto é o que cabe numa mensagem
 *     de WhatsApp sem virar parede de texto, e 9 é o maior dígito;
 *   • rótulo repetido — duas opções com o mesmo nome tornam a escolha do
 *     cliente ambígua para quem atende depois;
 *   • `pessoa` sem `user_id` válido e `arquivo` sem URL — a ação existiria e
 *     falharia no primeiro cliente que a escolhesse;
 *   • arquivo que a régua de mídia não identifica (`classificarMidiaComLegenda`,
 *     a MESMA do passo de mídia do follow-up e da ação de automação): sem MIME
 *     e sem extensão conhecida, o envio teria de adivinhar o tipo — e mandar um
 *     PDF como imagem é o erro que ninguém vê até o cliente reclamar.
 *
 * Menu INVÁLIDO é menu DESLIGADO (`menuDeclarado` devolve `null`): um jsonb
 * torto não pode derrubar a ingestão nem meio-funcionar. Quem escreve a
 * configuração recebe a lista de problemas por `validarMenu`.
 */
import { z } from "zod";

import { classificarMidiaComLegenda } from "@/lib/messaging/media/midia-com-legenda";

/** A chave do bloco dentro de `organizations.settings`. */
export const CHAVE_NO_SETTINGS = "menu_de_atendimento";

/** O maior dígito — e o que cabe numa mensagem sem virar parede de texto. */
export const MAXIMO_DE_OPCOES = 9;

export const TAMANHO_DO_ROTULO = 80;
export const TAMANHO_DAS_BOAS_VINDAS = 1000;
export const TAMANHO_DA_LEGENDA = 1000;
export const TAMANHO_DA_URL = 2000;

const rotuloSchema = z.string().trim().min(1).max(TAMANHO_DO_ROTULO);

/**
 * A ação de uma opção. `fila` passa a conversa para o atendimento humano (a
 * fila, sem dono); `pessoa` já atribui a alguém; `arquivo` manda um arquivo que
 * já existe, por URL.
 */
export const acaoDaOpcaoSchema = z.discriminatedUnion("tipo", [
  z.strictObject({ tipo: z.literal("fila"), rotulo: rotuloSchema }),
  z.strictObject({
    tipo: z.literal("pessoa"),
    rotulo: rotuloSchema,
    user_id: z.string().uuid(),
  }),
  z.strictObject({
    tipo: z.literal("arquivo"),
    rotulo: rotuloSchema,
    media_url: z.string().url().max(TAMANHO_DA_URL),
    /** O texto que acompanha o arquivo. Ausente = o arquivo vai sozinho. */
    legenda: z.string().trim().max(TAMANHO_DA_LEGENDA).optional(),
  }),
]);

export type OpcaoDoMenu = z.infer<typeof acaoDaOpcaoSchema>;

export const menuSemIaSchema = z.strictObject({
  /**
   * A porta do módulo para ESTA empresa. Opcional no schema porque o jsonb é
   * escrito por fora (script, seed, API antiga) e um bloco sem a chave precisa
   * continuar LEGÍVEL — o que ele não pode é ficar LIGADO sem dizer `true`.
   */
  ativa: z.boolean().optional(),
  boas_vindas: z.string().trim().min(1).max(TAMANHO_DAS_BOAS_VINDAS),
  opcoes: z.array(acaoDaOpcaoSchema).min(1).max(MAXIMO_DE_OPCOES),
});

/** O menu como o runtime o consome — `ativa` já normalizado para booleano. */
export interface MenuSemIa {
  ativa: boolean;
  boas_vindas: string;
  opcoes: OpcaoDoMenu[];
}

export type ResultadoDaValidacao =
  | { ok: true; menu: MenuSemIa }
  | { ok: false; problemas: string[] };

function objeto(valor: unknown): Record<string, unknown> | null {
  return valor !== null && typeof valor === "object" && !Array.isArray(valor)
    ? (valor as Record<string, unknown>)
    : null;
}

/**
 * Valida a configuração e devolve o menu normalizado, ou a lista de problemas.
 *
 * Nunca lança: é chamada na leitura de um jsonb escrito por fora e na tela que
 * o edita, e um throw em qualquer das duas viraria 500 no caminho da mensagem.
 */
export function validarMenu(dados: unknown): ResultadoDaValidacao {
  const bloco = objeto(dados);
  if (!bloco) return { ok: false, problemas: ["a configuração do menu não é um objeto"] };

  const lido = menuSemIaSchema.safeParse(bloco);
  if (!lido.success) {
    return {
      ok: false,
      problemas: lido.error.issues.map((problema) => {
        const caminho = problema.path.join(".");
        return caminho === "" ? problema.message : `${caminho}: ${problema.message}`;
      }),
    };
  }

  const problemas: string[] = [];
  const rotulos = new Set<string>();
  for (const [indice, opcao] of lido.data.opcoes.entries()) {
    const posicao = indice + 1;
    const rotulo = opcao.rotulo.toLocaleLowerCase("pt-BR");
    if (rotulos.has(rotulo)) {
      problemas.push(`opcoes.${indice}.rotulo: "${opcao.rotulo}" repete uma opção anterior`);
    }
    rotulos.add(rotulo);

    // A URL precisa ser de um tipo que o envio SAIBA entregar. A régua é a
    // mesma do passo de mídia do follow-up — uma segunda classificação aqui
    // divergiria da que o envio usa no primeiro cliente.
    if (opcao.tipo === "arquivo") {
      const classificacao = classificarMidiaComLegenda(opcao.media_url);
      if (!classificacao.ok) {
        problemas.push(`opcoes.${indice}.media_url (opção ${posicao}): ${classificacao.motivo}`);
      }
    }
  }

  if (problemas.length > 0) return { ok: false, problemas };

  const menu: MenuSemIa = {
    ativa: lido.data.ativa === true,
    boas_vindas: lido.data.boas_vindas,
    opcoes: lido.data.opcoes,
  };
  return { ok: true, menu };
}

/**
 * O menu declarado em `organizations.settings`, ou `null`.
 *
 * Ausente, torto ou inválido = `null` (menu desligado). Não lança.
 */
export function menuDeclarado(settings: unknown): MenuSemIa | null {
  const raiz = objeto(settings);
  const bloco = objeto(raiz?.[CHAVE_NO_SETTINGS]);
  if (!bloco) return null;
  const resultado = validarMenu(bloco);
  return resultado.ok ? resultado.menu : null;
}

/**
 * Atalho para quem só precisa saber se o menu toma a próxima mensagem: a chave
 * ligada E o menu válido. Menu ligado sem opção válida nenhuma não é menu.
 */
export function menuLigado(settings: unknown): boolean {
  return menuDeclarado(settings)?.ativa === true;
}

/** O número que o cliente digitou: `"2"`, `"2."`, `"2)"` e `" 2 "` valem. */
const NUMERO_DA_RESPOSTA = /^\s*(\d{1,2})\s*[.)\-:]?\s*$/u;

/**
 * A opção que o cliente escolheu pelo NÚMERO, ou `null`.
 *
 * Só o número — e é escolha: aceitar "quero falar com o financeiro" faria a
 * decisão depender de casar texto livre (que é justamente o trabalho da IA, e
 * este menu existe para não gastar token). Frase com número no meio ("sou o
 * número 2") também não vale: quem responde ao menu responde o número.
 */
export function opcaoPeloNumero(menu: MenuSemIa, texto: string | null | undefined): OpcaoDoMenu | null {
  const casado = NUMERO_DA_RESPOSTA.exec(texto ?? "");
  if (!casado) return null;
  const posicao = Number(casado[1]);
  if (!Number.isInteger(posicao) || posicao < 1 || posicao > menu.opcoes.length) return null;
  return menu.opcoes[posicao - 1] ?? null;
}

/**
 * As opções como o cliente as lê: `1 - Financeiro`, uma por linha.
 *
 * A posição no array É o número — não há como a linha impressa discordar da
 * leitura da resposta.
 */
export function renderizarOpcoes(menu: MenuSemIa): string {
  return menu.opcoes.map((opcao, indice) => `${indice + 1} - ${opcao.rotulo}`).join("\n");
}

/** A mensagem de gatilho completa: boas-vindas e as opções numeradas. */
export function renderizarMenu(menu: MenuSemIa): string {
  return `${menu.boas_vindas}\n\n${renderizarOpcoes(menu)}`;
}
