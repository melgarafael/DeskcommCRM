---
impacto: nada_mudou
secao: corrigido
titulo: O monitoramento de saúde não confunde mais a tela de login com o banco de dados
---

Numa instalação em que o endereço configurado para o banco de dados caía numa página de login (um proxy na frente, por exemplo), o monitor de saúde do sistema — o endereçamento `/health` que o instalador e o atualizador consultam — respondia "tudo certo". O endereço respondia, mas quem respondia era a tela de login, e o banco de dados podia estar fora do ar sem que ninguém fosse avisado: a checagem seguia o redirecionamento, recebia a página de login e a lia como se fosse o banco.

Agora a checagem não segue redirecionamento: um redirecionamento é reportado como o banco fora do ar, com o endereço de destino no detalhe do erro para quem consulta com o segredo interno. E um "tudo certo" que não tenha vindo do banco — a página de login servida no lugar dele — deixa de contar como banco de pé. Uma resposta legítima do banco continua "tudo certo" como sempre: inclusive as em que ele recusa a credencial, que é o banco funcionando e barrando quem não tem permissão.

Quem opera não precisa fazer nada na instalação. O que muda é que uma instalação mal configurada passa a aparecer como fora do ar em vez de aparecer como saudável.

Contribuição de @webtecnica (#3294).
