---
impacto: exige_acao
secao: corrigido
titulo: A IA só lê o campo personalizado que o funil marcou como legível
---

Dois caminhos mandavam ao modelo o valor de TODO campo personalizado do funil,
mesmo o que o dono do funil não liberou: o bloco do negócio que o follow-up
escrito por IA recebe no prompt e a leitura `crm_get_lead` durante um turno de
agente. Documento, dado de saúde e observação interna saíam do card e chegavam
ao modelo sem que ninguém tivesse autorizado — e a marca de leitura pela IA nem
sobrevivia à leitura do funil, porque o schema do campo não a conhecia.

Agora a marca `ia_pode_ler` do campo existe no funil e é a única autorização:
os dois caminhos só levam o campo marcado, e a leitura do negócio por token de
pessoa continua devolvendo a ficha inteira, porque quem lê ali é uma pessoa com
a própria permissão. Campo antigo, sem a marca, é tratado como não autorizado.

## Requer atenção

Campo personalizado que já existia, sem a marca, deixa de ir ao modelo até ser
marcado. Ao atualizar, abra Configurações → Etapas do funil, no fim de cada
campo, e marque "A IA pode ler este campo" nos campos que o agente pode usar no
atendimento; os demais seguem só no card. Nada a instalar: a definição do campo
mora no próprio funil.
