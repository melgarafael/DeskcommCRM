---
impacto: capacidade_nova
secao: corrigido
titulo: O agente de IA passa a consultar os campos do funil e não grava mais em campo que o funil não tem
---

O agente de IA às vezes guardava dados num campo inventado, invisível na tela, e ninguém era avisado. Agora ele consulta os campos do funil e, se ainda assim tentar gravar num campo fora dele, esse valor não é gravado e ele recebe a lista dos campos válidos; os outros campos da mesma gravação são gravados normalmente. A recusa só vale para o agente de IA: tela, automação e integração com token gravam como antes. Valores antigos em campo inventado não são apagados e continuam sem aparecer. Nada a fazer na VPS. Se um prompt manda preencher um campo do negócio, confira se o campo existe em CRM › Ver tudo em CRM › Etapas do funil, botão "Vocabulário e campos". Para quem integra: `crm_list_pipelines` passa a devolver `fields` em cada funil, e `campos_nao_gravados` pode trazer o motivo novo `chave_fora_do_funil`.

Contribuição de @tabaterral (#4667).
