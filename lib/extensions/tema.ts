/**
 * O GANCHO de tema das extensões declarativas — o único ponto que transforma
 * uma contribuição de tema num bloco de CSS que o navegador executa.
 *
 * ── A condição do DONO está nesta assinatura ────────────────────────────────
 *
 * A issue #1095 exige que um tema de extensão NUNCA mude a tela de quem não o
 * escolheu. A decisão mora no ATALHO que este módulo expõe: receber `null` (=
 * a organização não escolheu o tema da extensão) devolve `{ css: null }` — o
 * comportamento atual, byte a byte, para quem não escolheu. Quem escolheu
 * recebe o bloco escopado por `[data-tema-extensao]`, que só existe quando o
 * `/app` emite o marcador. É por isso que o gancho só nasce com o teste
 * `tests/unit/extensao-tema-nao-vaza-para-quem-nao-escolheu.test.ts`.
 *
 * ── Por que `claro`/`escuro` como dois mapas ────────────────────────────────
 *
 * O `app/globals.css` declara as MESMAS custom properties em `:root` (claro) e
 * em `[data-theme="dark"]` (escuro) — fundo, superfície e texto têm valores
 * distintos por tema. Um mapa plano por token não conseguiria dizer "o fundo
 * claro é #faf9f6 e o escuro é #161510" sem inventar nome de token. Dois mapas,
 * um por tema, espelham exatamente como o produto já separa os dois blocos. Os
 * 11 stops da rampa (`--color-accent-NNN`) têm o mesmo valor nos dois temas e
 * podem ir só no `claro`. Todo o resto (fundo, superfície, texto, borda e os
 * papéis `--color-accent`/`-fg`/`-soft`/`-hover`) muda com o tema no
 * `globals.css`, e por isso o que for declarado no `claro` tem de vir também no
 * `escuro`: o bloco claro (`body:has([data-tema-extensao])`) casa também no
 * modo escuro, e um `--color-bg` só no claro deixaria o fundo claro no escuro.
 *
 * ── A régua de FORMA é a do branding, não uma cópia ─────────────────────────
 *
 * Cada valor pode ser `#rrggbb`/`#rgb`/`rgb()`/`rgba()`/`var(--nome)` — a MESMA
 * allowlist de forma de `lib/branding/formas-de-valor.ts`, que `css.ts` também
 * usa. Um valor fora dessa forma é recusado AQUI e no manifesto (`esquemaDa
 * ContribuicaoDeTema`): duas validações, uma régua.
 */

import { z } from "zod";

import { ehFormaDeValorPermitida, ehNomeDeToken } from "@/lib/branding/formas-de-valor";

/**
 * As paletas que uma extensão pode oferecer como tema. São as MESMAS cinco do
 * laboratório `app/design/lib/tokens.ts` (PALETTES), vertidas para cá como a
 * lista FECHADA de chave — o "gancho" referencia uma paleta, o valor de cada
 * token é validado pela régua de forma. O default do produto é `sage`.
 */
export const PALETAS_DE_TEMA = ["sage", "clay", "mist", "plum", "olive"] as const;
export type PaletaDeTema = (typeof PALETAS_DE_TEMA)[number];

export function ehPaletaDeTema(valor: unknown): valor is PaletaDeTema {
  return (PALETAS_DE_TEMA as readonly unknown[]).includes(valor);
}

/**
 * A allowlist de CHAVE do tema de extensão: só estes tokens podem ser
 * sobrescritos. É o subconjunto do `globals.css` que define o "visual" — as
 * superfícies, o texto, as bordas e a rampa de accent — SEM os tokens de estado
 * (`--color-success` e irmãs) e sem os neutros, que têm par por tema e seriam
 * os primeiros a quebrar contraste se uma extensão os empurrasse cego.
 *
 * O valor de cada chave, quando o autor fornece, ainda passa pela régua de
 * forma — a allowlist de nome não dispensa a de valor (mesmo argumento do
 * cabeçalho do `css.ts`: nome aprovado com valor malformado é porta de CSS).
 */
export const CHAVES_DE_TOKEN_DO_TEMA = [
  "--color-bg",
  "--color-surface",
  "--color-surface-elevated",
  "--color-text",
  "--color-text-muted",
  "--color-text-subtle",
  "--color-border",
  "--color-border-strong",
  "--color-accent-50",
  "--color-accent-100",
  "--color-accent-200",
  "--color-accent-300",
  "--color-accent-400",
  "--color-accent-500",
  "--color-accent-600",
  "--color-accent-700",
  "--color-accent-800",
  "--color-accent-900",
  "--color-accent-950",
  "--color-accent",
  "--color-accent-fg",
  "--color-accent-soft",
  "--color-accent-hover",
] as const;
export type ChaveDeTokenDoTema = (typeof CHAVES_DE_TOKEN_DO_TEMA)[number];

type TokenMap = Partial<Record<ChaveDeTokenDoTema, string>>;

const mapDeTokens = () =>
  z
    .object(
      Object.fromEntries(
        CHAVES_DE_TOKEN_DO_TEMA.map((chave) => [
          chave,
          z
            .string()
            .min(1)
            .refine(ehFormaDeValorPermitida, {
              message: "valor do token fora das formas permitidas (#rrggbb, rgb(), rgba(), var(--…))",
            })
            .optional(),
        ]),
      ),
    )
    .strict();

/**
 * O esquema da contribuição `contributions.theme`. Vive AQUI, e o manifesto
 * (`lib/extensions/manifest.ts`) o importa — uma só régua para o que o pacote
 * declara e para o que o host revalida ao ler o artefato gravado.
 */
/**
 * As chaves do `claro` que mudam com o tema e não têm par no `escuro` — as que
 * vazariam o valor claro para o modo escuro (ver o cabeçalho). Os stops da
 * rampa ficam de fora porque o `globals.css` dá a eles o mesmo valor nos dois.
 */
export function chavesSemParNoEscuro(tema: {
  readonly claro: Readonly<Record<string, unknown>>;
  readonly escuro: Readonly<Record<string, unknown>>;
}): string[] {
  return Object.keys(tema.claro).filter(
    (chave) => !/^--color-accent-\d+$/.test(chave) && !(chave in tema.escuro),
  );
}

export const esquemaDaContribuicaoDeTema = z
  .object({
    palette: z.enum(PALETAS_DE_TEMA),
    claro: mapDeTokens(),
    escuro: mapDeTokens(),
  })
  .strict()
  .superRefine((tema, ctx) => {
    const semPar = chavesSemParNoEscuro(tema);
    if (semPar.length > 0) {
      ctx.addIssue({
        code: "custom",
        path: ["escuro"],
        message: `token declarado no claro sem valor no escuro: ${semPar.join(", ")}`,
      });
    }
  });

export type TemaDeExtensao = z.infer<typeof esquemaDaContribuicaoDeTema>;

export function ehTemaDeExtensao(valor: unknown): valor is TemaDeExtensao {
  return esquemaDaContribuicaoDeTema.safeParse(valor).success;
}

/**
 * O escopo do tema da ORGANIZAÇÃO: o mesmo padrão de `ESCOPO_DA_ORGANIZACAO`
 * (`lib/branding/css.ts`), com o marcador próprio `[data-tema-extensao]` —
 * presente no `/app` SÓ quando a organização escolheu um tema de extensão.
 * Quem não escolheu não tem o marcador, a regra não casa nada, e o token vem
 * do `globals.css` — a tela é idêntica à de hoje.
 */
export const ESCOPO_DO_TEMA_DA_ORGANIZACAO = [
  ["body:has([data-tema-extensao])", "claro"],
  ['[data-theme="dark"] body:has([data-tema-extensao])', "escuro"],
] as const;

/** Sequências suspeitas no texto já montado — mesmo freio do `css.ts`. */
const SEQUENCIAS_SUSPEITAS = ["<", ";}"] as const;

function paraDiagnostico(valor: string): string {
  const curto = valor.length > 32 ? `${valor.slice(0, 32)}…` : valor;
  return curto.replace(/#[0-9a-fA-F]{3,8}/g, "#…");
}

export type MotivoDoTema = {
  readonly codigo:
    | "chave_fora_da_allowlist"
    | "valor_fora_da_régua"
    | "sem_par_no_escuro"
    | "saida_suspeita";
  readonly alvo: string;
  readonly detalhe: string;
};

export type CssDoTemaDeExtensao = {
  /** O texto pronto para o `<style>`, ou `null` — nunca uma string parcial. */
  readonly css: string | null;
  readonly motivos: readonly MotivoDoTema[];
};

function bloco(seletor: string, decls: readonly (readonly [string, string])[]): string {
  const linhas = decls.map(([nome, valor]) => `  ${nome}: ${valor};`);
  return `${seletor} {\n${linhas.join("\n")}\n}`;
}

function declaracoesDe(mapa: TokenMap): Array<[string, string]> {
  return (Object.entries(mapa) as Array<[string, string]>).sort(([a], [b]) =>
    a.localeCompare(b),
  );
}

/**
 * O ATALHO da condição do dono: `null` no tema ⇒ `null` no CSS.
 *
 * Quando um tema é passado, cada chave passa pela allowlist de NOME e cada
 * valor pela régua de FORMA (a mesma de `lib/branding/css.ts`). Um único valor
 * fora reduz a saída inteira a `null` com o motivo — nunca uma string parcial.
 */
export function cssDaExtensaoDeTema(
  tema: TemaDeExtensao | null,
  escopo: readonly (readonly [string, string])[] = ESCOPO_DO_TEMA_DA_ORGANIZACAO,
): CssDoTemaDeExtensao {
  const motivos: MotivoDoTema[] = [];
  if (tema === null) return { css: null, motivos };

  const semPar = chavesSemParNoEscuro(tema);
  if (semPar.length > 0) {
    motivos.push({
      codigo: "sem_par_no_escuro",
      alvo: semPar.join(", "),
      detalhe: "token que muda com o tema declarado só no claro vazaria para o modo escuro",
    });
    return { css: null, motivos };
  }

  const claras = declaracoesDe(tema.claro);
  const escuras = declaracoesDe(tema.escuro);
  const porTema = [
    ["claro", claras] as const,
    ["escuro", escuras] as const,
  ];

  const blocos: string[] = [];
  for (const [indice, [temaNome, decls]] of porTema.entries()) {
    if (decls.length === 0) continue;
    const seletor = escopo[indice]?.[0] ?? "";
    if (!seletor) {
      motivos.push({
        codigo: "saida_suspeita",
        alvo: temaNome,
        detalhe: "escopo não tem o seletor para este tema",
      });
      return { css: null, motivos };
    }
    for (const [nome, valor] of decls) {
      if (!ehNomeDeToken(nome)) {
        motivos.push({
          codigo: "chave_fora_da_allowlist",
          alvo: paraDiagnostico(nome),
          detalhe: "nome de custom property fora da forma --nome-assim",
        });
        return { css: null, motivos };
      }
      if (!(CHAVES_DE_TOKEN_DO_TEMA as readonly string[]).includes(nome)) {
        motivos.push({
          codigo: "chave_fora_da_allowlist",
          alvo: paraDiagnostico(nome),
          detalhe: "token fora da allowlist do tema de extensão",
        });
        return { css: null, motivos };
      }
      if (!ehFormaDeValorPermitida(valor)) {
        motivos.push({
          codigo: "valor_fora_da_régua",
          alvo: nome,
          detalhe: `valor não é #rrggbb, rgb()/rgba() nem var(--…): ${paraDiagnostico(valor)}`,
        });
        return { css: null, motivos };
      }
    }
    blocos.push(bloco(seletor, decls));
  }

  const css = blocos.join("\n");
  if (!css) return { css: null, motivos };

  const suspeita = SEQUENCIAS_SUSPEITAS.find((s) => css.includes(s));
  if (suspeita !== undefined) {
    motivos.push({
      codigo: "saida_suspeita",
      alvo: "css",
      detalhe: `a saída montada contém ${JSON.stringify(suspeita)}`,
    });
    return { css: null, motivos };
  }
  return { css, motivos };
}

/**
 * Uma linha lida do banco: a configuração da ORGANIZAÇÃO (onde mora a paleta
 * escolhida) e o `contributions` do manifesto do artefato vigente da extensão.
 * O manifesto gravado é revalidado aqui — o mesmo contrato do `manifest.ts` não
 * deixa um pacote velho/adulterado pintar o produto sem passar pela régua.
 */
export type LeituraDeTemaDaOrganizacao = {
  readonly configuracao: { readonly theme?: unknown };
  readonly contribuicao: unknown;
};

/**
 * Decide SE e QUAL tema aplicar a partir das extensões ativas da organização.
 *
 * `null` = nenhum tema a aplicar (não escolheu, escolheu paleta que nenhuma
 * extensão ativa oferece, ou mais de uma extensão disputa o tema — o empate
 * vira negação, porque a tela de quem escolheu não pode depender da ordem de
 * consulta do banco). Cada linha com tema válido é um candidato; só exatamente
 * um candidato faz o tema nascer.
 */
export function temaAplicavel(
  linhas: readonly LeituraDeTemaDaOrganizacao[],
): TemaDeExtensao | null {
  const candidatos: TemaDeExtensao[] = [];
  for (const linha of linhas) {
    const temaBruto = (linha.contribuicao as { theme?: unknown } | null)?.theme;
    if (temaBruto === undefined) continue;
    const tema = esquemaDaContribuicaoDeTema.safeParse(temaBruto);
    if (!tema.success) continue;
    // A paleta que a organização escolheu tem de ser a que a extensão oferece.
    if (linha.configuracao.theme !== tema.data.palette) continue;
    candidatos.push(tema.data);
  }
  return candidatos.length === 1 ? candidatos[0]! : null;
}

/**
 * Normaliza UMA linha do select aninhado de `organization_extensions` para a
 * forma que `temaAplicavel` entende, sem confiar no formato exato que o
 * PostgREST embute (objeto quando a FK é singular, array quando não).
 *
 * `null` = linha que não escolheu tema — e quem não escolheu não pode, por
 * definição, alimentar um candidato.
 */
export function linhaBrutaDeTema(linha: unknown): LeituraDeTemaDaOrganizacao | null {
  if (typeof linha !== "object" || linha === null) return null;
  const r = linha as Record<string, unknown>;
  const config =
    r.configuration && typeof r.configuration === "object" && !Array.isArray(r.configuration)
      ? (r.configuration as Record<string, unknown>)
      : {};
  if (typeof config.theme !== "string") return null;

  const instalacoes = r.extension_installations;
  const instalacao = Array.isArray(instalacoes) ? instalacoes[0] : instalacoes;
  if (typeof instalacao !== "object" || instalacao === null) return null;
  const artefatos = (instalacao as Record<string, unknown>).extension_artifacts;
  const artefato = Array.isArray(artefatos) ? artefatos[0] : artefatos;
  if (typeof artefato !== "object" || artefato === null) return null;
  const manifest = (artefato as Record<string, unknown>).manifest;
  if (typeof manifest !== "object" || manifest === null) return null;

  return {
    configuracao: { theme: config.theme },
    contribuicao: (manifest as Record<string, unknown>).contributions,
  };
}