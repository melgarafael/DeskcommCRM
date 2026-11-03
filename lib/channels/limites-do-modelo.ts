/**
 * OS LIMITES DO MODELO DE MENSAGEM, medidos ANTES do envio (#3635).
 *
 * ─── Por que existe ────────────────────────────────────────────────────────
 *
 * O formulário aceitava corpo de qualquer tamanho e variável `{{n}}` sem
 * amostra. Quem reprovava era a Meta — horas depois, com um erro genérico que
 * não dizia QUAL campo estourou nem QUAL variável ficou sem exemplo. O
 * operador corrigia por tentativa, e cada tentativa custa um ciclo de revisão.
 *
 * Aqui os limites são declarados UMA vez, com a fonte ao lado, e devolvidos
 * campo a campo: `{ campo, atual, limite, excesso }`. A tela usa os mesmos
 * números para o contador, e a rota para recusar antes de falar com a
 * plataforma. Duas cópias envelheceriam separadas — e o lado que envelhece
 * passaria a recusar o que a plataforma aceita.
 *
 * ─── A fonte de cada número ────────────────────────────────────────────────
 *
 * Meta for Developers, "Template components" (WhatsApp Business Platform):
 *
 *   · Body — `<BODY_TEXT>`: "Maximum of 1024 characters."
 *   · Text header — `<HEADER_TEXT>`: "Maximum 60 characters."
 *   · Footer — `<TEXT>`: "60 characters maximum."
 *   · Botão (resposta rápida, telefone e URL) — `<TEXT>`: "25 characters maximum."
 *   · Botão de URL — `<URL>`: "2000 characters maximum."
 *   · Quantidade: até 10 botões por modelo (no máximo 2 de link e 1 de telefone).
 *   · Imagem do cabeçalho: 5 MB, JPG/PNG (limites de mídia da plataforma).
 *
 * Nenhum é número redondo escolhido a dedo. Mudou na plataforma? Muda AQUI, e
 * a tela e a rota acompanham — é para isso que estão num módulo só.
 *
 * Módulo PURO: sem I/O, sem banco, sem `fetch`. O tradutor entra por parâmetro.
 */

/** Os limites da plataforma, por campo do modelo. */
export const LIMITES_DO_MODELO = {
  /** Corpo da mensagem. */
  corpo: 1024,
  /** Cabeçalho de TEXTO (o de mídia não tem texto). */
  cabecalhoTexto: 60,
  rodape: 60,
  /**
   * Rótulo de um botão — vale para resposta rápida, link e telefone.
   */
  textoDoBotao: 25,
  urlDoBotao: 2000,
  /**
   * Teto de botões do MODELO. É o da plataforma (10), e não o da tela: um
   * modelo criado no Gerenciador do WhatsApp com 5 botões é válido, e recusá-lo
   * aqui impediria de editá-lo pelo CRM.
   */
  botoes: 10,
  /** Imagem do cabeçalho, em bytes (5 MB). */
  imagemDoCabecalho: 5 * 1024 * 1024,
} as const;

/** Os campos que a régua mede. `exemploDaVariavel` não é tamanho: é exigência. */
export type CampoDoModelo = keyof typeof LIMITES_DO_MODELO | "exemploDaVariavel";

/**
 * Um problema do modelo. Sempre no formato `{ campo, atual, limite, excesso }`,
 * e a lista vazia significa "pode enviar".
 */
export interface ProblemaDoModelo {
  campo: CampoDoModelo;
  /** O que o modelo tem hoje, na unidade do campo (caracteres, bytes, itens). */
  atual: number;
  limite: number;
  /** `atual - limite`, sempre positivo. */
  excesso: number;
  /** Índice 1-based do botão, quando o problema é de UM botão. */
  botao?: number;
  /** Número da variável `{{n}}`, quando o problema é de UMA variável. */
  variavel?: number;
}

/** O que se mede: o texto que vai ser enviado à plataforma. */
export interface ModeloParaMedir {
  corpo?: string | null;
  cabecalhoTexto?: string | null;
  /** Só quando o tamanho do arquivo é conhecido (o upload já sabe). */
  cabecalhoImagemBytes?: number | null;
  rodape?: string | null;
  botoes?: ReadonlyArray<{ texto?: string | null; url?: string | null }> | null;
  /** As amostras na ordem de `{{1}}`… (`example.body_text[0]`). */
  exemplos?: ReadonlyArray<string | null | undefined> | null;
}

const tamanho = (texto: string | null | undefined): number => (texto ?? "").length;

/**
 * Os números de variável que o corpo usa, DISTINTOS e em ordem crescente.
 *
 * `{{ 1 }}` com espaço conta: a plataforma aceita as duas formas, e tratar a
 * espaçada como texto literal esconderia a variável de quem precisa preencher.
 */
export function numerosDoCorpo(texto: string | null | undefined): number[] {
  const achados = [...(texto ?? "").matchAll(/\{\{\s*(\d+)\s*\}\}/g)].map((m) => Number(m[1]));
  return [...new Set(achados)].sort((a, b) => a - b);
}

/**
 * Os números de variável que estão SEM exemplo.
 *
 * A lista de amostras é POSICIONAL: `{{1}}` recebe `exemplos[0]`, `{{2}}`
 * recebe `exemplos[1]`, e assim por diante. Por isso a conferência vai de 1 até
 * a MAIOR variável — um corpo com `{{1}}` e `{{3}}` precisa de três amostras, e
 * a do meio (a salteada) é apontada pelo próprio número, que é o que o operador
 * vê na tela.
 *
 * Amostra em branco conta como ausente: a revisão recusa exemplo vazio, e um
 * campo que ficou só com espaços é o mesmo vazio com outra cara.
 */
export function variaveisSemExemplo(
  corpo: string | null | undefined,
  exemplos: ReadonlyArray<string | null | undefined> | null | undefined,
): number[] {
  const numeros = numerosDoCorpo(corpo);
  if (numeros.length === 0) return [];
  const maior = numeros[numeros.length - 1]!;
  const faltando: number[] = [];
  for (let n = 1; n <= maior; n += 1) {
    const amostra = exemplos?.[n - 1];
    if (typeof amostra !== "string" || amostra.trim() === "") faltando.push(n);
  }
  return faltando;
}

/**
 * TUDO o que a plataforma recusaria — ou lista vazia.
 *
 * A ordem é a da leitura do formulário (de cima para baixo), porque a rota
 * devolve O PRIMEIRO: apontar o corpo quando o rodapé também estourou é o que
 * faz o operador corrigir de um em um, em vez de adivinhar qual é o pior.
 */
export function problemasDoModelo(modelo: ModeloParaMedir): ProblemaDoModelo[] {
  const problemas: ProblemaDoModelo[] = [];

  const medir = (campo: keyof typeof LIMITES_DO_MODELO, atual: number) => {
    const limite = LIMITES_DO_MODELO[campo];
    if (atual > limite) problemas.push({ campo, atual, limite, excesso: atual - limite });
  };

  medir("corpo", tamanho(modelo.corpo));
  medir("cabecalhoTexto", tamanho(modelo.cabecalhoTexto));
  if (typeof modelo.cabecalhoImagemBytes === "number") {
    medir("imagemDoCabecalho", modelo.cabecalhoImagemBytes);
  }
  medir("rodape", tamanho(modelo.rodape));

  const botoes = modelo.botoes ?? [];
  botoes.forEach((botao, i) => {
    const indice = i + 1;
    const limiteDoTexto = LIMITES_DO_MODELO.textoDoBotao;
    const texto = tamanho(botao.texto);
    if (texto > limiteDoTexto) {
      problemas.push({
        campo: "textoDoBotao",
        atual: texto,
        limite: limiteDoTexto,
        excesso: texto - limiteDoTexto,
        botao: indice,
      });
    }
    const url = botao.url;
    if (typeof url === "string") {
      const limiteDaUrl = LIMITES_DO_MODELO.urlDoBotao;
      if (url.length > limiteDaUrl) {
        problemas.push({
          campo: "urlDoBotao",
          atual: url.length,
          limite: limiteDaUrl,
          excesso: url.length - limiteDaUrl,
          botao: indice,
        });
      }
    }
  });
  medir("botoes", botoes.length);

  // Por último a exigência de amostra: ela não é tamanho, mas também barra o
  // envio — e é a que mais reprovava, porque o formulário nem pedia o exemplo.
  for (const variavel of variaveisSemExemplo(modelo.corpo, modelo.exemplos)) {
    problemas.push({ campo: "exemploDaVariavel", atual: 0, limite: 1, excesso: 1, variavel });
  }

  return problemas;
}

/**
 * A frase que vai para a tela, no idioma de quem está lendo.
 *
 * A CHAVE é o texto em português (a convenção de `lib/i18n/dicionario.ts`), e o
 * tradutor entra por parâmetro para este módulo continuar puro — a rota passa o
 * `traduzir` do idioma da sessão, a tela passa o `t` do hook.
 */
const MENSAGENS: Record<CampoDoModelo, string> = {
  corpo: "O corpo do modelo tem {atual} caracteres e o limite da Meta é {limite}.",
  cabecalhoTexto: "O cabeçalho de texto tem {atual} caracteres e o limite da Meta é {limite}.",
  imagemDoCabecalho: "A imagem do cabeçalho passa do limite de 5 MB da Meta.",
  rodape: "O rodapé tem {atual} caracteres e o limite da Meta é {limite}.",
  textoDoBotao: "O texto do botão {botao} tem {atual} caracteres e o limite da Meta é {limite}.",
  urlDoBotao: "O endereço do botão {botao} tem {atual} caracteres e o limite da Meta é {limite}.",
  botoes: "O modelo tem {atual} botões e o limite da Meta é {limite}.",
  exemploDaVariavel:
    "A variável {variavel} do corpo está sem exemplo. A revisão da Meta exige um valor de amostra para cada variável.",
};

/** A mensagem do problema, traduzida pelo tradutor recebido. */
export function textoDoProblema(
  problema: ProblemaDoModelo,
  traduzir: (texto: string) => string,
): string {
  return traduzir(MENSAGENS[problema.campo])
    .replace("{atual}", String(problema.atual))
    .replace("{limite}", String(problema.limite))
    .replace("{botao}", String(problema.botao ?? 0))
    .replace("{variavel}", String(problema.variavel ?? 0));
}
