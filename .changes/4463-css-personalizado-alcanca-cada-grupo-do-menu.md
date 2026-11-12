---
impacto: capacidade_nova
secao: adicionado
titulo: CSS personalizado alcança cada seção do menu lateral
---

O CSS personalizado da tela Marca da instalação só aceita seletor de classe, e os grupos do menu lateral não tinham classe nenhuma: não dava para dar uma cor ao CRM e outra ao Agente de IA. Agora cada grupo leva a classe `nav-grupo` e uma com o próprio nome (`nav-grupo-atendimento`, `nav-grupo-crm`, `nav-grupo-ia`, `nav-grupo-canais`, `nav-grupo-analise`), com exemplo no guia de white label.

Você não precisa fazer nada. Quem não usa CSS personalizado não vê diferença.

Contribuição de @renatomprado, a partir da issue #4463.
