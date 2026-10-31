---
impacto: capacidade_nova
secao: corrigido
titulo: Formulário que manda só nome e e-mail cria o contato, e o envio completa telefone ou e-mail que faltavam na ficha
---

Quando um formulário do site (captação por webhook) mandava só nome e e-mail, o card nascia sem contato: a pessoa não aparecia em Contatos e não juntava histórico. E quando a mesma pessoa preenchia depois outro formulário com o mesmo e-mail e um telefone, o telefone era descartado, e o card ficava ligado a um contato sem número.

Agora o e-mail também identifica o contato: o envio sem telefone acha o contato pelo e-mail, ou cria um, e o card nasce ligado a ele. Quando o contato já existe, o envio completa só o que está vazio na ficha: o telefone num contato que só tinha e-mail, ou o e-mail num contato que só tinha telefone. Nada que já está preenchido é trocado. Se o telefone já pertence a outro contato da organização, o card segue o dono do número e nenhuma ficha é alterada. Contato marcado como pessoal e contato anonimizado nunca são completados.

Quando o contato ganha telefone por esse caminho, as automações com o gatilho «contato ganhou telefone» passam a disparar para ele, como já acontecia ao editar o contato pela tela.

Contribuição de @webtecnica (#3734).
