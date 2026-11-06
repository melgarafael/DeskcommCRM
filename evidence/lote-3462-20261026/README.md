# Capturas sintéticas do lote #3462

Produção exercitada: 1935a076f455127cd216b474d7124946b2f83494. Data: 26/10/2026;
banco fresco, navegador e serviços locais reais. Todas as imagens foram abertas e
inspecionadas. O [registro da prova](../../docs/testing/lote-3462-2026-10-26.md)
descreve comandos, controles, autoria, resultado e limites.

| Caso | Captura |
|---|---|
| CSV reimportado, dois contatos | [Contatos](3450-csv-reimportado.png) |
| Moeda persistida após reload | [BRL](3442-enter-brl.png), [USD](3442-enter-usd.png) |
| Anexo privado pelo viewer | [Lista](3453-viewer-lista.png), [prévia real aberta](3453-viewer-anexo-privado.png) |
| Foto pela sessão do Inbox | [Inbox](3439-foto-cookie-e-token.png); o img real foi validado carregado, 64 px, além dos controles HTTP de Bearer. |
| FAQ com conteúdo novo após reload | [Acervo](3451-faq-editada-e-recarregada.png) |
| Mensagem nova avisa; histórico silencioso | [Aviso no Inbox](3454-novas-avisam-passado-nao.png) |
| Agenda Meta não recria o titular apagado | [Busca concluída sem contato](3457-apagado-nao-volta-pela-agenda.png) |
| Falha de leitura SMTP preserva a senha gravada | [Mensagem genérica de erro](3445-erro-leitura-preserva-senha.png) |

Não há dados de clientes. Os e-mails do domínio .invalid, telefones, nomes, senha e imagem quadriculada
são fixtures descartáveis. A captura do Inbox acompanha a medição do carregamento;
a lista pode deixar a foto abaixo da dobra. Nenhum screenshot substitui os controles
persistidos e as recusas HTTP registrados na prova.
