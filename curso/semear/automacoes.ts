/**
 * Semente do módulo "Automações" (Configurações): uma regra que tem o passo
 * "A IA decide" — o único que o interruptor da tela desliga — e uma execução
 * dela em que esse passo foi pulado porque a empresa tinha desligado a IA.
 *
 * Sem regra com esse passo o interruptor fica abstrato: a lição mostra onde o
 * passo mora (designer) e o que aparece na aba Atividade quando ele é pulado.
 *
 * A execução tem DUAS ações (etiqueta que deu certo + passo pulado) e por isso
 * é "Parcial", como o motor gravaria (lib/automation/engine.ts): um "Falhou"
 * aqui colidiria com o alvo `texto: "Falhou"` da lição de Webhooks, que roda no
 * mesmo banco. Ela nasce 3 h atrás para ficar abaixo das execuções daquele
 * módulo (35 e 90 min).
 *
 * Idempotente: apaga só a regra de id fixo (a execução cai junto, on delete
 * cascade) e recria. O interruptor em si a base já devolve ao padrão de fábrica.
 */
import { type Contexto, ha, semErro } from "../semear-demonstracao";

const REGRA = "a0d00000-0000-4000-8000-000000000001";
const EXECUCAO = "a0d10000-0000-4000-8000-000000000001";
export const NOME_DA_REGRA = "Separar o novo paciente por especialidade";

const etiqueta = (tag: string) => ({ type: "add_tag", config: { tags: [tag] } });

export async function semear(c: Contexto) {
  const { db, org, pessoa } = c;
  semErro(await db.from("automation_rules").delete().eq("organization_id", org).eq("id", REGRA), "limpar regra");

  const criada = ha(15 * 24 * 60);
  semErro(
    await db.from("automation_rules").insert({
      id: REGRA,
      organization_id: org,
      name: NOME_DA_REGRA,
      trigger_event: "lead.created",
      trigger_config: {},
      conditions: [],
      is_active: true,
      actions: [
        etiqueta("novo-paciente"),
        {
          type: "ai_decide",
          config: {
            custo_de_token: true,
            instrucao:
              "Leia o que o novo paciente escreveu e escolha a especialidade que ele procura. Na dúvida entre duas, escolha Nutrição.",
            opcoes: [
              { id: "nutricao", rotulo: "Nutrição", acao: etiqueta("nutricao") },
              { id: "fisioterapia", rotulo: "Fisioterapia", acao: etiqueta("fisioterapia") },
              { id: "odontologia", rotulo: "Odontologia", acao: etiqueta("odontologia") },
            ],
          },
        },
      ],
      run_count: 1,
      last_run_at: ha(3 * 60),
      created_at: criada,
      created_by_user_id: pessoa.helena,
      last_change_actor_kind: "user",
      last_change_at: criada,
    }),
    "regra com o passo A IA decide",
  );

  semErro(
    await db.from("automation_rule_runs").insert({
      id: EXECUCAO,
      organization_id: org,
      rule_id: REGRA,
      event_id: null,
      status: "partial",
      created_at: ha(3 * 60),
      actions_result: [
        { type: "add_tag", status: "success", detail: {} },
        { type: "ai_decide", status: "skipped", detail: { reason: "ai_decide_desligado_na_empresa" } },
      ],
    }),
    "execução com o passo pulado",
  );
}
