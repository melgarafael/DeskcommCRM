---
impacto: capacidade_nova
secao: adicionado
titulo: A IA e as automações escolhem o setor da conversa
---

O setor da conversa — a fila que decide para quem ela é distribuída — só podia
ser escolhido à mão, uma conversa por vez. A triagem que sabe dizer "isto é um
boleto, é do Financeiro" morria no prompt: **não havia por onde gravar**.

Agora o agente de IA tem a ferramenta `crm_set_conversation_sector` e a regra de
automação tem a ação "Definir o setor da conversa". As duas entram pela MESMA
porta da tela (`definirSetorDaConversa`), com as mesmas recusas: setor
inexistente ou de outra organização, conversa encerrada e conversa que uma
pessoa classificou. Nenhuma policy foi afrouxada — a tela continua escrevendo
com a sessão de quem atende, e a IA e a automação passam por conferência
explícita de organização, conversa e setor, com auditoria
(`conversation.sector_changed`) dizendo **quem mudou, de qual setor para qual**.

**A escolha de uma pessoa vence a IA.** O setor gravado à mão fica marcado em
`conversations.metadata.setor_origem` e só é sobrescrito por IA ou automação com
a opção explícita ligada (desligada por padrão). Conversa que já tinha setor mas
nasceu antes desta marca conta como manual: prefere-se preservar uma
classificação a apagá-la em silêncio. A IA também não limpa a fila — deixar a
conversa sem setor continua sendo gesto de gente na tela.
