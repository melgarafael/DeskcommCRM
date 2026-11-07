/**
 * O CONTRATO DO SERVIÇO — o mesmo para a tela, a rota e o teste.
 *
 * Issue #3372 (fatia B). O serviço é um item do catálogo com colunas próprias;
 * este schema é o que valida o que entra, e o `problemasDoServico()` é a régua
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
    valor: z.number().min(1, "o sinal vai de 1 a 100").max(100, "o sinal vai de 1 a 100"),
  }),
  z.object({
    tipo: z.literal("fixo"),
    valor: z.number().int().min(1, "o sinal fixo precisa ser maior que zero"),
  }),
]);

const tipoSchema = z.enum(TIPOS_DE_SERVICO, { message: "tipo de serviço desconhecido" });
const unidadeSchema = z.enum(UNIDADES_DE_COBRANCA, { message: "unidade de cobrança desconhecida" });

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

export interface ProblemaDoServico {
  campo: string;
  mensagem: string;
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
      problemas.push({ campo: "tipo", mensagem: "a variação herda o tipo do serviço principal" });
    }
    if (entrada.unidade) {
      problemas.push({
        campo: "unidade",
        mensagem: "a variação herda a unidade do serviço principal",
      });
    }
    if (entrada.prazo_dias_uteis !== null && entrada.prazo_dias_uteis !== undefined) {
      problemas.push({
        campo: "prazo_dias_uteis",
        mensagem: "o prazo é do serviço principal, não da variação",
      });
    }
    if (entrada.sinal) {
      problemas.push({
        campo: "sinal",
        mensagem: "o sinal é do serviço principal e vale para todas as variações",
      });
    }
  } else {
    if (!entrada.tipo) {
      problemas.push({
        campo: "tipo",
        mensagem: "todo serviço precisa de um tipo: hora marcada, projeto ou recorrente",
      });
    }
    if (!entrada.unidade) {
      problemas.push({
        campo: "unidade",
        mensagem: "todo serviço precisa de uma unidade de cobrança",
      });
    }
    if (entrada.tipo && entrada.unidade && !unidadeCompativel(entrada.tipo, entrada.unidade)) {
      problemas.push({
        campo: "unidade",
        mensagem: `um serviço do tipo ${entrada.tipo} não se cobra por ${entrada.unidade}`,
      });
    }
    if (entrada.prazo_dias_uteis !== null && entrada.prazo_dias_uteis !== undefined) {
      if (entrada.tipo !== "projeto") {
        problemas.push({
          campo: "prazo_dias_uteis",
          mensagem: "prazo em dias úteis só existe em projeto",
        });
      } else if (!Number.isInteger(entrada.prazo_dias_uteis) || entrada.prazo_dias_uteis < 1) {
        problemas.push({
          campo: "prazo_dias_uteis",
          mensagem: "o prazo precisa ser de ao menos 1 dia útil",
        });
      }
    }
  }

  if (entrada.sinal) {
    if (entrada.sinal.tipo === "percentual") {
      if (!(entrada.sinal.valor >= 1 && entrada.sinal.valor <= 100)) {
        problemas.push({ campo: "sinal", mensagem: "o sinal vai de 1 a 100" });
      }
    } else if (!Number.isInteger(entrada.sinal.valor) || entrada.sinal.valor < 1) {
      problemas.push({ campo: "sinal", mensagem: "o sinal fixo precisa ser maior que zero" });
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
      mensagem: "o sinal fixo não pode passar do preço da menor variação",
    });
  }

  // Serviço nunca controla estoque (#2497, pergunta 3): consultoria não tem
  // unidade em prateleira, e um serviço com `quantidade` faria a busca do
  // agente escondê-lo por "sem estoque".
  if (!ehVariacao && (entrada.controla_estoque === true || (entrada.quantidade ?? 0) > 0)) {
    problemas.push({ campo: "controla_estoque", mensagem: "serviço não controla estoque" });
  }

  return problemas;
}

/**
 * Create: principal (tipo + unidade obrigatórios) ou variação (`pai_id`, e só
 * nome/código/preço próprios).
 */
export const servicoCreateSchema = baseDoItem
  .extend({
    preco_cents: z.number().int().min(0, "preço não pode ser negativo"),
    tipo: tipoSchema.optional(),
    unidade: unidadeSchema.optional(),
    prazo_dias_uteis: z.number().int().min(1).max(3650, "prazo fora de faixa").nullish(),
    sinal: sinalDoServicoSchema.nullish(),
    instrucoes_ia: z.string().trim().max(2000, "as instruções passam de 2000 caracteres").nullish(),
    ia_oferece: z.boolean().default(true),
    ia_agenda: z.boolean().default(false),
    pai_id: z.uuid("variação sem serviço principal válido").nullish(),
  })
  .superRefine((valor, ctx) => {
    for (const problema of problemasDoServico(valor)) {
      ctx.addIssue({ code: "custom", path: [problema.campo], message: problema.mensagem });
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
  preco_cents: z.number().int().min(0, "preço não pode ser negativo").optional(),
  tipo: tipoSchema.optional(),
  unidade: unidadeSchema.optional(),
  prazo_dias_uteis: z.number().int().min(1).max(3650).nullish(),
  sinal: sinalDoServicoSchema.nullish(),
  instrucoes_ia: z.string().trim().max(2000).nullish(),
  ia_oferece: z.boolean().optional(),
  ia_agenda: z.boolean().optional(),
  /** Revisão que quem edita viu. Velha = 409, como em toda escrita concorrente. */
  expected_revision: z.number().int().min(1, "revisão inválida"),
});

export type ServicoCreate = z.infer<typeof servicoCreateSchema>;
export type ServicoPatch = z.infer<typeof servicoPatchSchema>;
