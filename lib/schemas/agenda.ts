/**
 * Os schemas da Agenda no boundary da API.
 *
 * ─── Por que a QUERYSTRING também tem schema ───────────────────────────────
 *
 * `lib/schemas/_validate.ts` nasceu para corpo JSON (`validateRequest`/
 * `validateBody`), e uma rota GET com filtros não tem corpo. O padrão que já
 * existe na base para isso é o do `GET /api/v1/contacts`
 * (`contactListQuerySchema`): a rota monta um objeto a partir de
 * `searchParams` e faz `safeParse` nele — a querystring passa pelo MESMO Zod de
 * todo mundo, em vez de uma terceira régua escrita à mão no handler. É o que se
 * repete aqui; não inventei `validateQuery` para esta rota.
 *
 * ─── As DUAS recusas, que são perguntas diferentes ─────────────────────────
 *
 * A querystring de `/api/v1/agenda/datas-dos-negocios` pode estar errada de
 * dois jeitos, e a tela precisa saber QUAL:
 *
 *   1. **Forma inválida** — falta funil/campo, `pipeline_id` não é UUID, o dia
 *      não é `YYYY-MM-DD`, o fim é anterior ao início. Resposta:
 *      `validation_error` (o código de sempre; é erro de quem chamou).
 *   2. **Data de calendário impossível** — `2026-02-31`, `2026-04-31`,
 *      `2026-13-01`. A FORMA está certa, e por isso o `RE_DIA` de antes deixava
 *      passar: o filtro ia para o PostgREST e a grade voltava VAZIA, sem
 *      motivo à vista — indistinguível de "ninguém embarca neste período", que
 *      é exatamente o que o cabeçalho da rota promete não fazer. Resposta:
 *      `data_de_calendario_invalida` (código próprio, 422).
 *
 * O código próprio viaja em `params.codigo` da issue do Zod, e quem o lê é
 * `recusaDeCalendario` — a rota não reimplementa a régua para descobrir qual
 * das duas aconteceu.
 */
import { z } from "zod";

import { ApiErrorCodes } from "@/lib/api/errors";
import { diaDe } from "@/lib/kanban/calendario-do-funil";

import { chaveDeCampoDoFunilSchema } from "./settings";

/**
 * O código de erro da data de calendário impossível.
 *
 * A fonte é `ApiErrorCodes` — o registro canônico, que existe justamente porque
 * `fail()` aceita qualquer string e não protege contrato nenhum. Aqui é só o
 * apelido curto que o schema e a rota leem.
 */
export const CODIGO_DATA_DE_CALENDARIO_INVALIDA = ApiErrorCodes.data_de_calendario_invalida;

/**
 * `YYYY-MM-DD` — a forma, sem julgar o calendário.
 *
 * A recusa de forma é `validation_error`, a mesma de antes: quem manda
 * `10/03/2026` errou o contrato, e a mensagem genérica de validação basta.
 */
const formaDeDiaSchema = z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/, "Use AAAA-MM-DD");

/**
 * A chave do campo, já APARADA — e a mesma régua canônica depois.
 *
 * O `trim` vem num `preprocess` porque a leitura manual de antes aparava o
 * valor (`?campo=%20data_inicio` funcionava): apara primeiro, valida depois. Um
 * `.trim()` encadeado no schema de escrita rodaria DEPOIS das checagens e não
 * mudaria a recusa.
 */
const chaveDeCampoDaQuerySchema = z.preprocess(
  (valor) => (typeof valor === "string" ? valor.trim() : valor),
  chaveDeCampoDoFunilSchema,
);

/** O segundo campo: aparado, e vazio vale AUSENTE (era falsy na leitura manual). */
const chaveDeCampoOpcionalDaQuerySchema = z.preprocess(
  (valor) => {
    if (typeof valor !== "string") return valor;
    const limpo = valor.trim();
    return limpo === "" ? undefined : limpo;
  },
  chaveDeCampoDoFunilSchema.optional(),
);

/**
 * O dia existe no calendário?
 *
 * Delega a `diaDe` (`lib/kanban/calendario-do-funil`) em vez de reimplementar a
 * conferência: é a MESMA régua que decide se um valor de campo é data, e ela
 * já confere ano/mês/dia de volta (`2026-02-31` → `null`). Comparar o retorno
 * com a entrada fecha a outra porta de `diaDe`: ele também aceita data cheia
 * (`2026-03-10T10:00:00Z`), e aqui o contrato é dia puro — quem precisa de
 * instante tem outras rotas.
 */
function ehDiaDoCalendario(dia: string): boolean {
  return diaDe(dia) === dia;
}

/**
 * A querystring de `GET /api/v1/agenda/datas-dos-negocios`, canônica.
 *
 * `campo`/`campo_fim` usam a régua da ESCRITA do funil
 * (`chaveDeCampoDoFunilSchema`): a chave vai interpolada num caminho jsonb do
 * PostgREST (`custom_fields->>campo`), então `campo=data_inicio,status` seria
 * sintaxe de filtro, não nome de campo. `de`/`ate` também alimentam
 * `custom_fields->>campo between`, o que torna a data de calendário REAL uma
 * condição de resposta, e não preciosismo.
 *
 * `campo_fim` vazio (`?campo_fim=`) vale ausente: era o comportamento da
 * leitura manual (`""` é falsy), e recusar a lista inteira porque a tela mandou
 * um parâmetro sem valor puniria o cliente por algo que não muda a pergunta.
 */
export const datasDosNegociosQuerySchema = z
  .object({
    pipeline_id: z.string().trim().uuid("Informe o funil."),
    campo: chaveDeCampoDaQuerySchema,
    campo_fim: chaveDeCampoOpcionalDaQuerySchema,
    de: formaDeDiaSchema,
    ate: formaDeDiaSchema,
  })
  .superRefine((query, ctx) => {
    const impossiveis = (["de", "ate"] as const).filter((lado) => !ehDiaDoCalendario(query[lado]));
    if (impossiveis.length > 0) {
      for (const lado of impossiveis) {
        ctx.addIssue({
          code: "custom",
          path: [lado],
          message: "Data de calendário inválida.",
          params: { codigo: CODIGO_DATA_DE_CALENDARIO_INVALIDA },
        });
      }
      // Com uma data impossível, "fim antes do início" é consequência do erro
      // anterior, e não uma segunda recusa a explicar: `2026-02-31 > 2026-03-05`
      // como texto é verdade, e a tela leria o motivo errado.
      return;
    }
    if (query.de > query.ate) {
      ctx.addIssue({
        code: "custom",
        path: ["ate"],
        message: "O fim do período não pode ser anterior ao início.",
      });
    }
  });

export type DatasDosNegociosQuery = z.infer<typeof datasDosNegociosQuerySchema>;

/**
 * A ESCOLHA GUARDADA da camada "Datas dos negócios" (#4436, item 1), canônica.
 *
 * A Server Action que grava (`definirCamadaDatasDosNegocios`) aceita isto, e as
 * réguas são as MESMAS da consulta acima: `funilId` é uuid e as chaves seguem
 * `chaveDeCampoDoFunilSchema`. Uma escolha que a consulta recusaria não pode
 * ser gravada — o 422 voltaria na visita seguinte, a cada repintura.
 *
 * `null` é escolha VÁLIDA em três campos: nenhum funil (a lista decide), nenhum
 * campo (a camada pede a escolha) e nenhum segundo campo (o caso comum).
 */
export const escolhaDaCamadaSchema = z.object({
  ligada: z.boolean(),
  funilId: z.string().trim().uuid("Informe o funil.").nullable(),
  campo: chaveDeCampoDoFunilSchema.nullable(),
  campoFim: chaveDeCampoDoFunilSchema.nullable(),
});

export type EscolhaDaCamadaInput = z.infer<typeof escolhaDaCamadaSchema>;

/**
 * A recusa foi de CALENDÁRIO (e não de forma)?
 *
 * Uma pergunta só, respondida no módulo que declarou a issue — a rota não
 * precisa conhecer `params.codigo` nem a forma do `ZodError`.
 */
export function recusaDeCalendario(erro: z.ZodError): boolean {
  return erro.issues.some((issue) => {
    const params = (issue as { params?: Record<string, unknown> }).params;
    return params?.codigo === CODIGO_DATA_DE_CALENDARIO_INVALIDA;
  });
}
