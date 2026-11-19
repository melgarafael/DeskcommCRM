---
impacto: capacidade_nova
secao: corrigido
titulo: O agente de IA não grava mais dados em campos que o funil não tem
---

Às vezes, ao criar ou atualizar um negócio, o agente de IA guardava uma informação num campo personalizado com nome inventado, que não existe no funil. A informação ficava salva, mas não aparecia em nenhuma tela, e ninguém era avisado. Agora, quando o agente tenta preencher um campo que o funil não tem, essa informação não é salva e ele recebe de volta a lista dos campos de negócio daquele funil, para poder usar o nome certo. Os outros campos preenchidos na mesma vez são salvos normalmente. Isso vale ao criar e ao atualizar um negócio, e só para o agente de IA: o que é preenchido na tela, pelas automações ou por integrações com token de API é salvo como antes. As informações que já estavam em campos inventados não são apagadas e continuam sem aparecer na tela. Não é preciso fazer nada na VPS. Se o prompt de algum agente pede para preencher um campo do negócio, vale conferir se esse campo existe no funil: no menu CRM, clique em Ver tudo em CRM, abra Etapas do funil e use o botão "Editar vocabulário e campos deste funil". Para quem integra pelo servidor MCP: na resposta das ferramentas `crm_create_lead` e `crm_update_lead`, a lista `campos_nao_gravados` pode trazer o motivo novo `chave_fora_do_funil`, mas só quando quem grava é o agente de IA. Para integrações com token de API, nada muda.

Contribuição de @tabaterral (#4667).
