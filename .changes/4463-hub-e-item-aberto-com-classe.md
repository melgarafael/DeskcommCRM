---
impacto: capacidade_nova
secao: adicionado
titulo: O link de hub e o item aberto do menu ganham classe estável para o CSS personalizado
---

O contrato de classes do menu lateral (`lib/navigation/classes-estaveis.ts`) prometia
uma classe por destino, mas o menu desenhava duas exceções — e são justamente as que
quebram o contraste que a #4463 quer proteger.

O link "Ver tudo em …" (o hub de CRM, IA e Análise) é a única porta desses grupos e
não levava `classeDoItem`, embora o mapa href → classe derivasse o nome dele: quem
pintava `.nav-grupo-crm` não alcançava o hub, e o mapa não o listava. Agora o hub leva
`nav-item-crm`, `nav-item-ai`, `nav-item-analise` (e `nav-item-settings` no rodapé), e
`CLASSES_DE_ITEM` inclui os hubs.

O item da tela aberta era o outro lado: ele é o único do menu com fundo na cor de
destaque, e quem pinta o grupo por `.rounded-md:hover` acerta nele também. O único
marcador existente era `aria-current="page"` — atributo, que o validador de
`/admin/marca` recusa de propósito, e `:not()` não está na allowlist. Passa a existir
`nav-item-ativo`, aplicada só ao link da rota atual (destino, hub ou rodapé): com ela,
o dono dá cor ao item aberto ou repete nele o fundo neutro do menu, sem atributo.

Nada muda no validador: continua aceitando só seletor de classe, e as cercas de
`url()`, `@import`, `expression`, id, tag e propriedade fora da lista seguem iguais.
A doc de marca (`docs/white-label.md`, `.en.md`, `.es.md`) passa a nomear as duas
classes. Contribuição de @webtecnica (#4463).
