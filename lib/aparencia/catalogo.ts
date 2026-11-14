/**
 * O CATÁLOGO DE TEMPLATES da tela Aparência — dados declarativos, sem código.
 *
 * ── O que um template é, e o que ele NÃO é ──────────────────────────────────
 *
 * Um template é um conjunto fechado de valores para os tokens que o produto já
 * consome (`--color-*`, `--radius-*`, `--shadow-*`) mais os tokens da casca
 * (`--aparencia-*`: fundo da casca, menu lateral, painel de conteúdo). Nada
 * aqui decide rota, permissão, dado ou comportamento: trocar o template de uma
 * organização muda pixels, e só pixels.
 *
 * ── Por que os valores moram em TS, e não num `.css` ────────────────────────
 *
 * Porque o teste precisa LER as cores para medir contraste (`aparencia.test.ts`
 * mede os 10 templates nos dois modos contra o piso da WCAG que
 * `lib/branding/contraste.ts` já usa) — e porque a cor de ação de cada template
 * passa pelo MESMO gerador da cor da marca (`resolverMarca` + `cssDaMarca`),
 * que deriva a rampa e o texto por cima com conferência de contraste. Um `.css`
 * escrito à mão teria a rampa congelada e sem conferência.
 *
 * ── `fundoSolido` e `ativoFundoSolido` ─────────────────────────────────────
 *
 * O menu de alguns templates é vidro ou gradiente. Contraste não se mede contra
 * gradiente, então cada um declara a cor sólida que o texto de fato encontra
 * por baixo — é ela que o teste mede, e é ela que o modo "efeitos desligados"
 * usa no lugar do vidro.
 *
 * ── A cor secundária ────────────────────────────────────────────────────────
 *
 * Onde um template usa a segunda cor, ele escreve
 * `var(--aparencia-secundaria, <a cor do template>)`. A organização que escolheu
 * uma segunda cor na tela declara `--aparencia-secundaria` no próprio escopo
 * (`cssDaCorSecundaria`, em `ajustes.ts`); quem não escolheu fica com a do
 * template. Ela entra no fundo da casca e nos detalhes do menu, nunca em texto.
 */

import type { ChaveDeFonte } from "./fontes";

export type CoresDoMenu = {
  readonly fundo: string;
  readonly fundoSolido: string;
  readonly texto: string;
  readonly textoSuave: string;
  readonly borda: string;
  readonly ativoFundo: string;
  readonly ativoFundoSolido: string;
  readonly ativoTexto: string;
  readonly brilho: string;
  readonly indicador: string;
};

export type CoresDoModo = {
  readonly fundo: string;
  readonly superficie: string;
  readonly elevada: string;
  readonly texto: string;
  readonly textoSuave: string;
  readonly textoSutil: string;
  readonly borda: string;
  readonly bordaForte: string;
  /** Semente da cor de ação — a rampa sai do gerador da marca. */
  readonly acento: string;
  /** O fundo da casca, atrás do menu e do conteúdo. Pode ser gradiente. */
  readonly casca: string;
  /** O mesmo fundo com a intensidade "sutil". */
  readonly cascaSutil: string;
  /** O fundo do painel de conteúdo (`transparent` deixa a casca aparecer). */
  readonly conteudo: string;
  readonly conteudoSombra: string;
  /** O fundo da barra do topo. */
  readonly topo: string;
  readonly sombras: readonly [string, string, string, string, string];
  readonly menu: CoresDoMenu;
};

export type FormaDoTemplate = {
  /** Raios sm, md, lg e xl — os quatro que o Tailwind do produto consome. */
  readonly raios: readonly [string, string, string, string];
  /**
   * Respiro do menu flutuante. O vertical é no MÁXIMO 6px: o menu inteiro
   * precisa caber em 1280×900 sem rolar (`tests/e2e/navegacao.spec.ts`), e a
   * folga medida ali é de 19px.
   */
  readonly menuRecuoY: string;
  readonly menuRecuoX: string;
  readonly menuRaio: string;
  readonly menuRaioItem: string;
  readonly menuDesfoque: string;
  readonly indicadorLargura: string;
  /**
   * O respiro do painel de conteúdo é só LATERAL, de propósito: Inbox, Funil,
   * Central e Painel calculam a própria altura a partir de `100dvh`, e um
   * respiro vertical faria essas telas rolarem.
   */
  readonly conteudoRespiro: string;
  readonly conteudoRaio: string;
  readonly tituloPeso: string;
  readonly tituloEspaco: string;
};

export type Template = {
  readonly id: string;
  readonly nome: string;
  readonly categoria: string;
  readonly descricao: string;
  readonly fonteTexto: ChaveDeFonte;
  readonly fonteTitulo: ChaveDeFonte;
  readonly forma: FormaDoTemplate;
  readonly cores: { readonly claro: CoresDoModo; readonly escuro: CoresDoModo };
};

/** As cinco sombras (xs → xl) a partir de uma cor base e de uma força. */
function sombras(rgb: string, forca: number): CoresDoModo["sombras"] {
  const a = (n: number) => `rgb(${rgb} / ${Math.min(1, n * forca).toFixed(3)})`;
  return [
    `0 1px 2px 0 ${a(0.04)}`,
    `0 1px 2px 0 ${a(0.05)}, 0 1px 1px 0 ${a(0.03)}`,
    `0 4px 12px -2px ${a(0.07)}, 0 2px 4px -1px ${a(0.04)}`,
    `0 12px 32px -6px ${a(0.12)}, 0 4px 12px -2px ${a(0.06)}`,
    `0 24px 48px -12px ${a(0.18)}, 0 8px 16px -4px ${a(0.08)}`,
  ];
}

const sec = (padrao: string) => `var(--aparencia-secundaria, ${padrao})`;
const tinta = (cor: string, pct: number) => `color-mix(in srgb, ${cor} ${pct}%, transparent)`;
const grade = (cor: string) =>
  `linear-gradient(${cor} 1px, transparent 1px) 0 0 / 36px 36px, linear-gradient(90deg, ${cor} 1px, transparent 1px) 0 0 / 36px 36px`;

const SEM_RESPIRO = { menuRecuoY: "0px", menuRecuoX: "0px", menuRaio: "0px", conteudoRespiro: "0px", conteudoRaio: "0px" } as const;

export const TEMPLATES: readonly Template[] = [
  {
    id: "obsidiana",
    nome: "Obsidiana",
    categoria: "Luxo noturno",
    descricao:
      "Preto profundo com um brilho dourado vindo do alto, menu escuro e títulos em serifa. A sensação de abrir um produto caro.",
    fonteTexto: "manrope",
    fonteTitulo: "fraunces",
    forma: {
      ...SEM_RESPIRO,
      raios: ["6px", "10px", "14px", "18px"],
      menuRaioItem: "10px",
      menuDesfoque: "18px",
      indicadorLargura: "0px",
      tituloPeso: "500",
      tituloEspaco: "-0.02em",
    },
    cores: {
      claro: {
        fundo: "#f6f6f7", superficie: "#ffffff", elevada: "#eeeef0",
        texto: "#141416", textoSuave: "#5d5c62", textoSutil: "#77767c", borda: "#e3e3e6", bordaForte: "#cfcfd4",
        acento: "#9c7632",
        casca: `radial-gradient(900px 420px at 78% -12%, ${tinta(sec("#c49a48"), 22)}, transparent 62%), #f6f6f7`,
        cascaSutil: `radial-gradient(900px 420px at 78% -12%, ${tinta(sec("#c49a48"), 9)}, transparent 62%), #f6f6f7`,
        conteudo: "transparent", conteudoSombra: "none", topo: "rgb(246 246 247 / 0.85)",
        sombras: sombras("20 20 22", 1.2),
        menu: {
          fundo: "#0f0f11", fundoSolido: "#0f0f11", texto: "#e9e6df", textoSuave: "#8d8a84", borda: "#0f0f11",
          ativoFundo: "linear-gradient(180deg, rgb(214 178 104 / 0.2), rgb(214 178 104 / 0.08))",
          ativoFundoSolido: "#2a2519", ativoTexto: "#f1d79e",
          brilho: "inset 0 0 0 1px rgb(214 178 104 / 0.38)", indicador: "transparent",
        },
      },
      escuro: {
        fundo: "#0a0a0b", superficie: "#141416", elevada: "#1c1c1f",
        texto: "#eeebe4", textoSuave: "#a29e97", textoSutil: "#7f7c76", borda: "#26262a", bordaForte: "#34343a",
        acento: "#d6b268",
        casca: `radial-gradient(900px 460px at 78% -12%, ${tinta(sec("#d6b268"), 20)}, transparent 60%), radial-gradient(600px 400px at 0% 110%, ${tinta(sec("#d6b268"), 7)}, transparent 60%), #0a0a0b`,
        cascaSutil: `radial-gradient(900px 460px at 78% -12%, ${tinta(sec("#d6b268"), 8)}, transparent 60%), #0a0a0b`,
        conteudo: "transparent", conteudoSombra: "none", topo: "rgb(10 10 11 / 0.72)",
        sombras: sombras("0 0 0", 4),
        menu: {
          fundo: "rgb(255 255 255 / 0.025)", fundoSolido: "#111113", texto: "#e9e6df", textoSuave: "#8f8b85",
          borda: "rgb(255 255 255 / 0.07)",
          ativoFundo: "linear-gradient(180deg, rgb(214 178 104 / 0.18), rgb(214 178 104 / 0.06))",
          ativoFundoSolido: "#231f16", ativoTexto: "#f1d79e",
          brilho: "inset 0 0 0 1px rgb(214 178 104 / 0.35), 0 0 24px -6px rgb(214 178 104 / 0.35)",
          indicador: "transparent",
        },
      },
    },
  },
  {
    id: "aurora",
    nome: "Aurora",
    categoria: "Moderno vivo",
    descricao:
      "Uma aurora em malha de gradiente atrás de um menu de vidro fosco, com o conteúdo num painel encaixado. É o que mais chama atenção na primeira abertura.",
    fonteTexto: "jakarta",
    fonteTitulo: "bricolage",
    forma: {
      raios: ["8px", "12px", "16px", "22px"],
      menuRecuoY: "6px", menuRecuoX: "8px", menuRaio: "20px", menuRaioItem: "12px", menuDesfoque: "24px",
      indicadorLargura: "0px", conteudoRespiro: "8px", conteudoRaio: "22px",
      tituloPeso: "700", tituloEspaco: "-0.03em",
    },
    cores: {
      claro: {
        fundo: "#eef3f5", superficie: "#ffffff", elevada: "#f2f6f7",
        texto: "#0f2226", textoSuave: "#4e6368", textoSutil: "#6b7f84", borda: "#dde7e9", bordaForte: "#c6d4d7",
        acento: "#0d9488",
        casca: `radial-gradient(520px 420px at 4% 0%, #9ff0dd 0%, transparent 62%), radial-gradient(620px 460px at 98% 4%, ${tinta(sec("#9dbcff"), 70)} 0%, transparent 62%), radial-gradient(560px 460px at 55% 115%, #d9cbff 0%, transparent 62%), #eaf2f5`,
        cascaSutil: `linear-gradient(160deg, #e3f4f1, ${tinta(sec("#9dbcff"), 22)}), #eaf2f5`,
        conteudo: "rgb(255 255 255 / 0.74)", conteudoSombra: "0 30px 60px -30px rgb(20 60 70 / 0.35)", topo: "rgb(255 255 255 / 0.72)",
        sombras: sombras("20 60 70", 1.6),
        menu: {
          fundo: "rgb(255 255 255 / 0.5)", fundoSolido: "#eef6f6", texto: "#13262b", textoSuave: "#56707a",
          borda: "rgb(255 255 255 / 0.7)", ativoFundo: "#ffffff", ativoFundoSolido: "#ffffff", ativoTexto: "#0b5f58",
          brilho: "0 6px 20px -8px rgb(11 95 88 / 0.45)", indicador: "transparent",
        },
      },
      escuro: {
        fundo: "#070b14", superficie: "#111827", elevada: "#172033",
        texto: "#e7f3f4", textoSuave: "#9fb4b9", textoSutil: "#7d939a", borda: "#223044", bordaForte: "#2e3f57",
        acento: "#5eead4",
        casca: `radial-gradient(560px 440px at 4% 0%, rgb(45 212 191 / 0.42) 0%, transparent 62%), radial-gradient(640px 480px at 98% 4%, ${tinta(sec("#3b82f6"), 38)} 0%, transparent 62%), radial-gradient(560px 480px at 55% 118%, rgb(139 92 246 / 0.34) 0%, transparent 62%), #050912`,
        cascaSutil: `linear-gradient(160deg, #071a1c, ${tinta(sec("#3b82f6"), 10)}), #070b14`,
        conteudo: "rgb(10 16 28 / 0.6)", conteudoSombra: "0 30px 70px -30px rgb(0 0 0 / 0.8)", topo: "rgb(10 16 28 / 0.72)",
        sombras: sombras("0 0 0", 4),
        menu: {
          fundo: "rgb(10 16 28 / 0.45)", fundoSolido: "#0b1424", texto: "#e2f2f1", textoSuave: "#86a1a7",
          borda: "rgb(255 255 255 / 0.09)", ativoFundo: "rgb(94 234 212 / 0.14)", ativoFundoSolido: "#11302f",
          ativoTexto: "#a7f3e6",
          brilho: "inset 0 0 0 1px rgb(94 234 212 / 0.3), 0 0 26px -6px rgb(94 234 212 / 0.45)",
          indicador: "transparent",
        },
      },
    },
  },
  {
    id: "safira",
    nome: "Safira",
    categoria: "Enterprise",
    descricao:
      "Menu em gradiente de safira com indicador luminoso e cartões brancos nítidos. Passa a confiança de banco e de empresa grande.",
    fonteTexto: "jakarta",
    fonteTitulo: "jakarta",
    forma: {
      ...SEM_RESPIRO,
      raios: ["5px", "8px", "12px", "16px"],
      menuRaioItem: "9px", menuDesfoque: "0px", indicadorLargura: "3px",
      tituloPeso: "800", tituloEspaco: "-0.03em",
    },
    cores: {
      claro: {
        fundo: "#f3f6fc", superficie: "#ffffff", elevada: "#eaf0fa",
        texto: "#0d1733", textoSuave: "#4f5d80", textoSutil: "#6a7798", borda: "#dfe6f2", bordaForte: "#c8d3e6",
        acento: "#1d4ed8",
        casca: "#f3f6fc", cascaSutil: "#f3f6fc",
        conteudo: "transparent", conteudoSombra: "none", topo: "rgb(243 246 252 / 0.9)",
        sombras: sombras("13 23 51", 1.4),
        menu: {
          fundo: "linear-gradient(180deg, #0c2461 0%, #0a1a45 55%, #081232 100%)", fundoSolido: "#0a1a45",
          texto: "#d6e0fb", textoSuave: "#8fa1cf", borda: "transparent",
          ativoFundo: "rgb(255 255 255 / 0.1)", ativoFundoSolido: "#233160", ativoTexto: "#ffffff",
          brilho: "none", indicador: sec("#60a5fa"),
        },
      },
      escuro: {
        fundo: "#070c18", superficie: "#0e1830", elevada: "#142140",
        texto: "#e3e9f7", textoSuave: "#9aa7c6", textoSutil: "#7a88a8", borda: "#1d2a47", bordaForte: "#2a3a5e",
        acento: "#60a5fa",
        casca: `radial-gradient(800px 400px at 90% -10%, ${tinta(sec("#2563eb"), 14)}, transparent 60%), #070c18`,
        cascaSutil: "#070c18",
        conteudo: "transparent", conteudoSombra: "none", topo: "rgb(7 12 24 / 0.8)",
        sombras: sombras("0 0 0", 4),
        menu: {
          fundo: "linear-gradient(180deg, #0a1b4a 0%, #06102c 100%)", fundoSolido: "#081636",
          texto: "#cfdaf7", textoSuave: "#8195c8", borda: "rgb(255 255 255 / 0.06)",
          ativoFundo: "rgb(96 165 250 / 0.14)", ativoFundoSolido: "#13295a", ativoTexto: "#ffffff",
          brilho: "none", indicador: sec("#60a5fa"),
        },
      },
    },
  },
  {
    id: "carbono",
    nome: "Carbono",
    categoria: "Preciso",
    descricao:
      "Camadas de cinza carbono, linhas de um pixel e uma luz sutil no alto. A estética das ferramentas que times de produto adoram.",
    fonteTexto: "plex",
    fonteTitulo: "plex",
    forma: {
      ...SEM_RESPIRO,
      raios: ["4px", "6px", "8px", "12px"],
      menuRaioItem: "7px", menuDesfoque: "0px", indicadorLargura: "0px",
      tituloPeso: "600", tituloEspaco: "-0.02em",
    },
    cores: {
      claro: {
        fundo: "#fafafa", superficie: "#ffffff", elevada: "#f4f4f5",
        texto: "#111113", textoSuave: "#5f6068", textoSutil: "#7a7b83", borda: "#e7e7ea", bordaForte: "#d4d4d8",
        acento: "#5e5ce6",
        casca: "#fafafa", cascaSutil: "#fafafa",
        conteudo: "transparent", conteudoSombra: "none", topo: "rgb(250 250 250 / 0.9)",
        sombras: sombras("0 0 0", 0.9),
        menu: {
          fundo: "#f2f2f3", fundoSolido: "#f2f2f3", texto: "#2b2c30", textoSuave: "#6d6e75", borda: "#e4e4e7",
          ativoFundo: "#ffffff", ativoFundoSolido: "#ffffff", ativoTexto: "#111113",
          brilho: "0 0 0 1px #e1e1e5, 0 1px 3px rgb(0 0 0 / 0.08)", indicador: "transparent",
        },
      },
      escuro: {
        fundo: "#08090a", superficie: "#111214", elevada: "#18191c",
        texto: "#f0f1f3", textoSuave: "#9a9ca5", textoSutil: "#7a7c85", borda: "#222327", bordaForte: "#2e3035",
        acento: "#8f8dff",
        casca: `radial-gradient(900px 300px at 50% -20%, ${tinta(sec("#7c7aff"), 10)}, transparent 60%), #08090a`,
        cascaSutil: "#08090a",
        conteudo: "transparent", conteudoSombra: "none", topo: "rgb(8 9 10 / 0.8)",
        sombras: sombras("0 0 0", 4),
        menu: {
          fundo: "#0c0d0f", fundoSolido: "#0c0d0f", texto: "#d7d8dc", textoSuave: "#7c7e86", borda: "#1c1d20",
          ativoFundo: "rgb(255 255 255 / 0.06)", ativoFundoSolido: "#1a1b1e", ativoTexto: "#ffffff",
          brilho: "inset 0 0 0 1px rgb(255 255 255 / 0.08)", indicador: "transparent",
        },
      },
    },
  },
  {
    id: "marmore",
    nome: "Mármore",
    categoria: "Editorial elegante",
    descricao:
      "Branco luminoso, títulos em serifa e preto absoluto no item ativo. Tem cara de revista de moda, mas continua sendo uma ferramenta de trabalho.",
    fonteTexto: "manrope",
    fonteTitulo: "source-serif",
    forma: {
      ...SEM_RESPIRO,
      raios: ["3px", "5px", "8px", "12px"],
      menuRaioItem: "999px", menuDesfoque: "0px", indicadorLargura: "0px",
      tituloPeso: "500", tituloEspaco: "-0.025em",
    },
    cores: {
      claro: {
        fundo: "#f7f6f4", superficie: "#ffffff", elevada: "#f1efeb",
        texto: "#111111", textoSuave: "#66625b", textoSutil: "#7d7971", borda: "#e9e6e1", bordaForte: "#d6d2ca",
        // Bronze, e não preto: o gerador da marca recusa semente sem croma
        // (cairia na cor de fábrica). O preto do Mármore mora no item ativo do
        // menu, que tem token próprio.
        acento: "#6b4f1d",
        casca: "linear-gradient(180deg, #ffffff 0%, #f5f4f2 100%)", cascaSutil: "#f7f6f4",
        conteudo: "transparent", conteudoSombra: "none", topo: "rgb(255 255 255 / 0.88)",
        sombras: sombras("0 0 0", 0.7),
        menu: {
          fundo: "#ffffff", fundoSolido: "#ffffff", texto: "#1a1a1a", textoSuave: "#6f6b63", borda: "#ebe9e5",
          ativoFundo: "#111111", ativoFundoSolido: "#111111", ativoTexto: "#ffffff",
          brilho: "0 6px 16px -8px rgb(0 0 0 / 0.45)", indicador: "transparent",
        },
      },
      escuro: {
        fundo: "#0e0e0e", superficie: "#161615", elevada: "#1d1d1c",
        texto: "#f2f0ec", textoSuave: "#a29d95", textoSutil: "#85817a", borda: "#262524", bordaForte: "#353331",
        acento: "#e8e4dc",
        casca: "linear-gradient(180deg, #121212 0%, #0b0b0b 100%)", cascaSutil: "#0e0e0e",
        conteudo: "transparent", conteudoSombra: "none", topo: "rgb(14 14 14 / 0.85)",
        sombras: sombras("0 0 0", 4),
        menu: {
          fundo: "#0e0e0e", fundoSolido: "#0e0e0e", texto: "#ecebe8", textoSuave: "#8e8a83", borda: "#232221",
          ativoFundo: "#f4f2ee", ativoFundoSolido: "#f4f2ee", ativoTexto: "#111111",
          brilho: "none", indicador: "transparent",
        },
      },
    },
  },
  {
    id: "coral",
    nome: "Coral",
    categoria: "Caloroso",
    descricao:
      "Um gradiente de pôr do sol emoldura o conteúdo, que fica num painel claro de cantos generosos. Alegre e acolhedor, sem perder a ordem.",
    fonteTexto: "manrope",
    fonteTitulo: "bricolage",
    forma: {
      raios: ["8px", "12px", "18px", "24px"],
      menuRecuoY: "0px", menuRecuoX: "0px", menuRaio: "0px", menuRaioItem: "999px", menuDesfoque: "0px",
      indicadorLargura: "0px", conteudoRespiro: "10px", conteudoRaio: "26px",
      tituloPeso: "800", tituloEspaco: "-0.035em",
    },
    cores: {
      claro: {
        fundo: "#fdf6f7", superficie: "#ffffff", elevada: "#fbeff2",
        texto: "#24101a", textoSuave: "#6e5560", textoSutil: "#8a7380", borda: "#f1e3e8", bordaForte: "#e5cfd7",
        acento: "#d6365f",
        casca: `linear-gradient(135deg, #ffb199 0%, ${sec("#ff8fab")} 45%, #ffc87a 100%)`,
        cascaSutil: `linear-gradient(135deg, #ffe7df, ${tinta(sec("#ff8fab"), 28)}), #fdf6f7`,
        conteudo: "#fdf6f7", conteudoSombra: "0 30px 60px -28px rgb(120 20 50 / 0.5)", topo: "rgb(253 246 247 / 0.88)",
        sombras: sombras("120 20 50", 1.3),
        menu: {
          fundo: "transparent", fundoSolido: "#ffb1a3", texto: "#3a1220", textoSuave: "#6b2a3d", borda: "transparent",
          ativoFundo: "#ffffff", ativoFundoSolido: "#ffffff", ativoTexto: "#b8264f",
          brilho: "0 8px 20px -8px rgb(120 20 50 / 0.45)", indicador: "transparent",
        },
      },
      escuro: {
        fundo: "#140a0e", superficie: "#22161b", elevada: "#2a1c22",
        texto: "#fbeef2", textoSuave: "#bba2ac", textoSutil: "#9b828c", borda: "#33242b", bordaForte: "#45323a",
        acento: "#ff8f7a",
        casca: `radial-gradient(700px 500px at 0% 0%, rgb(255 122 89 / 0.45), transparent 60%), radial-gradient(700px 520px at 100% 100%, ${tinta(sec("#e2466f"), 42)}, transparent 60%), radial-gradient(500px 400px at 100% 0%, rgb(255 184 107 / 0.22), transparent 60%), #140a0e`,
        cascaSutil: `radial-gradient(700px 500px at 0% 0%, rgb(255 122 89 / 0.16), transparent 60%), #140a0e`,
        conteudo: "#1a1014", conteudoSombra: "0 30px 70px -30px rgb(0 0 0 / 0.8)", topo: "rgb(26 16 20 / 0.88)",
        sombras: sombras("0 0 0", 4),
        menu: {
          fundo: "transparent", fundoSolido: "#2a1218", texto: "#ffe4ea", textoSuave: "#c79aa6", borda: "transparent",
          ativoFundo: "rgb(255 255 255 / 0.12)", ativoFundoSolido: "#3a2a2f", ativoTexto: "#ffffff",
          brilho: "inset 0 0 0 1px rgb(255 255 255 / 0.18)", indicador: "transparent",
        },
      },
    },
  },
  {
    id: "neon",
    nome: "Néon",
    categoria: "Ousado",
    descricao:
      "Grade técnica no fundo, magenta elétrico com brilho e menu escuro. Para quem quer que o CRM pareça um painel de controle de ficção científica.",
    fonteTexto: "jakarta",
    fonteTitulo: "bricolage",
    forma: {
      ...SEM_RESPIRO,
      raios: ["5px", "8px", "12px", "16px"],
      menuRaioItem: "10px", menuDesfoque: "0px", indicadorLargura: "3px",
      tituloPeso: "800", tituloEspaco: "-0.03em",
    },
    cores: {
      claro: {
        fundo: "#f8f6fc", superficie: "#ffffff", elevada: "#f2eff8",
        texto: "#1a1326", textoSuave: "#5e5672", textoSutil: "#7a7290", borda: "#e9e4f2", bordaForte: "#d6cfe4",
        acento: "#c2187a",
        casca: `${grade("rgb(90 20 120 / 0.06)")}, radial-gradient(700px 400px at 90% -10%, ${tinta(sec("#d61f8d"), 14)}, transparent 60%), #f8f6fc`,
        cascaSutil: "#f8f6fc",
        conteudo: "transparent", conteudoSombra: "none", topo: "rgb(248 246 252 / 0.88)",
        sombras: sombras("60 20 90", 1.4),
        menu: {
          fundo: "#120f1c", fundoSolido: "#120f1c", texto: "#e6e1f5", textoSuave: "#8f88a8", borda: "#120f1c",
          ativoFundo: "rgb(255 62 165 / 0.16)", ativoFundoSolido: "#2f1631", ativoTexto: "#ffffff",
          brilho: "0 0 24px -6px rgb(255 62 165 / 0.6)", indicador: sec("#ff3ea5"),
        },
      },
      escuro: {
        fundo: "#07060b", superficie: "#120f1e", elevada: "#1a1629",
        texto: "#f1edfb", textoSuave: "#a39cbd", textoSutil: "#837c9c", borda: "#241f33", bordaForte: "#332c47",
        acento: "#ff3ea5",
        casca: `${grade("rgb(255 255 255 / 0.035)")}, radial-gradient(700px 420px at 92% -10%, ${tinta(sec("#ff3ea5"), 22)}, transparent 60%), radial-gradient(600px 400px at 0% 110%, rgb(34 211 238 / 0.14), transparent 60%), #07060b`,
        cascaSutil: `radial-gradient(700px 420px at 92% -10%, ${tinta(sec("#ff3ea5"), 8)}, transparent 60%), #07060b`,
        conteudo: "transparent", conteudoSombra: "none", topo: "rgb(7 6 11 / 0.75)",
        sombras: sombras("0 0 0", 4),
        menu: {
          fundo: "rgb(12 10 20 / 0.85)", fundoSolido: "#0c0a14", texto: "#e6e1f5", textoSuave: "#8a83a3",
          borda: "rgb(255 255 255 / 0.06)", ativoFundo: "rgb(255 62 165 / 0.14)", ativoFundoSolido: "#2a1129",
          ativoTexto: "#ffffff", brilho: "0 0 28px -6px rgb(255 62 165 / 0.7)", indicador: sec("#ff3ea5"),
        },
      },
    },
  },
  {
    id: "lavanda",
    nome: "Lavanda",
    categoria: "Suave e sofisticado",
    descricao:
      "Lilás em névoa, menu de vidro claro e tipografia firme em peso alto. Delicado sem ser infantil: combina com estética, saúde e bem-estar.",
    fonteTexto: "manrope",
    fonteTitulo: "manrope",
    forma: {
      raios: ["8px", "12px", "16px", "22px"],
      menuRecuoY: "6px", menuRecuoX: "8px", menuRaio: "20px", menuRaioItem: "12px", menuDesfoque: "20px",
      indicadorLargura: "0px", conteudoRespiro: "8px", conteudoRaio: "22px",
      tituloPeso: "800", tituloEspaco: "-0.035em",
    },
    cores: {
      claro: {
        fundo: "#f4f1fa", superficie: "#ffffff", elevada: "#f6f3fc",
        texto: "#1f1833", textoSuave: "#625a78", textoSutil: "#7d7594", borda: "#ebe6f5", bordaForte: "#d9d1ea",
        acento: "#6d4fd6",
        casca: `radial-gradient(600px 460px at 0% 0%, #e2d6ff 0%, transparent 65%), radial-gradient(640px 480px at 100% 100%, ${tinta(sec("#ffc4e6"), 80)} 0%, transparent 62%), #f4f1fa`,
        cascaSutil: "#f4f1fa",
        conteudo: "#ffffff", conteudoSombra: "0 30px 60px -30px rgb(80 50 140 / 0.35)", topo: "rgb(255 255 255 / 0.85)",
        sombras: sombras("80 50 140", 1.3),
        menu: {
          fundo: "rgb(255 255 255 / 0.55)", fundoSolido: "#efeaf8", texto: "#2a2140", textoSuave: "#665c82",
          borda: "rgb(255 255 255 / 0.85)", ativoFundo: "#ffffff", ativoFundoSolido: "#ffffff", ativoTexto: "#5b3fc4",
          brilho: "0 8px 22px -10px rgb(91 63 196 / 0.45)", indicador: "transparent",
        },
      },
      escuro: {
        fundo: "#0d0a16", superficie: "#1b1629", elevada: "#221c33",
        texto: "#f1edfb", textoSuave: "#a69ec0", textoSutil: "#8a83a3", borda: "#2a2340", bordaForte: "#3a3155",
        acento: "#a78bfa",
        casca: `radial-gradient(620px 480px at 0% 0%, rgb(139 92 246 / 0.32) 0%, transparent 65%), radial-gradient(640px 480px at 100% 100%, ${tinta(sec("#ec4899"), 20)} 0%, transparent 62%), #0d0a16`,
        cascaSutil: "#0d0a16",
        conteudo: "#14101f", conteudoSombra: "0 30px 70px -30px rgb(0 0 0 / 0.8)", topo: "rgb(20 16 31 / 0.85)",
        sombras: sombras("0 0 0", 4),
        menu: {
          fundo: "rgb(255 255 255 / 0.04)", fundoSolido: "#151122", texto: "#e9e3fa", textoSuave: "#8f86ab",
          borda: "rgb(255 255 255 / 0.08)", ativoFundo: "rgb(167 139 250 / 0.16)", ativoFundoSolido: "#2a2245",
          ativoTexto: "#ffffff", brilho: "inset 0 0 0 1px rgb(167 139 250 / 0.3)", indicador: "transparent",
        },
      },
    },
  },
  {
    id: "artico",
    nome: "Ártico",
    categoria: "Limpo e arejado",
    descricao:
      "Azul-gelo, muito ar entre os blocos e um menu de vidro que deixa o fundo atravessar. Títulos leves, números firmes.",
    fonteTexto: "jakarta",
    fonteTitulo: "jakarta",
    forma: {
      ...SEM_RESPIRO,
      raios: ["7px", "11px", "15px", "20px"],
      menuRaioItem: "11px", menuDesfoque: "22px", indicadorLargura: "0px",
      tituloPeso: "300", tituloEspaco: "-0.035em",
    },
    cores: {
      claro: {
        fundo: "#eef5fb", superficie: "#ffffff", elevada: "#f3f8fc",
        texto: "#0b2238", textoSuave: "#4f6579", textoSutil: "#6a7f92", borda: "#dbe7f1", bordaForte: "#c3d5e5",
        acento: "#0369a1",
        casca: `radial-gradient(700px 480px at 0% 0%, #cfe6fb 0%, transparent 60%), radial-gradient(800px 500px at 100% 0%, ${tinta(sec("#d4ebfc"), 90)} 0%, transparent 60%), linear-gradient(180deg, #eef5fb, #f8fbfd)`,
        cascaSutil: "linear-gradient(180deg, #eef5fb, #f8fbfd)",
        conteudo: "transparent", conteudoSombra: "none", topo: "rgb(238 245 251 / 0.7)",
        sombras: sombras("3 105 161", 1.2),
        menu: {
          fundo: "rgb(255 255 255 / 0.45)", fundoSolido: "#e7f1fa", texto: "#0b2a44", textoSuave: "#4f687d",
          borda: "rgb(255 255 255 / 0.8)", ativoFundo: "linear-gradient(135deg, #0369a1, #0c4a6e)",
          ativoFundoSolido: "#0369a1", ativoTexto: "#ffffff",
          brilho: "0 10px 22px -10px rgb(3 105 161 / 0.65)", indicador: "transparent",
        },
      },
      escuro: {
        fundo: "#06111c", superficie: "#0d1b29", elevada: "#132435",
        texto: "#e6f1fa", textoSuave: "#97adc0", textoSutil: "#7a90a4", borda: "#1c2e40", bordaForte: "#284054",
        acento: "#38bdf8",
        casca: `radial-gradient(700px 480px at 0% 0%, rgb(14 165 233 / 0.22) 0%, transparent 60%), radial-gradient(800px 500px at 100% 0%, ${tinta(sec("#38bdf8"), 12)} 0%, transparent 60%), #06111c`,
        cascaSutil: "#06111c",
        conteudo: "transparent", conteudoSombra: "none", topo: "rgb(6 17 28 / 0.7)",
        sombras: sombras("0 0 0", 4),
        menu: {
          fundo: "rgb(255 255 255 / 0.035)", fundoSolido: "#0b1824", texto: "#dcecf8", textoSuave: "#7f99af",
          borda: "rgb(255 255 255 / 0.07)", ativoFundo: "linear-gradient(135deg, #0369a1, #0c4a6e)",
          ativoFundoSolido: "#0369a1", ativoTexto: "#ffffff",
          brilho: "0 0 26px -6px rgb(56 189 248 / 0.6)", indicador: "transparent",
        },
      },
    },
  },
  {
    id: "vinho",
    nome: "Vinho",
    categoria: "Premium aveludado",
    descricao:
      "Menu cor de vinho com textura de veludo, ouro rosé nos destaques e títulos em serifa. Para marcas que vendem exclusividade.",
    fonteTexto: "plex",
    fonteTitulo: "fraunces",
    forma: {
      ...SEM_RESPIRO,
      raios: ["5px", "9px", "13px", "18px"],
      menuRaioItem: "9px", menuDesfoque: "0px", indicadorLargura: "3px",
      tituloPeso: "500", tituloEspaco: "-0.02em",
    },
    cores: {
      claro: {
        fundo: "#faf7f8", superficie: "#ffffff", elevada: "#f7eff1",
        texto: "#2a0f18", textoSuave: "#6e535b", textoSutil: "#8a6f77", borda: "#efe4e7", bordaForte: "#e0cdd2",
        acento: "#7a1a3a",
        casca: `radial-gradient(800px 380px at 90% -10%, ${tinta(sec("#b76e79"), 16)}, transparent 60%), #faf7f8`,
        cascaSutil: "#faf7f8",
        conteudo: "transparent", conteudoSombra: "none", topo: "rgb(250 247 248 / 0.88)",
        sombras: sombras("90 18 44", 1.3),
        menu: {
          fundo: "radial-gradient(400px 300px at 0% 0%, rgb(255 255 255 / 0.08), transparent 60%), linear-gradient(180deg, #56122c 0%, #3a0a1d 60%, #2a0614 100%)",
          fundoSolido: "#3a0a1d", texto: "#f6dde3", textoSuave: "#c895a2", borda: "transparent",
          ativoFundo: "rgb(255 255 255 / 0.1)", ativoFundoSolido: "#4e2333", ativoTexto: "#ffffff",
          brilho: "none", indicador: sec("#e7b2a0"),
        },
      },
      escuro: {
        fundo: "#110709", superficie: "#1b0e12", elevada: "#241318",
        texto: "#f6e9ec", textoSuave: "#b8a0a6", textoSutil: "#957c83", borda: "#2c1a20", bordaForte: "#3d252d",
        acento: "#e7b2a0",
        casca: `radial-gradient(800px 420px at 90% -10%, ${tinta(sec("#b76e79"), 18)}, transparent 60%), #110709`,
        cascaSutil: "#110709",
        conteudo: "transparent", conteudoSombra: "none", topo: "rgb(17 7 9 / 0.8)",
        sombras: sombras("0 0 0", 4),
        menu: {
          fundo: "radial-gradient(400px 300px at 0% 0%, rgb(255 255 255 / 0.06), transparent 60%), linear-gradient(180deg, #3d0b1f 0%, #22050f 100%)",
          fundoSolido: "#2f0817", texto: "#f3d8df", textoSuave: "#b58591", borda: "rgb(255 255 255 / 0.05)",
          ativoFundo: "rgb(231 178 160 / 0.14)", ativoFundoSolido: "#47202a", ativoTexto: "#ffffff",
          brilho: "none", indicador: sec("#e7b2a0"),
        },
      },
    },
  },
];

const POR_ID: ReadonlyMap<string, Template> = new Map(TEMPLATES.map((t) => [t.id, t]));

/** O template do catálogo, ou `null` — nunca um objeto vindo de fora. */
export function templatePorId(id: unknown): Template | null {
  return typeof id === "string" ? (POR_ID.get(id) ?? null) : null;
}
