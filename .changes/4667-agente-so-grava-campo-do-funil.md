---
impacto: capacidade_nova
secao: corrigido
titulo: O agente de IA só grava nos campos personalizados que o funil tem
---

O agente de IA não tinha como saber quais campos personalizados o funil tem e, ao guardar uma informação da conversa, às vezes inventava o nome do campo. O valor ia para o negócio sem aparecer no card. Agora a lista de funis que o agente consulta traz os campos de cada funil, e quando o agente usa um nome que o funil não tem, nada é gravado e ele recebe a lista dos campos certos. Campos preenchidos pela tela, por automação ou por integração com token continuam como antes. Se o prompt do seu agente manda guardar uma informação num campo, confira se esse campo existe no funil. Para quem integra pelo MCP: `crm_list_pipelines` passa a devolver `fields` em cada funil, e `campos_nao_gravados` pode trazer o motivo novo `chave_fora_do_funil`.

Contribuição de @tabaterral (#4667).
