import * as fs from 'fs';
import * as path from 'path';

const TOKEN_ENDPOINT = 'https://api.mercadolibre.com/oauth/token';

export interface MeliCredentials {
  clientId: string;
  clientSecret: string;
  /** Semilla inicial; el valor vigente se persiste en tokenFile tras el primer refresh. */
  seedRefreshToken: string;
  /** Path al JSON { refresh_token, updatedAt } donde se rota el token. */
  tokenFile: string;
}

export interface MeliTokenManager {
  getAccessToken(): Promise<string>;
}

interface TokenFileData {
  refresh_token: string;
  updatedAt: string;
}

interface MeliTokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
  scope: string;
  user_id: number;
  refresh_token: string;
}

/**
 * Crea un gestor de token OAuth de MercadoLibre.
 * - Cache en memoria para accessToken (refresca 60 s antes del vencimiento).
 * - El refresh_token rota con cada uso (single-use); el nuevo se persiste en tokenFile.
 */
export function createMeliTokenManager(creds: MeliCredentials): MeliTokenManager {
  let accessToken: string | undefined;
  let expiresAt: number | undefined;

  function readCurrentRefreshToken(): string {
    try {
      if (fs.existsSync(creds.tokenFile)) {
        const raw = fs.readFileSync(creds.tokenFile, 'utf-8');
        const data = JSON.parse(raw) as TokenFileData;
        if (data.refresh_token) return data.refresh_token;
      }
    } catch {
      // si falla la lectura, caemos a la semilla
    }
    return creds.seedRefreshToken;
  }

  function persistRefreshToken(refreshToken: string): void {
    const dir = path.dirname(creds.tokenFile);
    fs.mkdirSync(dir, { recursive: true });
    const data: TokenFileData = { refresh_token: refreshToken, updatedAt: new Date().toISOString() };
    fs.writeFileSync(creds.tokenFile, JSON.stringify(data, null, 2), 'utf-8');
  }

  async function refresh(): Promise<string> {
    const currentRefreshToken = readCurrentRefreshToken();

    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: creds.clientId,
      client_secret: creds.clientSecret,
      refresh_token: currentRefreshToken,
    });

    const res = await fetch(TOKEN_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`MELI OAuth failed: ${res.status} ${res.statusText} — ${text}`);
    }

    const data = (await res.json()) as MeliTokenResponse;

    // Cachear access token
    accessToken = data.access_token;
    expiresAt = Date.now() + data.expires_in * 1000;

    // Persistir el nuevo refresh_token (single-use, rota en cada llamada)
    persistRefreshToken(data.refresh_token);

    return data.access_token;
  }

  return {
    async getAccessToken(): Promise<string> {
      if (accessToken && expiresAt !== undefined && Date.now() < expiresAt - 60_000) {
        return accessToken;
      }
      return refresh();
    },
  };
}

/**
 * Lee credenciales MELI del entorno. Devuelve null si falta alguna variable.
 * Variables: MELI_CLIENT_ID, MELI_CLIENT_SECRET, MELI_REFRESH_TOKEN, MELI_TOKEN_FILE (opcional).
 */
export function meliCredentialsFromEnv(): MeliCredentials | null {
  const clientId = process.env.MELI_CLIENT_ID;
  const clientSecret = process.env.MELI_CLIENT_SECRET;
  const seedRefreshToken = process.env.MELI_REFRESH_TOKEN;
  if (!clientId || !clientSecret || !seedRefreshToken) return null;
  const tokenFile = process.env.MELI_TOKEN_FILE ?? '.data/meli-token.json';
  return { clientId, clientSecret, seedRefreshToken, tokenFile };
}

export function meliHasCredentials(): boolean {
  return meliCredentialsFromEnv() !== null;
}

const _creds = meliCredentialsFromEnv();
export const meliTokenManager: MeliTokenManager | null = _creds ? createMeliTokenManager(_creds) : null;
