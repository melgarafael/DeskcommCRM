---
impacto: capacidade_nova
secao: adicionado
titulo: A caixa de consentimento do formulário de anúncio da Meta chega ao lead
---

Quem usa formulário de anúncio da Meta com a busca das respostas ligada passa a receber no lead as caixas do aviso personalizado do formulário, que é onde se costuma pedir a autorização para ligar e mandar mensagem. Cada caixa aparece nos campos do negócio como `custom_disclaimer_` mais o nome da caixa na Meta, com `true` quando a pessoa marcou e `false` quando não marcou. Antes elas se perdiam, porque a Meta não as manda junto das outras respostas. Os campos chegam também às automações, então um envio por webhook leva a resposta da caixa. Formulário sem aviso personalizado continua igual. Contribuição de @edgariamaguti.
