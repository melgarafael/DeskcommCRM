---
impacto: exige_acao
secao: alterado
titulo: Login passa a ter bloqueio crescente por conta, com janela de 24 horas
---

O login já barrava 5 senhas erradas na mesma conta a cada 5 minutos. O problema é que essa janela zerava: 5 erros a cada 5 minutos davam até 1.440 tentativas por dia contra a mesma conta, todo dia, sem deixar rastro que distinguisse isso de alguém esquecido da senha.

Agora há uma segunda janela, de 24 horas, que não zera a cada 5 minutos e cujo castigo cresce com o número de falhas na mesma conta:

- 5 falhas em 24 horas: 5 minutos de bloqueio (o mesmo castigo da janela curta, agora lembrado);
- 10 falhas: 30 minutos;
- 20 falhas: bloqueio até a senha ser redefinida, com teto de 7 dias.

A janela curta continua valendo exatamente como estava, e o teto de 60 tentativas por IP também. O que muda é que a conta passa a acumular o dia inteiro em vez de recomeçar a cada cinco minutos.

Cada degrau grava o seu próprio evento na auditoria (`auth.login_bloqueio_5min`, `auth.login_bloqueio_30min`, `auth.login_bloqueio_ate_redefinir`) e o desbloqueio também (`auth.login_bloqueio_removido`). A resposta ao navegador não muda de forma nenhuma: quem erra a senha cinco vezes recebe a mesma mensagem de "muitas tentativas", e a sequência de respostas é idêntica para um e-mail que não existe — o bloqueio não serve para descobrir quem tem conta.

A mesma régua vale nas três portas que conferem credencial de conta: entrar com senha, trocar a senha do primeiro acesso e aceitar convite. A recuperação por e-mail ("esqueci minha senha") é a exceção deliberada, porque é o caminho de desbloqueio: ao gravar a senha nova, ela zera o bloqueio na hora.

## Requer atenção

O desbloqueio de uma conta que chegou ao último degrau é a redefinição de senha por e-mail, em "esqueci minha senha". Não há tela de administração para destravar uma conta nesta versão — se a pessoa perdeu o acesso ao e-mail, o bloqueio cai sozinho em 7 dias.

O contador é o mesmo do resto do produto: Upstash quando está configurado, memória do processo quando não está. Numa instalação com mais de uma instância e sem Upstash, o número de falhas conta por instância.

Contribuição de @webtecnica, a partir da issue #4743.
