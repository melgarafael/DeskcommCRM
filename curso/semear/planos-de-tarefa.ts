/**
 * Semente do módulo "Planos de tarefa" (CRM › Ver tudo em CRM › Planos de tarefa).
 *
 * Sem plano nenhum a tela é uma frase ("Nenhum plano cadastrado ainda.") e o
 * seletor da ação "Aplicar um plano de tarefas ao negócio", no editor de
 * automações, fica vazio. Por isso a clínica ganha dois planos prontos: um com
 * todos os passos no dono do negócio e outro com passos de uma pessoa fixa
 * (a Ana Ribeiro), para as lições mostrarem as duas formas de "Atribuir a".
 *
 * ═══ Onde o plano mora ═══
 *
 * Não há tabela: os planos são a chave `task_plans` do jsonb
 * `organizations.settings` (lib/tarefas/plano.ts), a mesma que o PATCH de
 * `/api/v1/settings/task-plans` grava. Esta semente regrava SÓ essa chave com
 * os dois planos de ids fixos; as outras chaves de `settings` (propostas,
 * tags, régua…) ficam intactas.
 *
 * A gravação é atômica (`jsonb_set` no Postgres local) quando há
 * SUPABASE_DB_URL: numa bancada em que outras sementes também regravam
 * `settings`, ler-mudar-gravar pelo client apagaria a chave de quem gravou no
 * meio. Sem a URL, cai no ler-mudar-gravar das outras sementes.
 *
 * Exporta `limpar`, que a base chama antes de QUALQUER aula. A base já devolve
 * `settings` ao estado de fábrica, mas a semente precisa se desfazer sozinha
 * (quem aplica só o módulo não ressemeia a base), e a automação que a última
 * lição monta não mora em `settings`: sobreviveria e entraria na aula de
 * Automações.
 */
import pg from "pg";

import { textoDaDemonstracao as demo, traducaoDaDemonstracao } from "../espanhol-demonstracao";
import { type Contexto, exigir, semErro } from "../semear-demonstracao";
import { exigirBancoLocal } from "../seguranca";

const POS_AVALIACAO = "d1050000-0000-4000-8000-000000000001";
const BOAS_VINDAS = "d1050000-0000-4000-8000-000000000002";
/** Os planos desta semente: a lição de editar muda o conteúdo, mas mantém o id. */
const IDS_DA_SEMENTE = [POS_AVALIACAO, BOAS_VINDAS];
/** O plano que a lição "Criar um plano" salva pela tela: o id é aleatório, só o nome o acha. */
const CRIADOS_NAS_LICOES = ["Retorno da nutrição"];
/**
 * A automação da última lição. A foto para antes de "Criar automação", mas quem
 * segue a lição até o fim grava a regra, e ela apareceria na aula de Automações.
 */
const AUTOMACAO_DA_LICAO = "Boas-vindas a quem fechou o tratamento";

/**
 * O nome nos dois idiomas. `traducaoDaDemonstracao` só consulta e não lança: esta
 * limpeza roda antes de toda aula, em PT e em ES, e precisa achar o que sobrou da outra.
 */
const nosDoisIdiomas = (nomes: readonly string[]) => [
  ...new Set(nomes.flatMap((n) => [n, traducaoDaDemonstracao(n) ?? n])),
];

type Prioridade = "low" | "medium" | "high" | "urgent";
type Atribuicao = "dono_do_lead" | { usuario_id: string };

const passo = (
  ordem: number,
  titulo: string,
  vence_em_dias: number,
  prioridade: Prioridade,
  atribuir_a: Atribuicao,
) => ({ ordem, titulo: demo(titulo), descricao: null, vence_em_dias, prioridade, atribuir_a });

/** Conexão direta ao Postgres local, que a gravação atômica de `settings` exige. */
async function noPostgresLocal<T>(url: string, fn: (cli: pg.Client) => Promise<T>): Promise<T> {
  const cli = new pg.Client({ connectionString: exigirBancoLocal(url) });
  await cli.connect();
  try {
    return await fn(cli);
  } finally {
    await cli.end();
  }
}

/**
 * Tira de `task_plans` só os planos desta semente (pelo id) e os que as lições
 * criam (pelo nome); os de outra origem ficam. Se a lista esvazia, a chave sai
 * inteira, como no estado de fábrica. Apaga também a automação da última lição
 * (só desta organização; execuções e rodízio caem junto, on delete cascade).
 *
 * Roda centenas de vezes: depois da base a chave nem existe, então a leitura
 * barata pelo client decide e, sem plano nosso, nada mais é gravado.
 */
export async function limpar(c: Contexto) {
  const { db, org } = c;
  semErro(
    await db
      .from("automation_rules")
      .delete()
      .eq("organization_id", org)
      .in("name", nosDoisIdiomas([AUTOMACAO_DA_LICAO])),
    "limpar a automação da lição de planos",
  );

  const nomes = nosDoisIdiomas(CRIADOS_NAS_LICOES);
  const eNosso = (p: unknown) => {
    const plano = (p ?? {}) as { id?: unknown; nome?: unknown };
    return IDS_DA_SEMENTE.includes(String(plano.id)) || nomes.includes(String(plano.nome));
  };
  const { planos } = exigir(
    await db.from("organizations").select("planos:settings->task_plans").eq("id", org).single(),
    "planos de tarefa da clínica",
  ) as { planos: unknown };
  if (!Array.isArray(planos) || !planos.some(eNosso)) return;

  const url = process.env.SUPABASE_DB_URL;
  if (url) {
    await noPostgresLocal(url, async (cli) => {
      // Filtra e grava no MESMO comando: um plano que alguém salvou entre a
      // leitura acima e aqui não some, e as outras chaves de `settings` também não.
      const r = await cli.query(
        `update public.organizations o
            set settings = (
              select case when count(*) = 0 then o.settings - 'task_plans'
                          else jsonb_set(o.settings, '{task_plans}', jsonb_agg(t.p order by t.i)) end
                from jsonb_array_elements(o.settings->'task_plans') with ordinality t(p, i)
               where not coalesce(t.p->>'id' = any($2::text[]) or t.p->>'nome' = any($3::text[]), false))
          where o.id = $1
            and jsonb_typeof(o.settings->'task_plans') = 'array'
            and exists (select 1 from jsonb_array_elements(o.settings->'task_plans') t(p)
                         where t.p->>'id' = any($2::text[]) or t.p->>'nome' = any($3::text[]))`,
        [org, IDS_DA_SEMENTE, nomes],
      );
      // Zero linhas só é normal se outra gravação já tirou os planos; se a
      // organização nem existe ali, a conexão direta aponta para outro banco.
      if (r.rowCount === 0) {
        const existe = await cli.query("select 1 from public.organizations where id = $1", [org]);
        if (existe.rowCount !== 1) throw new Error("Postgres direto não corresponde à organização da bancada Supabase");
      }
    });
    return;
  }

  const linha = exigir(await db.from("organizations").select("settings").eq("id", org).single(), "settings") as {
    settings: Record<string, unknown> | null;
  };
  const { task_plans: atuais, ...outras } = linha.settings ?? {};
  const resto = Array.isArray(atuais) ? atuais.filter((p) => !eNosso(p)) : [];
  semErro(
    await db
      .from("organizations")
      .update({ settings: resto.length ? { ...outras, task_plans: resto } : outras })
      .eq("id", org),
    "limpar os planos de tarefa da clínica",
  );
}

export async function semear(c: Contexto) {
  await limpar(c);
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

  // A chave inteira é regravada com os dois planos, como sempre foi: o que
  // `limpar` já tirou não volta, e um plano de outra origem também não fica.
  const url = process.env.SUPABASE_DB_URL;
  if (url) {
    await noPostgresLocal(url, async (cli) => {
      const r = await cli.query(
        `update public.organizations
            set settings = jsonb_set(coalesce(settings, '{}'::jsonb), '{task_plans}', $2::jsonb, true)
          where id = $1`,
        [org, JSON.stringify(planos)],
      );
      // A conexão direta precisa enxergar a MESMA organização do client Supabase.
      if (r.rowCount !== 1) throw new Error("Postgres direto não corresponde à organização da bancada Supabase");
    });
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
