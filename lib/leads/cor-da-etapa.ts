/**
 * A COR DA ETAPA DO FUNIL — a paleta que a tela oferece e a forma que o banco
 * aceita (issue #4802, item 2 de 5).
 *
 * ─── Por que esta fatia existe ──────────────────────────────────────────────
 *
 * `crm_stages.color` está no banco desde o começo (`supabase/baseline.sql`,
 * `color text` com o CHECK `crm_stages_color_format` = `^#[0-9a-fA-F]{6}$`) e o
 * quadro JÁ a pinta: `components/kanban/StageColumn.tsx` lê `stage.color` do
 * payload do quadro (`select *` em `crm_stages`) e pinta o ponto do cabeçalho.
 * O que não existia era ESCRITA: nenhuma tela, nenhuma rota e nenhuma operação
 * de etapa conheciam o campo. O caminho era exportar o funil, editar o arquivo
 * e importar de novo.
 *
 * ─── Por que a paleta das etiquetas, e não uma lista nova ───────────────────
 *
 * Um seletor livre (ou uma segunda fileira de hex) daria ao produto dois
 * vocabulários de cor para a mesma pergunta — e a tela de Tags já tinha
 * resolvido esse problema uma vez (#1271/#2373): os oito tons de
 * `PALETA_DE_ETIQUETAS` foram ESCOLHIDOS POR BUSCA com as réguas de
 * `lib/branding/contraste.ts`, maximizando o pior par:
 *
 *   - pior separação a olho nu (OKLab):  0,1192  (piso do repo: 0,10)
 *   - pior separação sob dicromacia:     0,0576  (piso do repo: 0,05)
 *   - pior contraste do texto do chip:   4,75    (piso WCAG: 4,5)
 *
 * Reusar é a única forma de a etapa e a etiqueta do MESMO contato não saírem de
 * tons diferentes para a mesma ideia. A paleta é reexportada, não copiada: um
 * ajuste lá alcança as duas telas, e o teste desta fatia reprova se as listas
 * divergirem.
 *
 * ─── O contraste, medido nas duas pontas ────────────────────────────────────
 *
 * O ponto da etapa no quadro tem 8 px e NÃO carrega texto: o nome da coluna
 * continua em `text-text` ao lado dele. Isso importa porque a paleta, medida
 * contra as superfícies do produto, não passa do piso de 3,0 (componente) em
 * TODOS os tons nos DOIS temas — medido com `razaoDeContraste`:
 *
 *   tom            surface clara   elevated clara   surface escura   elevated escura
 *   #ffe629            1,26             1,14             13,49            11,99
 *   #ffb224            1,80             1,63              9,46             8,41
 *   #cf3716            4,99             4,50              3,42             3,04
 *   #00655a            6,98             6,29              2,45             2,17
 *   #0091ff            3,23             2,92              5,28             4,69
 *   #3e63dd            5,21             4,69              3,28             2,91
 *   #ab4aba            4,75             4,28              3,59             3,19
 *   #6f6f6f            5,02             4,53              3,40             3,02
 *
 * Ou seja: exigir 3,0 do PONTO nos dois temas deixaria só três tons (vermelho,
 * roxo, cinza) e um funil de seis etapas voltaria a ter colunas iguais. A saída
 * é a regra que o produto já escreveu para si: **cor nunca é o único portador
 * de significado** — o nome da etapa está sempre lá, e o ponto é reforço.
 *
 * Onde há TEXTO sobre a cor — a prévia desta tela e o chip de etiqueta — a
 * frente é CALCULADA por `escolheAFrente` (piso 4,5, #2373), nunca escolhida
 * por quem pinta: o pior par da paleta nesse contrato é 4,75 (roxo). Por isso
 * `frenteSobreACor` existe aqui: para que a tela não invente branco fixo.
 *
 * ─── O que NÃO é validado aqui ─────────────────────────────────────────────
 *
 * A FORMA (`#rrggbb`) é cobrada na borda (Zod da rota), no banco (CHECK) e nesta
 * leitura. A PERTINÊNCIA À PALETA não é cobrada em lugar nenhum, de propósito: a
 * coluna já tem valor gravado por fora em instalações que importaram o funil com
 * outro tom, e recusar a leitura pintaria de "sem cor" o que o quadro pinta. A
 * paleta é o que a TELA oferece, não o que o banco aceita.
 */
import { escolheAFrente } from "@/lib/branding/contraste";
import { ehHexValido, normalizarHex } from "@/lib/branding/rampa";
import { NOME_DO_TOM, PALETA_DE_ETIQUETAS } from "@/lib/tags/cor-da-etiqueta";

/**
 * Os tons que a tela de etapas oferece. É a MESMA referência de
 * `PALETA_DE_ETIQUETAS` — não uma cópia — para que os dois vocabulários não
 * possam divergir. `tests/unit/cor-da-etapa-paleta.test.ts` cobra a identidade
 * (mesma ordem, mesmos oito tons) e o nome de cada um.
 */
export const PALETA_DE_ETAPAS: readonly string[] = PALETA_DE_ETIQUETAS;

/**
 * O nome de cada tom, pelo mesmo mapa da etiqueta. Existe como apelido nomeado
 * para a tela de etapas não importar de `lib/tags` (que é o vocabulário de
 * outra feature) só para rotular um círculo.
 */
export const NOME_DO_TOM_DA_ETAPA: Readonly<Record<string, string>> = NOME_DO_TOM;

/**
 * A cor como o banco aceita — minúscula, `#rrggbb` — ou `null` para "sem cor".
 *
 * `null` é o valor de hoje: etapa sem cor nasce assim (a coluna é nullable) e o
 * quadro pinta o ponto com o token `text-muted/40`. "Padrão" no seletor grava
 * exatamente isso.
 *
 * Degrada para `null` em vez de lançar pela mesma razão de
 * `normalizarCorDeEtiqueta`: cor malformada não pode derrubar a tela de
 * configuração inteira. Quem GRAVA valida antes de chamar (Zod da rota), e a
 * operação de etapa recusa com frase em português — aqui já é leitura.
 */
export function normalizarCorDaEtapa(valor: unknown): string | null {
  if (typeof valor !== "string") return null;
  const bruto = valor.trim();
  if (bruto === "" || !ehHexValido(bruto)) return null;
  try {
    return normalizarHex(bruto);
  } catch {
    // `ehHexValido` já filtrou; o ramo existe para o dia em que `rampa` mudar
    // de régua — cor malformada degrada para "sem cor", nunca para erro.
    return null;
  }
}

/** `true` só para cor que o banco aceita depois de normalizada. */
export function corDaEtapaValida(valor: unknown): valor is string {
  return normalizarCorDaEtapa(valor) !== null;
}

/**
 * A frente (preto ou branco) que a régua escolhe sobre a cor — o MESMO contrato
 * de `estiloDoChip` (piso 4,5, #2373). A prévia e qualquer texto sobre a cor da
 * etapa passam por aqui; pintar `#ffffff` fixo é o defeito que o teste do chip
 * reprova tom por tom.
 */
export function frenteSobreACor(cor: string): string {
  return escolheAFrente(cor);
}
