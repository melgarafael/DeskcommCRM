---
impacto: nada_mudou
secao: corrigido
titulo: Os e-mails de acesso deixam de apontar para um endereço que não existe
---

Numa instalação feita pelo caminho documentado, os e-mails de recuperação de
senha, de confirmação de cadastro e de aceite de convite chegavam com um link
para `localhost:3000` — um endereço que só existe na máquina de quem programa.
O e-mail chegava, a pessoa clicava, e o navegador dizia que a página não existe.
Na prática, **ninguém conseguia redefinir a própria senha.**

O endereço certo mora no painel do Supabase, e o instalador já sabia configurá-lo
sozinho — só que precisava de um token que ele nunca pedia. O aviso existia, mas
saía no meio de um registro de dez minutos, logo antes de uma tela verde dizendo
"Instalação concluída". Ninguém voltava para ler.

Agora o instalador pergunta esse token. Ele é opcional e **não fica salvo** —
abre a conta inteira do Supabase, então é usado uma vez e descartado, e nem
sequer entra no rascunho que guarda suas respostas para o caso de a instalação
ser interrompida. Por isso, se você recomeçar uma instalação, ele é a única
pergunta que volta a ser feita; a tela diz isso na hora, e apertar Enter pula.

Quem preferir pular continua podendo: a instalação termina repetindo o passo que
falta, com o seu domínio já preenchido, em vez de deixar a descoberta para o dia
em que alguém esquecer a senha. E quando o passo automático roda mas o endereço
não fica como este sistema precisa — porque o seu projeto já tinha outro
endereço escolhido, por exemplo —, ele passou a dizer isso em vez de terminar
com um "pronto" verde.

**Se você já tinha instalado antes desta versão**, a próxima atualização mostra
esse mesmo passo uma vez, com o seu domínio preenchido, e não repete depois.
