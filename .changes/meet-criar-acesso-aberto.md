---
impacto: capacidade_nova
secao: adicionado
titulo: Opção por organização para criar o Google Meet da reunião já com acesso aberto
---
Nova opção nas configurações da Agenda, desligada por padrão em toda
organização: quando ligada, o Google Meet criado pela reunião nasce já aberto —
quem tiver o link entra sem pedir para participar. A opção traz o aviso de
risco, porque abrir a reunião é exatamente isso: qualquer pessoa com o link
entra. Desligada (o padrão de quem já instalou), o comportamento atual é
preservado sem nenhuma mudança.

Requer, na conexão do Google da organização, que a API do Meet esteja
habilitada e que o escopo opcional de criação de espaços tenha sido concedido
(reconectar com a opção ligada já pede o escopo). Sem o escopo, a reunião continua
nascendo o Meet "confiável" de sempre — a opção só passa a valer quando as duas
condições se encontram.

No self-host quem conecta o Google usa o app OAuth próprio, então habilitar a
Meet API e colocar `meetings.space.created` na tela de consentimento do projeto
está na própria tela da opção e na doc de setup do kit.

Contribuição de @webtecnica (#2089).

