/**
 * O CONTRATO DO SERVIÇO — o mesmo para a tela, a rota e o teste.
 *
 * Issue #3372 (fatia B). O serviço é um item do catálogo com um detalhe no
 * módulo `catalogo_servicos` (`catalog_service_details`); este schema é o que valida o que entra, e o `problemasDoServico()` é a régua
 * ÚNICA — a mesma que o `superRefine` do create usa e que o PATCH chama depois
 * de mesclar a linha atual com o corpo. Duas réguas divergem na primeira
 * mudança, e a que sobra é sempre a que o banco recusa com 23514 sem explicar.
 *
 * ⚠️ O que este arquivo NÃO faz: decidir `organization_id`, `moeda`, `origem`.
 * Corpo de requisição não decide escopo nem unidade — quem decide é a sessão e a
 * organização (`moedaDaOrganizacao`), como no catálogo de produtos.
 */
import { z } from "zod";

import {
  TIPOS_DE_SERVICO,
  UNIDADES_DE_COBRANCA,
  unidadeCompativel,
  type TipoDeServico,
  type UnidadeDeCobranca,
} from "@/lib/catalogo/servicos";
import { produtoCreateSchema } from "@/lib/schemas/produtos";

/** Código, nome e descrição são os MESMOS do produto — não uma segunda cópia. */
const baseDoItem = produtoCreateSchema.pick({ codigo: true, nome: true, descricao: true });

/**
 * Sinal: percentual (1 a 100) do preço, ou valor fixo em centavos. Um dos dois,
 * nunca os dois — "30% e R$ 50" não é uma coisa só.
 */
export const sinalDoServicoSchema = z.discriminatedUnion("tipo", [
  z.object({
    tipo: z.literal("percentual"),
    valor: z.number().min(1, "sinal_percentual_fora_da_faixa").max(100, "sinal_percentual_fora_da_faixa"),
  }),
  z.object({
    tipo: z.literal("fixo"),
    valor: z.number().int().min(1, "sinal_fixo_invalido"),
  }),
]);

const tipoSchema = z.enum(TIPOS_DE_SERVICO, { message: "tipo_invalido" });
const unidadeSchema = z.enum(UNIDADES_DE_COBRANCA, { message: "unidade_invalida" });
const precoSchema = z.number().int().min(0, "preco_negativo");
const prazoSchema = z.number().int().min(1, "prazo_minimo").max(3650, "prazo_fora_da_faixa").nullish();
const instrucoesSchema = z.string().trim().max(2000, "instrucoes_longas").nullish();

/** A linha final que a régua examina: o create inteiro ou o PATCH já mesclado. */
export interface EntradaDeServico {
  tipo?: TipoDeServico | null;
  unidade?: UnidadeDeCobranca | null;
  preco_cents?: number;
  prazo_dias_uteis?: number | null;
  sinal?: { tipo: "percentual" | "fixo"; valor: number } | null;
  pai_id?: string | null;
  controla_estoque?: boolean;
  quantidade?: number;
}

/** Códigos do detalhe 422 que a tela traduz. */
export type RegraDoServico =
  | "variacao_herda_tipo"
  | "variacao_herda_unidade"
  | "variacao_herda_prazo"
  | "variacao_herda_sinal"
  | "tipo_obrigatorio"
  | "unidade_obrigatoria"
  | "prazo_so_em_projeto"
  | "prazo_minimo"
  | "sinal_percentual_fora_da_faixa"
  | "sinal_fixo_invalido"
  | "sinal_fixo_acima_do_preco"
  | "servico_sem_estoque"
  | "unidade_incompativel"
  | "sinal_invalido"
  | "forma_invalida"
  | "pai_invalido"
  | "tipo_invalido"
  | "unidade_invalida"
  | "preco_negativo"
  | "prazo_fora_da_faixa"
  | "instrucoes_longas"
  | "revisao_invalida"
  | "codigo_invalido"
  | "nome_invalido"
  | "descricao_invalida";

export interface ProblemaDoServico {
  campo: string;
  codigo: RegraDoServico;
}

/**
 * A régua do serviço. Devolve TODOS os problemas de uma vez (não o primeiro):
 * quem cadastra corrige a tela uma vez, não uma por recarga.
 *
 * `menorPrecoDoServico` só é conhecido depois de ler as variações; quando não
 * vem, a regra do sinal fixo acima da menor variação é conferida só pelo
 * chamador que tem a lista (a rota).
 */
export function problemasDoServico(
  entrada: EntradaDeServico,
  opcoes: { menorPrecoDoServico?: number | null } = {},
): ProblemaDoServico[] {
  const problemas: ProblemaDoServico[] = [];
  const ehVariacao = Boolean(entrada.pai_id);

  if (ehVariacao) {
    // A variação herda tipo, unidade, prazo e sinal do principal. Aceitar isso
    // nela criaria dois lugares dizendo de que tipo é o mesmo serviço, e o dia
    // em que discordarem o preço da variação passa a valer em outra unidade.
    if (entrada.tipo) {
      problemas.push({ campo: "tipo", codigo: "variacao_herda_tipo" });
    }
    if (entrada.unidade) {
      problemas.push({
        campo: "unidade",
        codigo: "variacao_herda_unidade",
      });
    }
    if (entrada.prazo_dias_uteis !== null && entrada.prazo_dias_uteis !== undefined) {
      problemas.push({
        campo: "prazo_dias_uteis",
        codigo: "variacao_herda_prazo",
      });
    }
    if (entrada.sinal) {
      problemas.push({
        campo: "sinal",
        codigo: "variacao_herda_sinal",
      });
    }
  } else {
    if (!entrada.tipo) {
      problemas.push({
        campo: "tipo",
        codigo: "tipo_obrigatorio",
      });
    }
    if (!entrada.unidade) {
      problemas.push({
        campo: "unidade",
        codigo: "unidade_obrigatoria",
      });
    }
    if (entrada.tipo && entrada.unidade && !unidadeCompativel(entrada.tipo, entrada.unidade)) {
      problemas.push({
        campo: "unidade",
        codigo: "unidade_incompativel",
      });
    }
    if (entrada.prazo_dias_uteis !== null && entrada.prazo_dias_uteis !== undefined) {
      if (entrada.tipo !== "projeto") {
        problemas.push({
          campo: "prazo_dias_uteis",
          codigo: "prazo_so_em_projeto",
        });
      } else if (!Number.isInteger(entrada.prazo_dias_uteis) || entrada.prazo_dias_uteis < 1) {
        problemas.push({
          campo: "prazo_dias_uteis",
          codigo: "prazo_minimo",
        });
      }
    }
  }

  if (entrada.sinal) {
    if (entrada.sinal.tipo === "percentual") {
      if (!(entrada.sinal.valor >= 1 && entrada.sinal.valor <= 100)) {
        problemas.push({ campo: "sinal", codigo: "sinal_percentual_fora_da_faixa" });
      }
    } else if (!Number.isInteger(entrada.sinal.valor) || entrada.sinal.valor < 1) {
      problemas.push({ campo: "sinal", codigo: "sinal_fixo_invalido" });
    }
  }

  // O sinal fixo não pode passar do preço da menor variação: seria pedir de
  // entrada mais do que o serviço inteiro custa. A menor variação é o piso —
  // quem paga a variação mais barata é quem estaria financiando o resto.
  if (
    entrada.sinal?.tipo === "fixo" &&
    opcoes.menorPrecoDoServico !== undefined &&
    opcoes.menorPrecoDoServico !== null &&
    Number.isInteger(entrada.sinal.valor) &&
    entrada.sinal.valor > opcoes.menorPrecoDoServico
  ) {
    problemas.push({
      campo: "sinal",
      codigo: "sinal_fixo_acima_do_preco",
    });
  }

  // Serviço nunca controla estoque (#2497, pergunta 3): consultoria não tem
  // unidade em prateleira, e um serviço com `quantidade` faria a busca do
  // agente escondê-lo por "sem estoque".
  if (!ehVariacao && (entrada.controla_estoque === true || (entrada.quantidade ?? 0) > 0)) {
    problemas.push({ campo: "controla_estoque", codigo: "servico_sem_estoque" });
  }

  return problemas;
}

/**
 * Create: principal (tipo + unidade obrigatórios) ou variação (`pai_id`, e só
 * nome/código/preço próprios).
 */
export const servicoCreateSchema = baseDoItem
  .extend({
    preco_cents: precoSchema,
    tipo: tipoSchema.optional(),
    unidade: unidadeSchema.optional(),
    prazo_dias_uteis: prazoSchema,
    sinal: sinalDoServicoSchema.nullish(),
    instrucoes_ia: instrucoesSchema,
    ia_oferece: z.boolean().default(true),
    pai_id: z.uuid("pai_invalido").nullish(),
  })
  .superRefine((valor, ctx) => {
    for (const problema of problemasDoServico(valor)) {
      ctx.addIssue({ code: "custom", path: [problema.campo], message: problema.codigo });
    }
  });

/**
 * PATCH: só o que veio muda. A régua roda sobre a LINHA MESCLADA, na rota —
 * aqui não dá para julgar `prazo` sem saber o tipo que já está gravado.
 */
export const servicoPatchSchema = z.object({
  codigo: baseDoItem.shape.codigo.optional(),
  nome: baseDoItem.shape.nome.optional(),
  descricao: z.string().trim().max(2000).nullish(),
  preco_cents: precoSchema.optional(),
  tipo: tipoSchema.optional(),
  unidade: unidadeSchema.optional(),
  prazo_dias_uteis: prazoSchema,
  sinal: sinalDoServicoSchema.nullish(),
  instrucoes_ia: instrucoesSchema,
  ia_oferece: z.boolean().optional(),
  /** Revisão que quem edita viu. Velha = 409, como em toda escrita concorrente. */
  expected_revision: z.number().int().min(1, "revisao_invalida"),
});

const REGRAS_DO_ITEM = {
  codigo: "codigo_invalido",
  nome: "nome_invalido",
  descricao: "descricao_invalida",
} satisfies Record<string, RegraDoServico>;

/** Os campos herdados mantêm o schema dos produtos e usam códigos no catálogo de serviços. */
export function detalhesDaValidacaoDoServico(erro: z.ZodError): Record<string, unknown> {
  const detalhes: Record<string, string[] | undefined> = erro.flatten().fieldErrors;
  for (const [campo, regra] of Object.entries(REGRAS_DO_ITEM)) {
    if (detalhes[campo]?.length) detalhes[campo] = [regra];
  }
  return detalhes;
}

export type ServicoCreate = z.infer<typeof servicoCreateSchema>;
export type ServicoPatch = z.infer<typeof servicoPatchSchema>;
