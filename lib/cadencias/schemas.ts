/**
 * O que a API de cadências aceita de fora. Zod em todo input externo, como
 * manda a doutrina — e espelha exatamente `lib/cadencias/tipos.ts`, que é o
 * contrato que a tela e (mais adiante) o worker leem. `organization_id` nunca
 * entra aqui: vem do `requireRole()` na rota, nunca do corpo.
 *
 * Os passos formam uma ÁRVORE (ver `arvore.ts`): um ramo lê `sim`/`nao` como
 * `Passo[]`, daí a definição recursiva com `z.lazy`.
 */
import { z } from "zod";

/** Espelha `DiaDaSemana` de `tipos.ts` — não vem de lá porque lá é tipo, não valor. */
const DIAS_DA_SEMANA = ["seg", "ter", "qua", "qui", "sex", "sab", "dom"] as const;

const passoEmailSchema = z.object({
  id: z.string().min(1),
  tipo: z.literal("email"),
  assunto: z.string().max(300),
  corpo: z.string().max(20_000),
  mesmaConversa: z.boolean(),
});

const passoEsperaSchema = z.object({
  id: z.string().min(1),
  tipo: z.literal("espera"),
  diasUteis: z.number().int().min(1).max(365),
});

const condicaoDoRamoSchema = z.discriminatedUnion("tipo", [
  z.object({ tipo: z.literal("abriu"), vezes: z.number().int().min(1).max(50), dentroDeDias: z.number().int().min(1).max(365) }),
  z.object({ tipo: z.literal("clicou"), dentroDeDias: z.number().int().min(1).max(365) }),
  z.object({ tipo: z.literal("respondeu"), dentroDeDias: z.number().int().min(1).max(365) }),
]);

const passoWhatsappSchema = z.object({
  id: z.string().min(1),
  tipo: z.literal("whatsapp"),
  mensagem: z.string().max(4096),
});

const passoTarefaSchema = z.object({
  id: z.string().min(1),
  tipo: z.literal("tarefa"),
  titulo: z.string().max(300),
  prazoDias: z.number().int().min(0).max(365),
});

// `z.lazy` porque `sim`/`nao` guardam a mesma união que os inclui.
type PassoEntrada =
  | z.infer<typeof passoEmailSchema>
  | z.infer<typeof passoEsperaSchema>
  | z.infer<typeof passoWhatsappSchema>
  | z.infer<typeof passoTarefaSchema>
  | {
      id: string;
      tipo: "ramo";
      condicao: z.infer<typeof condicaoDoRamoSchema>;
      sim: PassoEntrada[];
      nao: PassoEntrada[];
    };

const passoRamoSchema: z.ZodType<Extract<PassoEntrada, { tipo: "ramo" }>> = z.lazy(() =>
  z.object({
    id: z.string().min(1),
    tipo: z.literal("ramo"),
    condicao: condicaoDoRamoSchema,
    sim: z.array(passoSchema).max(200),
    nao: z.array(passoSchema).max(200),
  }),
);

// `z.union`, não `z.discriminatedUnion`: com um membro recursivo (`passoRamoSchema`,
// envolto em `z.lazy`), o tipo interno de zod 4 não reconhece o membro como
// discriminável em tempo de compilação — a validação em runtime distingue pelo
// `tipo` de qualquer forma, cada branch com seu próprio `z.literal`.
export const passoSchema: z.ZodType<PassoEntrada> = z.lazy(() =>
  z.union([passoEmailSchema, passoEsperaSchema, passoRamoSchema, passoWhatsappSchema, passoTarefaSchema]),
);

export const configuracaoDaCadenciaSchema = z.object({
  tagDoSegmento: z.string().trim().max(80),
  somenteEmailValidado: z.boolean(),
  caixaPadraoId: z.string().max(80).nullable(),
  janela: z.object({
    inicio: z.string().regex(/^\d{2}:\d{2}$/),
    fim: z.string().regex(/^\d{2}:\d{2}$/),
    dias: z.array(z.enum(DIAS_DA_SEMANA)).max(7),
  }),
  fuso: z.string().trim().min(1).max(80),
  limiteDiarioPorCaixa: z.number().int().min(1).max(10_000),
  paradas: z.object({
    respondeu: z.boolean(),
    bounce: z.boolean(),
    descadastro: z.boolean(),
    ganhoOuPerdido: z.boolean(),
  }),
});

export const criarCadenciaSchema = z.object({
  name: z.string().trim().min(1).max(160),
  tagDoSegmento: z.string().trim().max(80).optional(),
});

export const editarCadenciaSchema = z
  .object({
    name: z.string().trim().min(1).max(160).optional(),
    configuracao: configuracaoDaCadenciaSchema.optional(),
    passos: z.array(passoSchema).max(500).optional(),
  })
  .refine((v) => v.name !== undefined || v.configuracao !== undefined || v.passos !== undefined, {
    message: "Nada para atualizar.",
  });

export const mudarStatusDaCadenciaSchema = z.object({
  status: z.enum(["ativa", "pausada", "rascunho"]),
});

export const inscreverLeadSchema = z.object({
  lead_id: z.string().uuid(),
});

export const listarCadenciasSchema = z.object({
  status: z.enum(["rascunho", "ativa", "pausada"]).optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});
