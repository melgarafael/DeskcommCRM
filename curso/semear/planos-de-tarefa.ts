/**
 * Semente do módulo "Planos de tarefa" (CRM › Ver tudo em CRM › Planos de tarefa).
 *
 * Sem plano nenhum a tela é uma frase ("Nenhum plano cadastrado ainda.") e o
 * seletor da ação "Aplicar um plano de tarefas ao negócio", no editor de
 * automações, fica vazio. Por isso a clínica ganha dois planos prontos: um com
 * todos os passos no dono do negócio e outro com passos de uma pessoa fixa
 * (a Ana, da recepção), para as lições mostrarem as duas formas de "Atribuir a".
 *
 * ═══ Onde o plano mora ═══
 *
 * Não há tabela: os planos são a chave `task_plans` do jsonb
 * `organizations.settings` (lib/tarefas/plano.ts), a mesma que o PATCH de
 * `/api/v1/settings/task-plans` grava. Esta semente regrava SÓ essa chave com
 * os dois planos de ids fixos — o que as lições criam, editam ou excluem pela
 * tela some na próxima lição, e as outras chaves de `settings` (propostas,
 * tags, régua…) ficam intactas.
 *
 * A gravação é atômica (`jsonb_set` no Postgres local) quando há
 * SUPABASE_DB_URL: numa bancada em que outras sementes também regravam
 * `settings`, ler-mudar-gravar pelo client apagaria a chave de quem gravou no
 * meio. Sem a URL, cai no ler-mudar-gravar das outras sementes.
 */
import pg from "pg";

import { textoDaDemonstracao as demo } from "../espanhol-demonstracao";
import { type Contexto, exigir, semErro } from "../semear-demonstracao";
import { exigirBancoLocal } from "../seguranca";

const POS_AVALIACAO = "d1050000-0000-4000-8000-000000000001";
const BOAS_VINDAS = "d1050000-0000-4000-8000-000000000002";

type Prioridade = "low" | "medium" | "high" | "urgent";
type Atribuicao = "dono_do_lead" | { usuario_id: string };

const passo = (
  ordem: number,
  titulo: string,
  vence_em_dias: number,
  prioridade: Prioridade,
  atribuir_a: Atribuicao,
) => ({ ordem, titulo: demo(titulo), descricao: null, vence_em_dias, prioridade, atribuir_a });

export async function semear(c: Contexto) {
  const { db, org, pessoa } = c;
  const ana = { usuario_id: pessoa.ana };

  const planos = [
    {
      id: POS_AVALIACAO,
      nome: demo("Pós-avaliação de fisioterapia"),
      descricao: demo("Para quem fez a avaliação e ainda não fechou o pacote de sessões."),
      passos: [
        passo(1, "Ligar para {{contact.name}} e tirar as dúvidas sobre o pacote", 1, "high", "dono_do_lead"),
        passo(2, "Enviar os horários livres da semana para {{contact.name}}", 2, "medium", "dono_do_lead"),
        passo(3, "Perguntar se {{contact.name}} quer fechar o pacote", 5, "medium", "dono_do_lead"),
      ],
    },
    {
      id: BOAS_VINDAS,
      nome: demo("Boas-vindas ao paciente novo"),
      descricao: demo("Para quem acabou de fechar o tratamento na clínica."),
      passos: [
        passo(1, "Conferir o cadastro e o convênio de {{contact.name}}", 0, "high", ana),
        passo(2, "Enviar as orientações da primeira sessão", 1, "medium", ana),
        passo(3, "Ligar para saber como foi a primeira sessão", 7, "medium", "dono_do_lead"),
      ],
    },
  ];

  const url = process.env.SUPABASE_DB_URL;
  if (url) {
    const cli = new pg.Client({ connectionString: exigirBancoLocal(url) });
    await cli.connect();
    try {
      const r = await cli.query(
        `update public.organizations
            set settings = jsonb_set(coalesce(settings, '{}'::jsonb), '{task_plans}', $2::jsonb, true)
          where id = $1`,
        [org, JSON.stringify(planos)],
      );
      // A conexão direta precisa enxergar a MESMA organização do client Supabase.
      if (r.rowCount !== 1) throw new Error("Postgres direto não corresponde à organização da bancada Supabase");
    } finally {
      await cli.end();
    }
    return;
  }

  const linha = exigir(await db.from("organizations").select("settings").eq("id", org).single(), "settings") as {
    settings: Record<string, unknown> | null;
  };
  semErro(
    await db.from("organizations").update({ settings: { ...(linha.settings ?? {}), task_plans: planos } }).eq("id", org),
    "planos de tarefa da clínica",
  );
}
