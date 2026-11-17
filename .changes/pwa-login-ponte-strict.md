---
impacto: nada_mudou
secao: corrigido
titulo: App instalado no celular não pede login a cada abertura, e a chave de Push diz a verdade
---

No Android, abrir o CRM pelo ícone do app instalado é uma navegação que vem
"de fora" do site, e o cookie de sessão (SameSite=Strict) não viaja nela. O
servidor não via ninguém logado e mandava para a tela de login a cada abertura,
embora a sessão continuasse válida.

Agora essa abertura passa por uma página-ponte do próprio CRM, que refaz a
navegação de dentro do site: com sessão, a pessoa entra direto; sem sessão,
vai ao login como antes. É o mesmo mecanismo que a volta do login com Google
já usava. O cookie continua Strict.

Nada a fazer na atualização.

Junto: a chave de **Push** em Configurações › Notificações só aparece ligada
quando o aparelho já deu permissão. Antes ela vinha ligada por padrão num
celular que nunca tinha sido inscrito — e nenhum aviso chegava com o app
fechado. Agora o primeiro toque liga, pede a permissão e inscreve o aparelho.
