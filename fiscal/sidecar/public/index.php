<?php
/**
 * Fiscal sidecar — HTTP fino sobre o ServicoNfe.
 *
 * Rede privada + header X-Fiscal-Secret (FISCAL_SIDECAR_SECRET). Nunca expor
 * este serviço na internet: quem chama pode emitir nota em nome da empresa.
 *
 * Rotas:
 *   GET  /saude    → {ok:true, servico, sped_nfe}
 *   POST /emitir   → {ok:true, chave, protocolo, numero, serie, xml, cstat, xmotivo}
 *                     | {ok:false, codigo, mensagem[, recibo]}
 *   POST /cancelar → {ok:true, protocolo_cancelamento} | {ok:false, codigo, mensagem}
 *   POST /danfe    → {ok:true, pdf_base64} | {ok:false, codigo, mensagem}
 *   POST /distribuicao → {ok:true, ultNSU, maxNSU, documentos[]} | {ok:false, codigo, mensagem}
 *   POST /manifestar   → {ok:true, cstat, manifestacao} | {ok:false, codigo, mensagem}
 */

declare(strict_types=1);

require __DIR__ . '/../vendor/autoload.php';

use FiscalSidecar\ServicoEntrada;
use FiscalSidecar\ServicoNfe;

header('Content-Type: application/json; charset=utf-8');

function responder(int $status, array $corpo): void
{
    http_response_code($status);
    echo json_encode($corpo, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    exit;
}

function lerCorpo(): array
{
    $cru = file_get_contents('php://input');
    if ($cru === false || $cru === '') {
        return [];
    }
    $dec = json_decode($cru, true);
    return is_array($dec) ? $dec : [];
}

$metodo = $_SERVER['REQUEST_METHOD'] ?? 'GET';
$rota = parse_url($_SERVER['REQUEST_URI'] ?? '/', PHP_URL_PATH);

if ($metodo === 'GET' && $rota === '/saude') {
    $versao = 'desconhecida';
    $lock = __DIR__ . '/../composer.lock';
    if (is_file($lock)) {
        $d = json_decode((string)file_get_contents($lock), true);
        foreach (($d['packages'] ?? []) as $p) {
            if (($p['name'] ?? '') === 'nfephp-org/sped-nfe') {
                $versao = (string)($p['version'] ?? 'desconhecida');
            }
        }
    }
    responder(200, ['ok' => true, 'servico' => 'fiscal-sidecar', 'sped_nfe' => $versao]);
}

$segredo = (string)getenv('FISCAL_SIDECAR_SECRET');
$recebido = (string)($_SERVER['HTTP_X_FISCAL_SECRET'] ?? '');
if ($segredo === '' || !hash_equals($segredo, $recebido)) {
    responder(401, ['ok' => false, 'codigo' => 'NAO_AUTORIZADO', 'mensagem' => 'Header X-Fiscal-Secret ausente ou inválido.']);
}

if ($metodo === 'POST' && $rota === '/emitir') {
    $servico = new ServicoNfe(lerCorpo());
    $r = $servico->emitir();
    responder($r['ok'] ? 200 : 422, $r);
}

if ($metodo === 'POST' && $rota === '/cancelar') {
    $corpo = lerCorpo();
    // O certificado chega no mesmo envelope do /emitir (o TS monta igual).
    $servico = new ServicoNfe($corpo + ['config' => [], 'pedido' => [], 'itens' => []]);
    $r = $servico->cancelar($corpo);
    responder($r['ok'] ? 200 : 422, $r);
}

if ($metodo === 'POST' && $rota === '/danfe') {
    $corpo = lerCorpo();
    $xml = (string)($corpo['xml'] ?? '');
    if ($xml === '') {
        responder(422, ['ok' => false, 'codigo' => 'VALIDACAO', 'mensagem' => 'Campo xml é obrigatório.']);
    }
    $r = ServicoNfe::danfe($xml);
    responder($r['ok'] ? 200 : 422, $r);
}

if ($metodo === 'POST' && $rota === '/distribuicao') {
    $servico = new ServicoEntrada(lerCorpo());
    $r = $servico->distribuir(lerCorpo());
    responder($r['ok'] ? 200 : 422, $r);
}

if ($metodo === 'POST' && $rota === '/manifestar') {
    $corpo = lerCorpo();
    $servico = new ServicoEntrada($corpo);
    $r = $servico->manifestar($corpo);
    responder($r['ok'] ? 200 : 422, $r);
}

responder(404, ['ok' => false, 'codigo' => 'ROTA_DESCONHECIDA', 'mensagem' => 'Use GET /saude, POST /emitir, POST /cancelar, POST /danfe, POST /distribuicao ou POST /manifestar.']);
