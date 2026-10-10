---
impacto: nada_mudou
secao: corrigido
titulo: Instalação com o banco na própria VPS não falha mais quando o terminal está com permissões restritas
---

Quando o terminal estava com permissões restritas (`umask 077` ou `027`, comum
em servidor endurecido), o instalador com o banco na própria VPS herdava essa
configuração. Nesse caso o banco não subia, e nenhuma mensagem apontava a causa.
O instalador agora fixa as permissões de que o banco precisa, venha o terminal
como vier. Quem já tem o sistema instalado não é afetado.
