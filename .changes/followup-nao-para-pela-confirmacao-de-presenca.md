---
impacto: nada_mudou
secao: corrigido
titulo: Uma falha na confirmação de presença da agenda não para mais os follow-ups
---

A verificação de confirmações de presença da agenda roda na mesma rodada que dispara os follow-ups. Quando ela falhava, a rodada inteira parava antes de chegar aos follow-ups, e nenhuma organização recebia os seus até a agenda voltar a funcionar. Agora a falha fica só na agenda: os follow-ups saem normalmente, e o erro fica registrado no log, na trilha de auditoria e no monitoramento de erros, quando ele está configurado. Nada precisa ser feito ao atualizar. Contribuição de @Wyllams.
