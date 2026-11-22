import { redirect } from "next/navigation";

import { requireAuth, resolveActiveOrg } from "@/lib/auth/server";
import { createClient } from "@/lib/supabase/server";
import { lerRetratoDaInstalacao } from "@/lib/instalacao/retrato";
import { SetupAiForm } from "./_form";
import { InteligenciaDele } from "./_inteligencia";
import { capacidadesPadraoDoOnboarding } from "@/lib/ai/agents/capacidades-padrao";
import { TOOL_CATALOG } from "@/lib/mcp/tools/catalog";
import { NUNCA_FAZ, itensDaColuna } from "@/lib/ai/guardrails/lista-de-conferencia";
import { estadoEfetivoDasCamadas } from "@/lib/agent-engine/guardrails/camadas-da-org";
import { lerConfigDoJev } from "@/lib/ai/decisao/config";
import { estadoEfetivoDaTarefa, TAREFA_DA_AFIRMACAO_DE_FATO } from "@/lib/ai/decisao/tarefas";
import { traduzir } from "@/lib/i18n/dicionario";

export const dynamic = "force-dynamic";

/**
 * O passo que era "Configurar IA" e pedia dois campos.
 *
 * Ele é o coração da experiência: é aqui que a pessoa deixa de configurar um
 * sistema e passa a treinar alguém. Além do nome e do jeito de falar, agora
 * pergunta as REGRAS DA CASA — que vão para a memória da organização, valendo
 * para qualquer agente, e não para o prompt deste — e mostra, sem pedir
 * configuração nenhuma, o que ele já vem sabendo fazer e o que nunca vai fazer.
 *
 * As duas listas saem das MESMAS fontes que o runtime usa: as capacidades do
 * pacote que o agente recebe ligado, e as conferências que rodam antes de cada
 * mensagem sair. Escrever essas frases à mão aqui seria a tela prometendo um
 * comportamento que o código não garante.
 */
export default async function SetupAiPage() {
  const user = await requireAuth();
  const activeOrg = await resolveActiveOrg(user);
  if (!activeOrg) redirect("/login");
  const idioma = user.idioma;

  const supabase = await createClient();
  const retrato = await lerRetratoDaInstalacao({ supabase, orgId: activeOrg.orgId });

  const porNome = new Map(TOOL_CATALOG.map((c) => [c.name, c]));
  const capacidades = capacidadesPadraoDoOnboarding()
    .map((id) => porNome.get(id)?.rotulo)
    .filter((r): r is string => Boolean(r))
    .map((r) => traduzir(r, idioma));

  /*
    O ESTADO REAL DE CADA CONFERÊNCIA (#1041).

    A coluna dizia "nunca faz" para todos os itens sem distinguir os que
    rodam sempre das quatro que dependem de um interruptor — e numa organização
    recém-criada as quatro vêm desligadas. Prometer proteção que não roda é pior
    do que não listá-la.

    A leitura é a MESMA que o motor faz: a linha de `org_guardrail_layers`
    quando existe, o padrão do ambiente quando não existe
    (`estadoEfetivoDasCamadas` → `camadaLigada`); e, para a conferência de fato,
    a tarefa do Jev (`estadoEfetivoDaTarefa`), que é quem decide aquela camada.
    Falha de leitura devolve `[]`/`null` e cai no padrão do ambiente — é o que o
    motor faz de verdade num clone que atualizou o código antes do schema.
  */
  const [{ data: linhasDasCamadas }, { data: orgRow }] = await Promise.all([
    supabase.from("org_guardrail_layers").select("layer, enabled").eq("organization_id", activeOrg.orgId),
    supabase.from("organizations").select("settings").eq("id", activeOrg.orgId).maybeSingle(),
  ]);
  const itens = itensDaColuna({
    painel: estadoEfetivoDasCamadas(linhasDasCamadas ?? []),
    afirmacaoDeFato: estadoEfetivoDaTarefa(lerConfigDoJev(orgRow?.settings), TAREFA_DA_AFIRMACAO_DE_FATO),
  });

  // `Object.values(NUNCA_FAZ)` e não `itens`: a frase continua saindo da tabela
  // como literal resolvível — é o que o gate de espanhol varre. A ordem é a
  // mesma (o teste `onboarding-frases-do-novo-tenant` reprova se deixar de ser),
  // e o índice só junta a fala traduzida ao estado lido do motor.
  const frases = Object.values(NUNCA_FAZ).map((frase) => traduzir(frase, idioma));
  // `?? item.frase`: com as duas listas do mesmo tamanho o índice sempre existe;
  // se um dia não existir, a fala sai em português em vez de vazia.
  const conferencias = itens.map((item, i) => ({ ...item, frase: frases[i] ?? item.frase }));

  return (
    <div className="space-y-6">
      <header>
        <h2 className="text-2xl font-semibold tracking-tight">{traduzir("Treine seu funcionário", idioma)}</h2>
        <p className="text-sm text-muted-foreground">
          {traduzir("Quem ele é, como fala e o que pode prometer. Dá para mudar tudo depois.", idioma)}
        </p>
      </header>
      {/*
        O cérebro vem ANTES do resto do formulário: sem chave, nada do que a
        pessoa preencher abaixo produz um funcionário que responde. E é aqui que
        a chave passa a importar — um clique antes de ele ser criado com ela.
      */}
      <InteligenciaDele
        inicial={{
          origem: retrato.inteligencia.origemDaChave,
          provedor: retrato.inteligencia.provedor,
          rotulo: retrato.inteligencia.rotulo,
          final: retrato.inteligencia.chaveDaOrg?.final ?? null,
        }}
      />

      <SetupAiForm capacidades={capacidades} conferencias={conferencias} />
    </div>
  );
}
