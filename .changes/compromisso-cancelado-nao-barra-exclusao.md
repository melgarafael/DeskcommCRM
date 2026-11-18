---
impacto: nada_mudou
secao: corrigido
titulo: Contato com compromisso cancelado na Agenda pode ser excluído
---

Excluir um contato que já teve um compromisso cancelado na Agenda era recusado com o aviso "Cancele ou apague o compromisso antes de excluir". Cancelar não liberava a exclusão, e a Agenda não tem como apagar um compromisso, então esse contato nunca saía da base. Agora o compromisso cancelado não segura mais a exclusão: ele continua na Agenda de quem atendeu, sem o vínculo com o contato excluído. Compromisso marcado, realizado ou com falta continua impedindo a exclusão, e o aviso passa a pedir só o que dá para fazer: cancelar. Nenhuma ação é necessária na atualização.
