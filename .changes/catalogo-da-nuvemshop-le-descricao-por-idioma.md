---
impacto: nada_mudou
secao: corrigido
titulo: O catálogo da Nuvemshop volta a entrar na base de conhecimento do agente
---

Com uma loja Nuvemshop conectada, a fonte "Catálogo de produtos" da base de conhecimento ficava com zero trechos e mostrava o erro `html.replace is not a function`. A Nuvemshop manda a descrição de cada produto separada por idioma da loja, e o preparo do material tratava a descrição como texto simples, então quebrava no primeiro produto. Agora a descrição é lida como o nome já era: português primeiro e, numa loja só em espanhol ou inglês, o idioma que existir. Produto sem descrição não derruba mais a fonte inteira. Para trazer o catálogo, abra a base de conhecimento e clique em "Preparar de novo" no cartão "Catálogo de produtos".

Cada aviso que a Nuvemshop manda (pedido ou produto) também passa a ficar registrado na auditoria. Antes, essa gravação falhava em todo aviso.
