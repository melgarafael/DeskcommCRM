---
impacto: capacidade_nova
secao: adicionado
titulo: Prospecção ganha "Baixar lista" (o CSV das empresas ainda não abordadas) e a voz da organização fica à vista
---

O cartão da campanha de prospecção passa a ter **Baixar lista (N)**: um CSV com
as empresas que ainda não foram abordadas, no mesmo formato do "Baixar modelo" e
da planilha que a própria tela importa (colunas empresa, telefone, site,
segmento, endereço, email e redes, com `;`, BOM e UTF-8). Quem já recebeu
mensagem fica de fora do arquivo, porque o contato e o negócio já existem no CRM
e a triagem de uma campanha nova recusaria a empresa — o arquivo leva só o que
ainda pode ser abordado. A contagem do botão sai da mesma regra do servidor, e
cada download fica registrado na auditoria com o número de empresas que saíram,
nunca com o conteúdo.

O card **Voz e vocabulário** deixa de morar dentro do painel de "Configurar
busca": ele aparece na tela de prospecção para quem tem a permissão da área. O
texto salvo é o da organização inteira, o mesmo de antes — não há um segundo
lugar para a mesma configuração. Contribuição de @webtecnica (#4360).
