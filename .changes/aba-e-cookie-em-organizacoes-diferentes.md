---
impacto: nada_mudou
secao: corrigido
titulo: Gravar a partir de uma aba que ficou na organização antiga passa a ser recusado (nas telas que usam o cliente da API), e a aba avisa quando a sessão mudou
---

O cookie `active_org` é um por sessão do navegador e vale para todas as abas, mas a organização que cada aba mostra vem das props do layout e fica fixa enquanto o documento vive. Quem trocava de empresa pelo seletor recarregava só a própria aba: as outras continuavam exibindo a organização antiga, enquanto as leituras e as escritas daquela aba já iam para a organização do cookie.

Agora a aba avisa ("Esta aba está numa organização diferente da sessão. Recarregar?") quando percebe que a sessão mudou. O aviso **não recarrega sozinho**: quem decide é a pessoa, e o formulário em edição fica onde está. Na escrita, as telas que gravam pelo cliente da API (`apiClient`) declaram a organização da aba, e o servidor recusa com o código `org_divergente` (409) quando ela não bate com a do cookie. A organização em que se grava continua sendo sempre a do cookie, validada contra a participação da pessoa; a declaração da aba só serve para recusar.

O que ainda NÃO está coberto: as telas que gravam com `fetch` direto e as server actions não declaram a organização da aba, então nelas a escrita segue indo para a organização do cookie, como antes. O restante fica na #2335. Nada muda na configuração.

Relatado por @aleflores35 (#2313). Contribuição de @webtecnica (#2360, Refs #2335).
