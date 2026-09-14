---
impacto: capacidade_nova
secao: adicionado
titulo: Durante a atualização, o sistema mostra um aviso em vez de um erro do navegador
---

Enquanto a atualização mexe no banco, o CRM precisa ficar parado por alguns segundos — é o que impede que uma regra de isolamento suma no meio do caminho e a tela fique vazia sem explicação.

Até agora, quem estivesse com o sistema aberto nesse momento via o erro de conexão do próprio navegador: uma tela branca que não diz de quem é o problema nem quanto tempo dura.

Passa a aparecer uma página dizendo **"Estamos atualizando o sistema"**, com o aviso de que nada do trabalho se perde. Ela **volta sozinha** para a tela de antes quando o sistema sobe — ninguém precisa recarregar nem saber que houve atualização.

Duas decisões que valem estar escritas:

- **Se a atualização der errado no banco, o aviso FICA de pé.** O CRM não volta ao ar com regra de isolamento faltando, e nesse caso a página é a única coisa que explica a quem tentar abrir por que o sistema não responde.
- **A página não leva marca nenhuma.** Ela sobe antes de qualquer coisa poder consultar o banco, que é onde a marca da instalação mora — uma página neutra é a única que não mente sobre de quem é o sistema.

Nenhum passo manual foi acrescentado: quem opera continua clicando no mesmo botão.
