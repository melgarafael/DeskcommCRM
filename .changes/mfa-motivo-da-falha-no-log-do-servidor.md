---
impacto: nada_mudou
secao: corrigido
titulo: A falha ao ativar a verificação em duas etapas deixa o motivo no log do servidor
---

Quando o cadastro do fator de verificação em duas etapas falhava — ou quando o
código de 6 dígitos era recusado na confirmação — o motivo que o provedor
devolveu não ficava registrado no servidor. Quem opera a VPS via « não consegui ativar a verificação » e não tinha
como saber se o problema era um fator antigo já cadastrado, o relógio do celular
fora de sincronia ou o fator que ficou pela metade.

Agora esse motivo sai no log estruturado do servidor, no mesmo ponto em que a
falha acontece. O código de 6 dígitos e o segredo do fator nunca entram nesse
registro. A remoção do fator não confirmado, que antes falhava em silêncio e
deixava o cadastro novo morrer em « já existe », também passa a aparecer no log.
Nada muda na tela: o que era mostrado continua igual.
