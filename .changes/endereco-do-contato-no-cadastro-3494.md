---
impacto: capacidade_nova
secao: adicionado
titulo: Contato pessoa física: endereço já no cadastro, com o CEP preenchendo os campos
---

O contato pessoa física já guardava CEP, logradouro, número, complemento,
bairro, cidade e UF desde a entrega das colunas, mas só a **ficha** tinha esses
campos: quem cadastrava precisava salvar o contato e abrir a ficha depois para
informar o endereço que a entrega e a cobrança leem. E em nenhuma das duas telas
o CEP preenchia nada — bairro e cidade eram digitados à mão, que é onde o frete
erra.

Agora o cadastro tem a seção **Endereço** com os mesmos sete campos da ficha, e
sair do campo CEP consulta a BrasilAPI e preenche logradouro, bairro, cidade e
UF. Número e complemento nunca são sobrescritos (são do imóvel, não do CEP), e
um CEP que a consulta não conhece não apaga o que já estava digitado.

A consulta só vale para organização no Brasil, e só roda quando o CEP mudou:
passar pelo campo sem alterá-lo não reescreve o endereço. Resposta que chega
depois de a pessoa trocar o CEP ou fechar o diálogo é descartada.

A consulta acontece para qualquer pessoa com papel **agent** ou acima — o mesmo
piso de criar e editar contato. CEP curto, com letra ou fora do ar é aviso ao
lado do campo e **não impede salvar**: pessoa física sem CEP continua sendo
cadastro válido, e o que foi digitado é gravado como está.
