import { request } from 'node:http';
import { LIMITS } from './profile.mjs';

export const API_VERSION = '1.45';

/** Acesso direto ao socket: não lê contexto/config.json/DOCKER_HOST ou credenciais. */
export function engineClient(socketPath) {
  return (method, path, { body, timeout = LIMITS.requestMs, maxBytes = 512 * 1024 } = {}) => new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
    const req = request({ socketPath, method, path,
      headers: payload ? { 'content-type': 'application/json', 'content-length': payload.length } : {} }, (res) => {
      const chunks = [];
      let size = 0;
      res.on('data', (chunk) => {
        size += chunk.length;
        if (size > maxBytes) req.destroy(new Error('Resposta da API excedeu o limite.'));
        else chunks.push(chunk);
      });
      res.on('end', () => {
        clearTimeout(timer);
        const buffer = Buffer.concat(chunks);
        if (res.statusCode < 200 || res.statusCode >= 300) {
          let detail = '';
          try {
            const decoded = JSON.parse(buffer.toString('utf8'));
            if (typeof decoded.message === 'string') detail = `: ${decoded.message.slice(0, 1000)}`;
          } catch { /* Corpo não JSON não é publicado como diagnóstico. */ }
          const error = new Error(`Docker HTTP ${res.statusCode} (${method} ${path})${detail}`);
          error.status = res.statusCode;
          reject(error);
        } else resolve(buffer);
      });
      res.on('error', reject);
    });
    const timer = setTimeout(() => {
      const error = new Error('Prazo da API Docker excedido.');
      error.code = 'DOCKER_TIMEOUT';
      req.destroy(error);
    }, timeout);
    req.on('error', (error) => { clearTimeout(timer); reject(error); });
    req.end(payload);
  });
}

export async function json(api, method, path, options) {
  return JSON.parse((await api(method, `/v${API_VERSION}${path}`, options)).toString('utf8'));
}

export async function preflight(api) {
  try {
    const ping = await api('GET', '/_ping', { timeout: LIMITS.preflightMs, maxBytes: 64 });
    if (ping.toString('utf8').trim() !== 'OK') throw new Error('Resposta de ping inesperada.');
    const version = JSON.parse((await api('GET', '/version', { timeout: LIMITS.preflightMs })).toString('utf8'));
    const number = (value) => Number(value?.split('.')[1]);
    if (version.Os !== 'linux' || !Number.isFinite(number(version.ApiVersion))
      || number(version.ApiVersion) < 45 || number(version.MinAPIVersion ?? '1.0') > 45) {
      throw new Error('Daemon não suporta o perfil Linux/API 1.45.');
    }
    return { status: 'ready', version: { Version: version.Version, ApiVersion: version.ApiVersion,
      MinAPIVersion: version.MinAPIVersion, Os: version.Os, Arch: version.Arch, KernelVersion: version.KernelVersion } };
  } catch (error) {
    return { status: 'blocked', reason: error.message, measurements: null };
  }
}
