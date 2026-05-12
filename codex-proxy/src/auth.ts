import { readFileSync } from "fs";
import { readFile, writeFile } from "fs/promises";
import { homedir } from "os";
import { join } from "path";

const AUTH_PATH = process.env.CODEX_PROXY_AUTH_FILE || join(homedir(), ".codex", "auth.json");
const TOKEN_URL = "https://auth.openai.com/oauth/token";
const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const EXPIRY_BUFFER_MS = 60_000;

const API_KEY_FILE_PATH = process.env.CODEX_PROXY_API_KEY_FILE || null;
const API_KEY_ENV = process.env.OPENAI_API_KEY || null;

interface AuthTokens {
  access_token?: string;
  refresh_token?: string;
  expires_at?: number | null;
  account_id?: string;
  organization_id?: string;
  org_id?: string;
  openai_organization?: string;
  id_token?: string;
  [key: string]: unknown;
}

interface AuthFile {
  auth_mode?: string;
  account_id?: string;
  organization_id?: string;
  org_id?: string;
  openai_organization?: string;
  last_refresh?: string;
  tokens?: AuthTokens;
  [key: string]: unknown;
}

interface RefreshResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  expires_at?: number;
  account_id?: string;
  id_token?: string;
}

interface JwtAuthClaim {
  chatgpt_account_id?: string;
  organization_id?: string;
  allowed_workspace_id?: string;
  [key: string]: unknown;
}

export interface AuthState {
  accessToken: string;
  refreshToken: string;
  accountId: string | null;
  organizationId: string | null;
  expiresAt: number;
  authMode: string | null;
  scopes: string[];
}

let cached: AuthState | null = null;
let refreshing: Promise<AuthState> | null = null;

function coerceEpochMs(value: number | null | undefined): number {
  if (!value || !Number.isFinite(value)) return 0;
  return value > 1_000_000_000_000 ? value : value * 1000;
}

function decodeJwtPayload(token: string | null | undefined): Record<string, unknown> | null {
  if (!token) return null;

  const [, payload] = token.split(".");
  if (!payload) return null;

  const normalized = payload.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(normalized.length + ((4 - normalized.length % 4) % 4), "=");

  try {
    return JSON.parse(Buffer.from(padded, "base64").toString("utf8"));
  } catch {
    return null;
  }
}

function extractClaimObject(payload: Record<string, unknown> | null): JwtAuthClaim | null {
  const claim = payload?.["https://api.openai.com/auth"];
  return claim && typeof claim === "object" ? claim as JwtAuthClaim : null;
}

function extractScopes(payload: Record<string, unknown> | null): string[] {
  const scopes = payload?.scp;
  return Array.isArray(scopes) ? scopes.filter((scope): scope is string => typeof scope === "string") : [];
}

function deriveExpiryMs(token: string | null | undefined, explicitExpiry: number | null | undefined): number {
  const fromFile = coerceEpochMs(explicitExpiry);
  if (fromFile > 0) return fromFile;

  const payload = decodeJwtPayload(token);
  const jwtExp = typeof payload?.exp === "number" ? payload.exp : 0;
  return coerceEpochMs(jwtExp);
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function toAuthState(data: AuthFile): AuthState {
  const accessToken = readString(data.tokens?.access_token);
  if (!accessToken) {
    throw new Error(`Missing access token in ${AUTH_PATH}`);
  }

  const payload = decodeJwtPayload(accessToken);
  const claim = extractClaimObject(payload);
  const accountId = readString(data.tokens?.account_id)
    || readString(data.account_id)
    || readString(claim?.chatgpt_account_id);
  const organizationId = readString(data.tokens?.organization_id)
    || readString(data.tokens?.org_id)
    || readString(data.tokens?.openai_organization)
    || readString(data.organization_id)
    || readString(data.org_id)
    || readString(data.openai_organization)
    || readString(claim?.organization_id)
    || readString(claim?.allowed_workspace_id);

  return {
    accessToken,
    refreshToken: readString(data.tokens?.refresh_token) || "",
    accountId,
    organizationId,
    expiresAt: deriveExpiryMs(accessToken, data.tokens?.expires_at),
    authMode: readString(data.auth_mode),
    scopes: extractScopes(payload),
  };
}

async function readAuthFile(): Promise<AuthFile> {
  const raw = await readFile(AUTH_PATH, "utf8");
  return JSON.parse(raw) as AuthFile;
}

function isFresh(expiresAt: number): boolean {
  return expiresAt > 0 && Date.now() < expiresAt - EXPIRY_BUFFER_MS;
}

async function loadStoredState(): Promise<AuthState> {
  return toAuthState(await readAuthFile());
}

async function persistAuthFile(base: AuthFile, refresh: RefreshResponse, previous: AuthState): Promise<AuthState> {
  const nowSeconds = Math.floor(Date.now() / 1000);
  const expiresAtSeconds = typeof refresh.expires_at === "number"
    ? Math.floor(refresh.expires_at)
    : typeof refresh.expires_in === "number"
      ? nowSeconds + refresh.expires_in
      : 0;

  const next: AuthFile = {
    ...base,
    last_refresh: new Date().toISOString(),
    tokens: {
      ...(base.tokens || {}),
      access_token: refresh.access_token || previous.accessToken,
      refresh_token: refresh.refresh_token || previous.refreshToken,
      expires_at: expiresAtSeconds || base.tokens?.expires_at || null,
      account_id: refresh.account_id || base.tokens?.account_id,
      id_token: refresh.id_token || base.tokens?.id_token,
    },
  };

  await writeFile(AUTH_PATH, JSON.stringify(next, null, 2) + "\n");
  return toAuthState(next);
}

function formatUpstreamError(status: number, rawBody: string): string {
  try {
    const parsed = JSON.parse(rawBody) as Record<string, any>;
    const error = parsed.error;
    if (typeof error?.message === "string") {
      return `${status}: ${error.message}`;
    }
  } catch {
    // Keep the raw preview below.
  }

  return `${status}: ${rawBody.slice(0, 400)}`;
}

async function refreshState(current: AuthState): Promise<AuthState> {
  if (!current.refreshToken) {
    throw new Error("No refresh token available");
  }

  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "accept": "application/json",
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: current.refreshToken,
      client_id: CLIENT_ID,
    }),
    signal: AbortSignal.timeout(10_000),
  });

  if (!res.ok) {
    throw new Error(`Token refresh failed (${formatUpstreamError(res.status, await res.text())})`);
  }

  const refresh = await res.json() as RefreshResponse;
  if (!refresh.access_token) {
    throw new Error("Refresh response did not include an access token");
  }

  const base = await readAuthFile();
  return persistAuthFile(base, refresh, current);
}

export async function getAuthState(): Promise<AuthState> {
  if (!cached) {
    cached = await loadStoredState();
  }

  if (!isFresh(cached.expiresAt)) {
    if (cached.refreshToken) {
      if (!refreshing) {
        refreshing = refreshState(cached)
          .catch(async (error) => {
            const latest = await loadStoredState();
            if (isFresh(latest.expiresAt)) {
              return latest;
            }
            throw error;
          })
          .finally(() => {
            refreshing = null;
          });
      }

      cached = await refreshing;
    } else {
      const latest = await loadStoredState();
      if (isFresh(latest.expiresAt)) {
        cached = latest;
      } else {
        throw new Error("OAuth token is expired and no refresh token is available");
      }
    }
  }

  return cached;
}

export async function getStoredAuthInfo(): Promise<AuthState> {
  return getAuthState();
}

export function getAuthPath(): string {
  return AUTH_PATH;
}

/**
 * Invalidate the in-memory cache + force a single-flight refresh from disk.
 * Call this when upstream returns 401/token_revoked so the next request
 * picks up either a re-logged-in auth.json (rewritten by `codex login`)
 * or a freshly-refreshed token from the OAuth endpoint.
 */
export async function invalidateAndRefresh(): Promise<AuthState> {
  cached = null;
  return getAuthState();
}

// --- API-key auth (alongside OAuth above) ---
//
// Real OpenAI API keys (sk-...) instead of ChatGPT-session OAuth. Used when
// a profile selects authMode: "api_key" or CODEX_PROXY_AUTH_MODE=api_key.
// Required for model entitlements the ChatGPT-account auth path doesn't have
// (e.g. gpt-5.1-codex family).

export type ApiKeySource = "env" | "file" | "profile" | "auth_file";

export interface ApiKeyResolution {
  key: string;
  source: ApiKeySource;
  sourceDetail: string;     // "env", "file:/abs/path", or "profile:<name>"
  preview: string;          // sk-<first3>…<last3>
  length: number;
  loadedAt: string;
}

let cachedFileKey: { value: string; path: string; loadedAt: string } | null = null;
let cachedEnvKey: { value: string; loadedAt: string } | null = null;
// auth.json is re-read each resolution (it can be rewritten by codex login mid-session)

function loadAuthFileKey(): { value: string; path: string; loadedAt: string } | null {
  try {
    const raw = readFileSync(AUTH_PATH, "utf8");
    const parsed = JSON.parse(raw) as AuthFile;
    const inferredKey = readString(parsed.OPENAI_API_KEY as unknown as string)
      || readString((parsed as any).api_key)
      || readString(parsed.tokens?.OPENAI_API_KEY as unknown as string);
    if (!inferredKey) return null;
    // Only treat as an API key if auth_mode says "apikey" (newer codex login) OR if the value
    // shape looks like a real key (sk-...). This avoids confusing OAuth tokens for API keys.
    const authMode = readString(parsed.auth_mode);
    const looksLikeApiKey = inferredKey.startsWith("sk-");
    if (authMode === "apikey" || authMode === "api_key" || looksLikeApiKey) {
      return { value: inferredKey, path: AUTH_PATH, loadedAt: new Date().toISOString() };
    }
    return null;
  } catch {
    return null;
  }
}

function loadFileKeyOnce(): { value: string; path: string; loadedAt: string } | null {
  if (cachedFileKey) return cachedFileKey;
  if (!API_KEY_FILE_PATH) return null;
  try {
    const raw = readFileSync(API_KEY_FILE_PATH, "utf8").trim();
    if (!raw) return null;
    cachedFileKey = { value: raw, path: API_KEY_FILE_PATH, loadedAt: new Date().toISOString() };
    return cachedFileKey;
  } catch (error) {
    console.error(`[auth] failed to read CODEX_PROXY_API_KEY_FILE=${API_KEY_FILE_PATH}: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

function loadEnvKeyOnce(): { value: string; loadedAt: string } | null {
  if (cachedEnvKey) return cachedEnvKey;
  if (!API_KEY_ENV) return null;
  cachedEnvKey = { value: API_KEY_ENV, loadedAt: new Date().toISOString() };
  return cachedEnvKey;
}

function previewKey(key: string): string {
  // sk-...XXXX → sk-XXX…YYY  (so we can confirm it loaded without leaking it)
  if (key.length <= 8) return "***";
  const tail = key.slice(-3);
  const dash = key.indexOf("-");
  if (dash >= 0 && dash < key.length - 4) {
    const head = key.slice(0, dash + 4);  // sk- + 3 chars
    return `${head}…${tail}`;
  }
  return `${key.slice(0, 4)}…${tail}`;
}

/**
 * Resolve an API key for the current request.
 *
 * Priority (highest to lowest):
 *   1. Profile-supplied apiKey (per-request, not cached)
 *   2. CODEX_PROXY_API_KEY_FILE (cached at first load) — explicit operator override
 *   3. ~/.codex/auth.json OPENAI_API_KEY field — what `codex login` writes when auth_mode=apikey
 *   4. OPENAI_API_KEY env var (cached at first load) — last resort; often "dummy" in dev envs
 *
 * Returns null if no key is configured anywhere. The caller is responsible
 * for emitting a clear error (typically 503) when null is returned for an
 * api_key-mode request.
 */
export function resolveApiKey(profileKey?: string | null, profileName?: string | null): ApiKeyResolution | null {
  if (profileKey && typeof profileKey === "string" && profileKey.length > 0) {
    return {
      key: profileKey,
      source: "profile",
      sourceDetail: profileName ? `profile:${profileName}` : "profile",
      preview: previewKey(profileKey),
      length: profileKey.length,
      loadedAt: new Date().toISOString(),
    };
  }
  const fileKey = loadFileKeyOnce();
  if (fileKey) {
    return {
      key: fileKey.value,
      source: "file",
      sourceDetail: `file:${fileKey.path}`,
      preview: previewKey(fileKey.value),
      length: fileKey.value.length,
      loadedAt: fileKey.loadedAt,
    };
  }
  const authFileKey = loadAuthFileKey();
  if (authFileKey) {
    return {
      key: authFileKey.value,
      source: "auth_file",
      sourceDetail: `auth_file:${authFileKey.path}`,
      preview: previewKey(authFileKey.value),
      length: authFileKey.value.length,
      loadedAt: authFileKey.loadedAt,
    };
  }
  const envKey = loadEnvKeyOnce();
  if (envKey) {
    return {
      key: envKey.value,
      source: "env",
      sourceDetail: "env",
      preview: previewKey(envKey.value),
      length: envKey.value.length,
      loadedAt: envKey.loadedAt,
    };
  }
  return null;
}

export function getApiKeyFilePath(): string | null {
  return API_KEY_FILE_PATH;
}

export function isApiKeyEnvSet(): boolean {
  return !!API_KEY_ENV;
}

/**
 * Read auth.json's auth_mode field. Returns "api_key" if it's "apikey"/"api_key",
 * "oauth" if it's "oauth" or any token-shaped mode, null if unreadable or absent.
 * Cached because auth.json is rewritten infrequently (only on `codex login`).
 */
let cachedAuthFileMode: "api_key" | "oauth" | null | undefined = undefined;
export function getAuthFileMode(): "api_key" | "oauth" | null {
  if (cachedAuthFileMode !== undefined) return cachedAuthFileMode;
  try {
    const raw = readFileSync(AUTH_PATH, "utf8");
    const parsed = JSON.parse(raw) as AuthFile;
    const m = (readString(parsed.auth_mode) || "").toLowerCase();
    if (m === "apikey" || m === "api_key") {
      cachedAuthFileMode = "api_key";
    } else if (m === "oauth" || m === "chatgpt") {
      cachedAuthFileMode = "oauth";
    } else if (parsed.tokens?.access_token) {
      // No auth_mode field but has OAuth tokens — legacy file shape
      cachedAuthFileMode = "oauth";
    } else if (parsed.OPENAI_API_KEY || (parsed as any).api_key) {
      // Has an API key field but no auth_mode — treat as api_key
      cachedAuthFileMode = "api_key";
    } else {
      cachedAuthFileMode = null;
    }
  } catch {
    cachedAuthFileMode = null;
  }
  return cachedAuthFileMode;
}
