---
impacto: exige_acao
secao: corrigido
titulo: A IA só lê o campo personalizado que o funil marcou como legível
---

O modelo recebia o valor de TODO campo personalizado do funil, mesmo o que o
dono do funil não liberou: no bloco do negócio que o follow-up escrito por IA
recebe no prompt e em toda resposta de ferramenta de negócio durante um turno
de agente — a leitura (`crm_get_lead`, `crm_list_leads`) e também a escrita
(`crm_create_lead`, `crm_update_lead`, `crm_move_lead_stage`,
`crm_retomar_lead`), que devolvem o negócio inteiro. Documento, dado de saúde e
observação interna saíam do card e chegavam ao modelo sem que ninguém tivesse
autorizado — e a marca de leitura pela IA nem sobrevivia à leitura do funil,
porque o schema do campo não a conhecia.

Agora a marca `ia_pode_ler` do campo existe no funil e é a única autorização:
o follow-up e as respostas das ferramentas de negócio no turno só levam o campo
marcado, e a leitura do negócio por token de pessoa continua devolvendo a ficha
inteira, porque quem lê ali é uma pessoa com a própria permissão. Campo antigo,
sem a marca, é tratado como não autorizado.

Contribuição de @webtecnica (#4684, issue #4669).

## Requer atenção

Campo personalizado que já existia, sem a marca, deixa de ir ao modelo até ser
marcado. Ao atualizar, abra CRM → Ver tudo em CRM → Etapas do funil (seção
"Preparar a venda") e, no fim de cada campo do negócio, marque "A IA pode ler
este campo" nos campos que o agente pode usar no atendimento; os demais seguem
só no card. Nada a instalar: a definição do campo mora no próprio funil.
