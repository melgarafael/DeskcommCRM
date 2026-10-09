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

Quando ligada, o link do espaço aberto entra no campo `location` do evento NA
PRIMEIRA publicação: o convidado recebe um convite que já tem a sala, não um
convite sem link e um "alterado" minutos depois. E só o espaço aberto troca o
local pelo link — o Meet "confiável" do Calendar continua fora da projeção, de
propósito: o link dele nasce depois da publicação, e mandá-lo para o `location`
de todo compromisso já publicado viraria um e-mail de "evento alterado" em massa
para os convidados na primeira sincronização depois desta atualização.

Requer, na conexão do Google da organização, que a API do Meet esteja
habilitada e que o escopo opcional de criação de espaços tenha sido concedido
(reconectar com a opção ligada já pede o escopo). Sem o escopo, a reunião continua
nascendo o Meet "confiável" de sempre — a opção só passa a valer quando as duas
condições se encontram.

No self-host quem conecta o Google usa o app OAuth próprio, então habilitar a
Meet API e colocar `meetings.space.created` na tela de consentimento do projeto
está na própria tela da opção e na doc de setup do kit.

Contribuição de @webtecnica (#2089).

