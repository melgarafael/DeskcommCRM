---
impacto: capacidade_nova
secao: adicionado
titulo: CSS personalizado pinta o conteúdo de cada seção, não só o menu
---

Em Administração › Marca, o CSS personalizado já tinha classes estáveis no menu lateral (`nav-grupo-crm` e as demais), mas a cor parava na barra: o conteúdo das telas não dizia em que seção a pessoa estava. Agora o contêiner do conteúdo de toda tela leva `tela-secao` e, quando a rota está no menu, também a da seção: `tela-secao-atendimento`, `tela-secao-crm`, `tela-secao-ia`, `tela-secao-canais`, `tela-secao-analise` ou `tela-secao-organizacao`. Com ela, uma regra como `.tela-secao-crm .rounded-lg { border-top-color: #1d4ed8; }` vale só nas telas de CRM.

Uma classe `tela-secao-` que não existe é recusada ao salvar, com a lista das que existem, em vez de ser gravada sem pintar nada. Quem não usa CSS personalizado não vê diferença.

Contribuição de @webtecnica (#4709), a partir da issue #4705 de @renatomprado.
