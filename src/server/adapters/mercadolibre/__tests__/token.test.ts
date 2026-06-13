/** @jest-environment node */
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createMeliTokenManager } from '../token';
import type { MeliCredentials } from '../token';

function makeCreds(overrides?: Partial<MeliCredentials>): MeliCredentials {
  return {
    clientId: 'test-client-id',
    clientSecret: 'test-client-secret',
    seedRefreshToken: 'seed-refresh-token',
    tokenFile: path.join(os.tmpdir(), `meli-token-test-${process.pid}-${Math.random().toString(36).slice(2)}.json`),
    ...overrides,
  };
}

function makeTokenResponse(overrides?: Partial<Record<string, unknown>>) {
  return {
    access_token: 'access-token-abc',
    token_type: 'Bearer',
    expires_in: 21600, // 6 horas
    scope: 'offline_access read write',
    user_id: 123456789,
    refresh_token: 'new-refresh-token-xyz',
    ...overrides,
  };
}

function mockFetchOk(body: object) {
  return jest.spyOn(globalThis, 'fetch').mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as Response);
}

function mockFetchError(status = 401, text = 'Unauthorized') {
  return jest.spyOn(globalThis, 'fetch').mockResolvedValue({
    ok: false,
    status,
    statusText: text,
    json: async () => ({}),
    text: async () => text,
  } as Response);
}

describe('createMeliTokenManager', () => {
  let creds: MeliCredentials;
  let tokenFile: string;

  beforeEach(() => {
    creds = makeCreds();
    tokenFile = creds.tokenFile;
  });

  afterEach(() => {
    jest.restoreAllMocks();
    try {
      fs.rmSync(tokenFile, { force: true });
    } catch {
      /* noop */
    }
  });

  it('refresca y cachea el access token (primera llamada hace fetch, segunda no)', async () => {
    const fetchMock = mockFetchOk(makeTokenResponse());
    const mgr = createMeliTokenManager(creds);

    const token1 = await mgr.getAccessToken();
    expect(token1).toBe('access-token-abc');
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Segunda llamada dentro del período de vigencia: NO debe volver a fetchear
    const token2 = await mgr.getAccessToken();
    expect(token2).toBe('access-token-abc');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('vuelve a fetchear cuando el token está expirado', async () => {
    // expires_in: 0 → el token expira inmediatamente (Date.now() >= expiresAt - 60_000)
    const fetchMock = mockFetchOk(makeTokenResponse({ expires_in: 0 }));
    const mgr = createMeliTokenManager(creds);

    await mgr.getAccessToken();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Segunda llamada: token expirado, debe refrescar nuevamente
    await mgr.getAccessToken();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('persiste el nuevo refresh_token rotado en el tokenFile', async () => {
    mockFetchOk(makeTokenResponse({ refresh_token: 'rotated-refresh-token' }));
    const mgr = createMeliTokenManager(creds);

    await mgr.getAccessToken();

    expect(fs.existsSync(tokenFile)).toBe(true);
    const saved = JSON.parse(fs.readFileSync(tokenFile, 'utf-8')) as { refresh_token: string };
    expect(saved.refresh_token).toBe('rotated-refresh-token');
  });

  it('usa el refresh_token del archivo si existe (no el seedRefreshToken)', async () => {
    // Precargamos un refresh token diferente en el archivo
    const dir = path.dirname(tokenFile);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      tokenFile,
      JSON.stringify({ refresh_token: 'file-refresh-token', updatedAt: new Date().toISOString() }),
    );

    const fetchMock = mockFetchOk(makeTokenResponse());
    const mgr = createMeliTokenManager(creds);

    await mgr.getAccessToken();

    // El body del fetch debe haber usado el token del archivo, no la semilla
    const call = fetchMock.mock.calls[0];
    const body = (call[1] as RequestInit | undefined)?.body as string;
    expect(body).toContain('refresh_token=file-refresh-token');
    expect(body).not.toContain('seed-refresh-token');
  });

  it('usa el seedRefreshToken cuando el archivo no existe', async () => {
    const fetchMock = mockFetchOk(makeTokenResponse());
    const mgr = createMeliTokenManager(creds);

    await mgr.getAccessToken();

    const call = fetchMock.mock.calls[0];
    const body = (call[1] as RequestInit | undefined)?.body as string;
    expect(body).toContain('refresh_token=seed-refresh-token');
  });

  it('rechaza con Error cuando la respuesta de OAuth no es ok', async () => {
    mockFetchError(401, 'Unauthorized');
    const mgr = createMeliTokenManager(creds);

    await expect(mgr.getAccessToken()).rejects.toThrow(/MELI OAuth failed/);
  });
});
