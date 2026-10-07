/**
 * A COR DA ETIQUETA — paleta, validação e leitura (issue #1271, fatia S6 da #852).
 *
 * ─── Por que paleta, e não seletor livre ────────────────────────────────────
 *
 * Um seletor livre recria em cada instalação o problema que a tela de Tags veio
 * arrumar: doze tons de verde e ninguém sabendo qual é qual. A paleta aqui não é
 * gosto — foi ESCOLHIDA POR BUSCA, com as duas réguas que já existem neste repo
 * (`lib/branding/contraste.ts`), maximizando o pior par:
 *
 *   - pior separação a olho nu (OKLab):     0,1192   (piso do repo: 0,10)
 *   - pior separação sob dicromacia:        0,0576   (piso do repo: 0,05)
 *   - pior contraste do texto do chip:      4,75     (piso WCAG: 4,5)
 *
 * ─── Verde-água e Vermelho com texto BRANCO (issue #2373) ───────────────────
 *
 * Nos tons originais o WCAG 2 escolhia o PRETO para o verde (6,835) e para o
 * vermelho (5,433) — ambos passavam do piso, e ainda assim a autora da #2373
 * escreveu "fundo escuro e texto preto, quase ilegíveis". O mantainer mediu os
 * mesmos pares no APCA (rascunho do WCAG 3, |Lc|, medida DELE, implementação
 * própria 0.0.98G) e o branco vence: 62 e 70 contra 47 e 39. A escolha da
 * régua era o defeito, não a cor.
 *
 * O branco, porém, só passa de 4,5 num tom mais escuro (luz relativa ≤
 * 0,17912, onde `max(branco, preto)` ≥ 4,582671). Então os dois tons foram
 * ESCURECIDOS por busca em OKLCH — mesmo matiz, croma limitada pela gama,
 * varrendo a luz relativa e escolhendo o tom mais claro que mantém os dois
 * pisos de separação — e não inventados a olho:
 *
 *   - `#12a594` → `#00655a` (luz 0,2918 → 0,1005): frente `#ffffff`, 6,979
 *   - `#e54d2e` → `#cf3716` (luz 0,2216 → 0,1606): frente `#ffffff`, 4,987
 *
 * O pior par continua acima dos dois pisos (0,1192 a olho nu, 0,0576 sob
 * dicromacia) e o pior contraste de texto da paleta continua em 4,751, no roxo
 * — que não mudou. Nomes iguais, fileira igual: quem tinha "Verde-água" e
 * "Vermelho" continua com as mesmas etiquetas, agora legíveis.
 *
 * A régua do repo é a que decide o texto sobre a cor (`escolheAFrente`, com o
 * piso de 4,5 declarado como contrato — issue #2373), e a mesma régua existe
 * porque sob deuteranopia vermelho e verde colapsam: escolher oito tons a olho
 * reprovaria, e a etiqueta ilegível só apareceria na tela de quem tem a
 * limitação — ou de quem tem a limitação e um cliente olhando.
 *
 * O texto do chip é escolhido pelo sistema, nunca por quem escolhe a cor: a cor
 * é decoração e reforço; o NOME da etiqueta é a informação. Cor nunca é o único
 * portador de significado neste produto — pelo mesmo motivo, a paleta é fixa:
 * cor livre é a única forma de uma etiqueta virar ilegível por decisão humana.
 *
 * ─── Onde a validação mora ──────────────────────────────────────────────────
 *
 * A FORMA (`#rrggbb`) é validada na borda (`lib/schemas/tags.ts`), no banco
 * (`fn_vocabulario_de_tags_operar`, `cor_invalida`) e aqui na leitura. A
 * PERTINÊNCIA À PALETA não é validada em lugar nenhum, de propósito: uma
 * instalação que queira outro tom não precisa de migration — e o banco não deve
 * saber o que é decoração de tela.
 *
 * A única exceção é `TONS_SUBSTITUIDOS`: os dois tons antigos da #2373 são
 * lidos como os novos. Como a borda (`lib/schemas/tags.ts`) também normaliza
 * por aqui, quem mandar `#12a594` pela API passa a ter `#00655a` gravado.
 */
import { escolheAFrente } from "@/lib/branding/contraste";
import { ehHexValido, normalizarHex } from "@/lib/branding/rampa";

/**
 * Os oito tons, medidos. A ordem é a da fileira na tela: os dois claros (amarelo
 * e âmbar) abrem, porque são os que mais se aproximam entre si — e é na tela,
 * lado a lado, que a diferença de 0,0976 sob dicromacia precisa ficar visível
 * para quem escolhe.
 */
export const PALETA_DE_ETIQUETAS: readonly string[] = [
  "#ffe629",
  "#ffb224",
  "#cf3716",
  "#00655a",
  "#0091ff",
  "#3e63dd",
  "#ab4aba",
  "#6f6f6f",
];

/**
 * Os tons escurecidos na #2373, de → para. A cor é gravada como hex, então a
 * etiqueta pintada antes da troca continua com o tom antigo no banco; lê-la
 * aqui como o tom novo dá texto branco a ela sem migration (chip, ponto, rota
 * de cores e a fileira da tela de Tags passam todos por esta leitura).
 */
const TONS_SUBSTITUIDOS: Readonly<Record<string, string>> = {
  "#12a594": "#00655a",
  "#e54d2e": "#cf3716",
};

/** Etiqueta normalizada → cor. A chave é sempre `chaveDaEtiqueta`. */
export type CoresPorEtiqueta = Readonly<Record<string, string>>;

/**
 * A chave canônica de comparação, a MESMA da leitura do vocabulário no banco
 * (`lower(btrim(tag))`) e do filtro de contatos (`lib/contacts/tag-normalizada`).
 * Sem isso, "VIP" na conversa e "vip" no vocabulário seriam duas etiquetas para
 * o chip — e uma delas sairia cinza.
 */
export function chaveDaEtiqueta(tag: string): string {
  return tag.trim().toLowerCase();
}

/**
 * A forma que o banco aceita: cerquilha e SEIS dígitos, minúsculo. Aceita
 * `#abc` e a forma sem cerquilha na ENTRADA (normaliza), porque a leitura
 * precisa tolerar o que já estiver gravado — `settings.tags` é JSON editável à
 * mão, e uma cor gravada por fora não é motivo para a tela inteira quebrar.
 */
export function normalizarCorDeEtiqueta(valor: unknown): string | null {
  if (typeof valor !== "string") return null;
  const bruto = valor.trim();
  if (bruto === "" || !ehHexValido(bruto)) return null;
  try {
    const hex = normalizarHex(bruto);
    return TONS_SUBSTITUIDOS[hex] ?? hex;
  } catch {
    // `ehHexValido` já filtrou; este ramo existe para o dia em que `rampa`
    // mudar de régua — cor malformada degrada para "sem cor", nunca para erro.
    return null;
  }
}

/** `true` só para cor que o banco aceita depois de normalizada. */
export function corDeEtiquetaValida(valor: unknown): valor is string {
  return normalizarCorDeEtiqueta(valor) !== null;
}

/**
 * O vocabulário cru de `organizations.settings` → as entradas que TÊM cor.
 *
 * Lê as DUAS formas de entrada que a organização pode ter gravado, porque as
 * duas existem no banco desde a 0264: string (a lista antiga, semeada) e objeto
 * (`{"tag": "vip", "cor": "#0091ff"}`). Entrada sem cor (ou cor malformada) fica
 * de fora — quem não está na lista sai cinza, que é o estado de quem nunca
 * escolheu cor.
 *
 * Fonte única da leitura: a rota `GET /api/v1/tags/cores` devolve esta lista e o
 * mapa do chip sai dela. Duas interpretações de "etiqueta com cor" divergiriam no
 * primeiro caso de borda (nome com espaço, cor em maiúscula) e a tela mostraria
 * cor para quem o servidor não mostrasse.
 *
 * Função PURA: recebe o `settings` já lido, não toca em banco nem em rede.
 */
export function etiquetasComCor(settings: unknown): { tag: string; cor: string }[] {
  const lista = (settings as Record<string, unknown> | null | undefined)?.["tags"];
  if (!Array.isArray(lista)) return [];

  const entradas: { tag: string; cor: string }[] = [];
  for (const entrada of lista) {
    if (typeof entrada !== "object" || entrada === null) continue;
    const objeto = entrada as Record<string, unknown>;
    if (typeof objeto["tag"] !== "string") continue;
    const nome = objeto["tag"].trim();
    const cor = normalizarCorDeEtiqueta(objeto["cor"]);
    if (nome === "" || cor === null) continue;
    entradas.push({ tag: nome, cor });
  }
  return entradas;
}

/** O mesmo vocabulário, agora indexado pela chave canônica do chip. */
export function coresDoVocabulario(settings: unknown): CoresPorEtiqueta {
  const mapa: Record<string, string> = {};
  for (const { tag, cor } of etiquetasComCor(settings)) {
    mapa[chaveDaEtiqueta(tag)] = cor;
  }
  return mapa;
}

/**
 * O estilo do chip quando a etiqueta tem cor: fundo na cor, texto escolhido por
 * `escolheAFrente` (a régua, com piso de 4,5 — issue #2373) e borda da mesma
 * cor (o chip do design system já tem borda; deixá-la no token padrão criaria
 * um aro claro em torno de um fundo escuro — medido na revisão visual da tela
 * de Tags).
 *
 * A frente NUNCA vem daqui: só a régua escolhe preto ou branco, e este módulo
 * se recusa a pintar qualquer cor que `normalizarCorDeEtiqueta` não aceite.
 * Pintar `#ffffff` fixo (ou deixar o texto herdar `text-text-muted`) é o defeito
 * da #2373 — "fundo escuro com texto preto" —, e
 * `tests/unit/chip-contraste-da-etiqueta.test.ts` reprova sob essa sabotagem,
 * tom por tom, com o nome do tom na falha.
 *
 * `undefined` quando não há cor: aí o chip sai com o token padrão, exatamente o
 * que já existia antes desta fatia.
 */
export function estiloDoChip(cor: string | null | undefined): React.CSSProperties | undefined {
  const normalizada = normalizarCorDeEtiqueta(cor);
  if (normalizada === null) return undefined;
  return {
    backgroundColor: normalizada,
    borderColor: normalizada,
    color: escolheAFrente(normalizada),
  };
}
