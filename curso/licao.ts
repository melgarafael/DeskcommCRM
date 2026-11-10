/**
 * Contrato de uma lição do curso ilustrado.
 *
 * Uma lição é DADO (curso/licoes/*.json), nunca print desenhado à mão: o
 * capturador (capturar.ts) executa cada passo no app real, fotografa a tela e
 * mede onde está cada destaque; o montador (montar.ts) desenha setas e caixas
 * POR CIMA da foto a partir dessas medidas. Quando a tela muda, o próximo
 * capturar refaz as fotos — e um alvo que sumiu falha alto, em vez de virar
 * uma seta apontando para o nada.
 */
import { z } from "zod";

const umaEstrategia = (a: Record<string, unknown>) =>
  ["testid", "role", "rotulo", "placeholder", "texto", "css"].filter((k) => a[k] !== undefined).length === 1;
const MSG_ESTRATEGIA = "o alvo precisa de exatamente UMA estratégia (testid, role, rotulo, placeholder, texto ou css)";

/** Como achar um elemento na tela. Um campo por estratégia, na ordem de preferência. */
const AlvoSimples = z
  .object({
    testid: z.string().optional(),
    role: z.string().optional(),
    nome: z.string().optional(),
    rotulo: z.string().optional(),
    placeholder: z.string().optional(),
    texto: z.string().optional(),
    css: z.string().optional(),
    exato: z.boolean().optional(),
    /** Nome de dado da semente, preservado mesmo quando coincide com um rótulo traduzível. */
    literal: z.boolean().optional(),
    /** `nome`/`texto` são expressão regular (sem barras), para rótulos que carregam contador ou hora. */
    regex: z.boolean().optional(),
    /** Qual das ocorrências (0 = primeira). Sem `n`, o alvo precisa ser único. */
    n: z.number().int().min(0).optional(),
  })
  .strict();

export const Alvo = AlvoSimples.extend({
  /** Procura só dentro deste outro elemento — desfaz ambiguidade sem depender de posição. */
  dentro: AlvoSimples.refine(umaEstrategia, { message: MSG_ESTRATEGIA }).optional(),
})
  .strict()
  .refine(umaEstrategia, { message: MSG_ESTRATEGIA });
export type Alvo = z.infer<typeof Alvo>;

export const Acao = z.discriminatedUnion("acao", [
  z.object({ acao: z.literal("click"), alvo: Alvo }).strict(),
  z.object({ acao: z.literal("hover"), alvo: Alvo }).strict(),
  z.object({ acao: z.literal("fill"), alvo: Alvo, valor: z.string() }).strict(),
  /** Com `alvo`, a tecla vai para aquele campo; sem, para onde o foco estiver (atalhos da página). */
  z.object({ acao: z.literal("press"), tecla: z.string(), alvo: Alvo.optional() }).strict(),
  z.object({ acao: z.literal("esperar"), ms: z.number().int().positive().max(10_000) }).strict(),
  /** Escolhe uma opção de um <select> nativo, pelo texto visível da opção. */
  z.object({ acao: z.literal("selecionar"), alvo: Alvo, opcao: z.string() }).strict(),
  /** Traz o elemento para dentro da janela (listas e painéis com rolagem própria). */
  z.object({ acao: z.literal("rolar"), alvo: Alvo }).strict(),
  /** Espera um elemento aparecer — para o resultado de um clique que demora (rede, diálogo). */
  z.object({ acao: z.literal("aguardar"), alvo: Alvo }).strict(),
]);
export type Acao = z.infer<typeof Acao>;

export const Destaque = z
  .object({
    alvo: Alvo,
    rotulo: z.string().min(1),
    tipo: z.enum(["caixa", "seta", "numero"]),
  })
  .strict();

export const Passo = z
  .object({
    id: z.string().regex(/^[a-z0-9-]+$/),
    titulo: z.string().min(1),
    texto: z.string().min(1),
    dica: z.string().optional(),
    /** Rota a abrir antes do passo. Ausente = continua na tela do passo anterior. */
    rota: z.string().startsWith("/").optional(),
    antes: z.array(Acao).default([]),
    destaques: z.array(Destaque).default([]),
    /** O que o aluno clica no modo simulador para avançar. Ausente = passo só de leitura. */
    clicar: Alvo.optional(),
  })
  .strict();
export type Passo = z.infer<typeof Passo>;

export const Licao = z
  .object({
    id: z.string().regex(/^[a-z0-9-]+$/),
    titulo: z.string().min(1),
    objetivo: z.string().min(1),
    papel: z.enum(["admin", "manager", "agent"]),
    busca: z.array(z.string()).default([]),
    passos: z.array(Passo).min(1),
  })
  .strict()
  .refine((l) => l.passos[0]?.rota !== undefined, { message: "o primeiro passo de uma lição precisa de rota" })
  .refine((l) => new Set(l.passos.map((p) => p.id)).size === l.passos.length, { message: "ids de passo repetidos" });
export type Licao = z.infer<typeof Licao>;

export const Modulo = z
  .object({
    id: z.string().regex(/^[a-z0-9-]+$/),
    titulo: z.string().min(1),
    /** A tela que o módulo ensina — um href de lib/navigation/catalogo.ts, ou do menu do Admin (curso/menu-do-admin.ts). */
    tela: z.string().regex(/^\/(app|admin)\//),
    resumo: z.string().min(1),
    licoes: z.array(Licao).min(1),
  })
  .strict()
  .refine((m) => new Set(m.licoes.map((l) => l.id)).size === m.licoes.length, { message: "ids de lição repetidos" });
export type Modulo = z.infer<typeof Modulo>;

/**
 * Chave estável de um passo — nome da foto. Leva o MÓDULO: ids de lição se
 * repetem entre módulos ("conhecendo-a-tela" existe em vários), e sem ele a foto
 * de um módulo sobrescrevia a de outro.
 */
export const chaveDoPasso = (modulo: string, licao: string, passo: string) => `${modulo}--${licao}--${passo}`;
