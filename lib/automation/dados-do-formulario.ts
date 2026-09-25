import type { OrigemDaAbordagem } from "@/lib/agent-engine/agent/abordagem-de-formulario";
/**
 * OS DADOS QUE A IA RECEBE COMO ENTRADA — e de onde eles vêm.
 *
 * A fonte PREFERIDA é `webhook_lead_captures` (migration 0174): ela guarda o
 * formulário como a pessoa preencheu, com os rótulos originais dos campos. É a
 * diferença entre a IA ler `quantos_funcionarios: 3` e ler um `custom_fields`
 * já mastigado pelo mapeamento.
 *
 * O plano B é o contexto que o motor já hidratou (`lead.custom_fields` +
 * `source_metadata` + o contato). Ele existe porque a ação vale para os CINCO
 * gatilhos, não só para o de webhook: uma regra disparada por "ganhou a tag
 * cliente-vip" não tem formulário nenhum, e ainda assim a IA deve escrever com
 * o que se sabe da pessoa.
 *
 * `origemDaAbordagem` não é detalhe: é o que decide qual situação o prompt
 * declara ao agente ("acabou de preencher um formulário" vs. "entrou no funil
 * por uma automação"). Dizer a errada faz o modelo escrever sobre um formulário
 * que não existiu.
 *
 * Era um booleano, e virou três valores porque o `false` não dizia o bastante:
 * quem chega por PROSPECÇÃO FRIA não entrou em funil nenhum, e as regras do
 * prompt falavam em "o que ela preencheu" mesmo no ramo negativo. Este arquivo
 * nunca produz `prospeccao_fria` — aqui sempre houve um gatilho da organização;
 * quem a produz é `lib/prospecting/worker.ts`.
 */
import type { ActionCtx } from "@/lib/automation/types";

export interface DadosParaAbordagem {
  dados: Record<string, string>;
  origem: string | null;
  origemDaAbordagem: OrigemDaAbordagem;
}

/**
 * Do CONTATO, só estes campos entram — e a lista é uma ALLOWLIST, não um mapa
 * de rótulos bonitos.
 *
 * `buildContext` (lib/automation/engine.ts) hidrata `context.contact` com
 * `select("*")`: a linha INTEIRA de `contacts`. Iterar esse objeto — que é o que
 * este arquivo fazia — despejava no prompt do provedor de LLM, sob o rótulo "o
 * que a pessoa preencheu", coisas como `id`, `organization_id`, `cpf_hash`,
 * `cpf_encrypted`, `email_normalized`, `is_blocked`, `created_at` e as flags
 * internas. Três lentes de revisão acharam isto de forma independente.
 *
 * Dois estragos, e o segundo é o silencioso: (1) identificadores internos e
 * hash de CPF saíam da instalação; (2) o modelo era instruído a "personalizar
 * de verdade" a partir de metadados de banco, então a mensagem podia citar o
 * horário de `created_at` ou a palavra "webhook" ao cliente.
 */
const CAMPOS_DO_CONTATO: Record<string, string> = {
  name: "Nome",
  display_name: "Nome",
  phone_number: "Telefone",
  email: "E-mail",
};

function texto(valor: unknown): string | null {
  if (typeof valor === "string" && valor.trim()) return valor.trim();
  if (typeof valor === "number" || typeof valor === "boolean") return String(valor);
  return null;
}

function acrescentar(
  destino: Record<string, string>,
  origem: Record<string, unknown> | null | undefined,
): void {
  if (!origem) return;
  for (const [chave, valor] of Object.entries(origem)) {
    const v = texto(valor);
    if (v === null) continue;
    if (!(chave in destino)) destino[chave] = v;
  }
}

/**
 * O contato, pela allowlist. Itera os campos PERMITIDOS, não os presentes —
 * é o que faz uma coluna nova em `contacts` (amanhã) não vazar sozinha para o
 * prompt.
 */
function acrescentarContato(
  destino: Record<string, string>,
  contato: Record<string, unknown> | null | undefined,
): void {
  if (!contato) return;
  for (const [coluna, rotulo] of Object.entries(CAMPOS_DO_CONTATO)) {
    const v = texto(contato[coluna]);
    if (v === null) continue;
    if (!(rotulo in destino)) destino[rotulo] = v;
  }
}

export async function dadosDoFormularioDoContexto(ctx: ActionCtx): Promise<DadosParaAbordagem> {
  const lead = ctx.context.lead as
    | { id?: string; custom_fields?: Record<string, unknown>; source_metadata?: Record<string, unknown> }
    | undefined;
  const contact = ctx.context.contact as
    | { name?: string | null; phone_number?: string | null; email?: string | null }
    | undefined;

  const dados: Record<string, string> = {};
  acrescentarContato(dados, contact as Record<string, unknown> | undefined);

  if (lead?.id) {
    // A captação mais recente deste lead. `maybeSingle` com limit 1: um lead
    // pode ter mais de uma linha (reenvio da ferramenta), e a que vale é a que
    // criou o lead — a primeira. Ordena ascendente por isso.
    const { data } = await ctx.admin
      .from("webhook_lead_captures")
      .select("fields, utm, source_name")
      .eq("organization_id", ctx.organizationId)
      .eq("lead_id", lead.id)
      .order("received_at", { ascending: true })
      .limit(1)
      .maybeSingle();

    const captura = data as
      | { fields: Record<string, unknown>; utm: Record<string, string>; source_name: string }
      | null;
    if (captura) {
      acrescentar(dados, captura.fields);
      acrescentar(dados, captura.utm);
      return { dados, origem: captura.source_name, origemDaAbordagem: "formulario" };
    }
  }

  acrescentar(dados, lead?.custom_fields);
  acrescentar(dados, lead?.source_metadata);
  return { dados, origem: null, origemDaAbordagem: "automacao" };
}
