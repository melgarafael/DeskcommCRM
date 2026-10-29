---
impacto: nada_mudou
secao: alterado
titulo: O menu pede a tela só quando alguém vai para ela
---

A barra lateral deixava o `<Link>` do App Router prefetchar cada item visível: medido, uma tela de `/app` disparava 37 requisições `?_rsc=` sozinha (3 a 4 depois), cada uma um render completo (verificação de sessão no proxy, `loadAuthUser` e as cinco consultas da casca) para devolver apenas o esqueleto de ~2,3 KB — e esses renders disputavam o servidor com a tela que a pessoa clicou. O prefetch do menu passa a ser por intenção: ponteiro sobre o item ou foco pelo teclado, uma vez por destino. Nada muda no que a tela mostra; muda quanto ela pede antes de alguém pedir.
