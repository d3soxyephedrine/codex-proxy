import { readFile, writeFile } from "fs/promises";
import { homedir } from "os";
import { join } from "path";

const AUTH_PATH = process.env.CODEX_PROXY_AUTH_FILE || join(homedir(), ".codex", "auth.json");
const TOKEN_URL = "https://auth.openai.com/oauth/token";
const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const EXPIRY_BUFFER_MS = 60_000;

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
  OPENAI_API_KEY?: string;
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
  const apiKey = readString(data.OPENAI_API_KEY) || readString(process.env.OPENAI_API_KEY);
  const authModeRaw = readString(data.auth_mode);
  const isApiKeyMode = apiKey && (!authModeRaw || authModeRaw.toLowerCase() === "apikey");
  if (isApiKeyMode) {
    return {
      accessToken: apiKey!,
      refreshToken: "",
      accountId: readString(data.account_id),
      organizationId: readString(data.organization_id)
        || readString(data.org_id)
        || readString(data.openai_organization),
      expiresAt: Number.MAX_SAFE_INTEGER,
      authMode: authModeRaw || "apikey",
      scopes: [],
    };
  }

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
