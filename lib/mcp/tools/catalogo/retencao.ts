/**
 * Capacidades de RETENÇÃO — o pacote "Não perder o cliente".
 *
 * Este é o pacote do invariante 4 da doutrina (`docs/doctrine/sistema-vivo.md`):
 * nenhuma demanda aberta pode ficar sem próximo passo definido e visível. Até
 * esta wave ele estava VAZIO — a máquina de retorno existia, rodava e era
 * invisível para o agente que o dono da clínica configura na tela. Um agente que
 * não consegue marcar um retorno não consegue cumprir a missão do sistema.
 *
 * As duas saídas do invariante estão aqui: marcar o próximo passo (agendar,
 * cancelar, listar retorno) e registrar o desfecho (encerrar a demanda). Sem a
 * segunda, o anti-morte fica pela metade e o radar enche de negócio que já acabou.
 *
 * ESTE ARQUIVO FALA COM O HUMANO que configura o agente — `rotulo`,
 * `explicacao` e `oQueToca`. O texto que vai ao MODELO é a `description` do
 * HANDLER (`lib/mcp/tools/<dominio>.ts`), e ela NÃO tem cópia aqui: até
 * 2026-08-07 tinha, ninguém lia essa cópia, e 48 das 51 divergiam do que o
 * modelo realmente recebia. O campo foi removido em vez de sincronizado —
 * duplicata que ninguém lê não é documentação, é armadilha: um script de
 * medição de vazamento chegou a montar o prompt com o texto errado, sob um
 * comentário dizendo "a ferramenta como o modelo a vê".
 * Ver `docs/handoffs/BRIEFING-ia-360.md` §4.
 *
 * ⚠️ "FOLLOW-UP" NÃO APARECE NO TEXTO DO HUMANO. Para o dono da clínica isso se
 * chama RETORNO ou acompanhamento — o gate mecânico
 * (`tests/unit/catalogo-tools-leigo-friendly.test.ts`) reprova o jargão, e a
 * palavra continua existindo só no `name`, que é contrato de wire.
 */
import { declararTools } from "./tipos";

export const TOOLS_RETENCAO = declararTools([
  {
    name: "crm_schedule_followup",
    category: "write",
    rotulo: "Agendar um retorno para o cliente",
    explicacao:
      "Marca um horário para o agente voltar a falar com o cliente, para que a conversa não morra sem resposta.",
    oQueToca: "Retornos e acompanhamento",
    // `atencao` e não `critico`: agendar não fala com ninguém agora. O envio no
    // horário combinado passa pelos mesmos portões de sempre, e o humano vê o
    // retorno na fila e no Radar, com botão de cancelar. É reversível pela tela —
    // que é exatamente a definição deste nível.
    risco: "atencao",
    pacotes: ["reter"],
  },
  {
    name: "crm_enroll_followup_flow",
    category: "write",
    rotulo: "Iniciar um acompanhamento configurado",
    explicacao:
      "Coloca o cliente num acompanhamento já montado na tela, que decide quando falar, o que dizer e quando parar.",
    oQueToca: "Retornos e acompanhamento",
    // Mesmo nível de `crm_schedule_followup`, e pelo mesmo motivo: inscrever não
    // fala com ninguém agora. Cada envio do fluxo passa pelos portões de sempre,
    // e o acompanhamento aparece na fila com botão de cancelar.
    risco: "atencao",
    pacotes: ["reter"],
  },
  {
    name: "crm_cancel_followup",
    category: "write",
    rotulo: "Cancelar um retorno agendado",
    explicacao:
      "Desmarca um retorno que ainda não aconteceu, para o agente não insistir com quem já respondeu.",
    oQueToca: "Retornos e acompanhamento",
    risco: "atencao",
    pacotes: ["reter"],
  },
  {
    name: "crm_list_followups",
    category: "read",
    rotulo: "Ver os retornos de um cliente",
    explicacao:
      "Mostra os retornos combinados com o cliente: o que está marcado, o que já aconteceu e o que foi desmarcado.",
    oQueToca: "Retornos e acompanhamento",
    risco: "seguro",
    pacotes: ["reter"],
  },
  {
    name: "crm_list_at_risk_leads",
    category: "read",
    rotulo: "Ver quem esfriou e quem ficou sem próximo passo",
    explicacao:
      "Lista as oportunidades abertas que passaram do prazo sem movimento, das mais críticas para as menos " +
      "urgentes — e, junto, as pessoas que estão esperando sem que nada esteja marcado para acontecer.",
    oQueToca: "Radar de risco",
    risco: "seguro",
    pacotes: ["reter"],
  },
  {
    name: "crm_close_demand",
    category: "write",
    rotulo: "Encerrar o negócio como ganho ou perdido",
    explicacao:
      "Fecha a oportunidade dizendo se ela foi ganha ou perdida e por quê, para o que já acabou parar de ser cobrado.",
    oQueToca: "Funil de vendas",
    // `critico` porque encerrar é o desfecho: o negócio sai do quadro, some do
    // radar e das cobranças, e voltar atrás é trabalho manual. Nunca entra ligado
    // por pacote — exige marcação explícita de quem configura.
    risco: "critico",
    pacotes: ["reter"],
  },
  {
    name: "crm_propose_reactivation",
    category: "write",
    rotulo: "Sugerir retomar contato com quem sumiu",
    explicacao:
      "Cria uma sugestão de retomar o contato com um cliente que esfriou, para uma pessoa aprovar antes de qualquer envio.",
    oQueToca: "Radar de risco",
    // Escreve uma SUGESTÃO que uma pessoa decide — nada sai para o cliente por
    // conta dela. É `atencao`, e o `critico` mora na aprovação humana.
    risco: "atencao",
    pacotes: ["reter"],
  },
  {
    // Fica em "reter" e não em "evoluir" de propósito: o pacote "Aprender e
    // evoluir" já cabe no teto só com as 27 vagas que tem, e uma capacidade a
    // mais nele tiraria todas as jornadas da lista de "cabem depois do agente
    // nascer". O pacote "reter" já não cabe no teto, então a conta dos demais não muda.
    name: "crm_get_prospecting_site_audit",
    category: "read",
    rotulo: "Consultar a análise do site da empresa",
    explicacao:
      "O agente pode consultar o que o sistema achou no site da empresa prospectada (tem site, está fora do ar, problemas) em qualquer momento da conversa.",
    oQueToca: "Análise do site da empresa",
    risco: "seguro",
    pacotes: ["reter"],
  },
  {
    name: "crm_save_lead_diagnosis",
    category: "write",
    rotulo: "Registrar o diagnóstico da empresa",
    explicacao:
      "Grava na ficha do contato o segmento, o CNPJ, o diagnóstico da empresa e a oferta sugerida, com o selo Escrito pela IA. Depois que alguém da equipe escreve o diagnóstico ou a oferta na aba Diagnóstico, a IA não troca mais o que está lá. Não mexe nas observações da equipe nem nos outros campos da ficha.",
    oQueToca: "Cadastro de clientes",
    // `atencao`: muda a ficha, mas nada sai para o cliente, o texto fica à
    // vista com o selo e a equipe desfaz editando a aba.
    risco: "atencao",
    // "reter", ao lado da análise do site e pela MESMA conta: o plano pedia
    // "vender", mas em "vender" ela entraria no agente que nasce no onboarding
    // e tiraria a última jornada que ainda cabe depois dele ("evoluir" passaria
    // de 27 para 28 vagas, medido em `pacote-reserva-vaga-da-critica.test.ts`).
    // Quem precisa dela é o agente da prospecção, e `lib/prospecting/agent-setup.ts`
    // a liga por nome.
    // O ALCANCE do pacote: ligar "reter" numa tela de capacidades também a liga
    // (o risco `atencao` entra por pacote), inclusive em agente de retenção que
    // atende cliente antigo. Por isso a cerca não depende de quem a liga: o que
    // uma pessoa da equipe assinou não é sobrescrito (`gravacaoDoAgente`), e o
    // agente só alcança o contato da conversa.
    pacotes: ["reter"],
  },
]);
