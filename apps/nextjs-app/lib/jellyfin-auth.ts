const STREAMYSTATS_VERSION = "2.16.0"; // x-release-please-version

/**
 * Build the standard Jellyfin Authorization header.
 * Uses MediaBrowser format required by Jellyfin 10.12+ (non-legacy auth).
 * Pass a null token for unauthenticated flows (Quick Connect initiation)
 * that still require the client/device identity header.
 */
export function jellyfinHeaders(
  token: string | null,
  device?: { id: string; name: string },
): Record<string, string> {
  const devicePart = device
    ? `, Device="${device.name}", DeviceId="${device.id}"`
    : "";
  const tokenPart = token ? `, Token="${token}"` : "";
  return {
    Authorization: `MediaBrowser Client="Streamystats"${devicePart}, Version="${STREAMYSTATS_VERSION}"${tokenPart}`,
    "Content-Type": "application/json",
  };
}

type JellyfinUserMeResponse = {
  Id?: string;
  Name?: string;
  Policy?: {
    IsAdministrator?: boolean;
  };
};

type JellyfinAuthenticateByNameResponse = {
  AccessToken?: string;
  ServerId?: string;
  User?: {
    Id?: string;
    Name?: string;
    Policy?: {
      IsAdministrator?: boolean;
    };
  };
};

export type JellyfinAuthUser = {
  id: string;
  name: string | null;
  isAdmin: boolean;
};

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "");
}

function asNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export async function getUserFromEmbyToken(args: {
  serverUrl: string;
  token: string;
}): Promise<
  { ok: true; user: JellyfinAuthUser } | { ok: false; error: string }
> {
  const serverUrl = normalizeBaseUrl(args.serverUrl);
  const token = args.token.trim();
  if (!token) return { ok: false, error: "Empty Authorization header" };

  try {
    const res = await fetch(`${serverUrl}/Users/Me`, {
      method: "GET",
      headers: jellyfinHeaders(token),
      signal: AbortSignal.timeout(10_000),
    });

    if (!res.ok) {
      if (res.status === 401) {
        return { ok: false, error: "Invalid Authorization header" };
      }
      return { ok: false, error: `Jellyfin returned ${res.status}` };
    }

    const json = (await res.json()) as JellyfinUserMeResponse;
    const id = asNonEmptyString(json.Id);
    if (!id) return { ok: false, error: "Jellyfin did not return a user id" };
    const name = asNonEmptyString(json.Name);

    // API Keys don't return Policy in Users/Me usually, but if it's a user token it might.
    // However, if we are here, it's a User Token.
    const isAdmin = json.Policy?.IsAdministrator ?? false;

    return { ok: true, user: { id, name, isAdmin } };
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      return { ok: false, error: "Jellyfin request timed out" };
    }

    // If /Users/Me failed, it might be an API Key.
    // Try /System/Info to validate if it's a valid API Key.
    try {
      const sysRes = await fetch(
        `${normalizeBaseUrl(args.serverUrl)}/System/Info`,
        {
          method: "GET",
          headers: jellyfinHeaders(args.token.trim()),
          signal: AbortSignal.timeout(5000),
        },
      );

      if (sysRes.ok) {
        // It is a valid API Key (Admin)
        return {
          ok: true,
          user: {
            id: "system-api-key",
            name: "System API Key",
            isAdmin: true,
          },
        };
      }
    } catch {
      // Ignore error from System/Info and return original error
    }

    return {
      ok: false,
      error: error instanceof Error ? error.message : "Jellyfin request failed",
    };
  }
}

export async function authenticateByName(args: {
  serverUrl: string;
  username: string;
  password: string;
}): Promise<
  | { ok: true; user: JellyfinAuthUser; accessToken: string | null }
  | { ok: false; error: string }
> {
  const serverUrl = normalizeBaseUrl(args.serverUrl);
  const username = args.username.trim();
  const password = args.password;

  if (!username || !password) {
    return { ok: false, error: "Username and password are required" };
  }

  try {
    const res = await fetch(`${serverUrl}/Users/AuthenticateByName`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ Username: username, Pw: password }),
      signal: AbortSignal.timeout(10_000),
    });

    if (!res.ok) {
      if (res.status === 401) {
        return { ok: false, error: "Invalid username or password" };
      }
      return { ok: false, error: `Jellyfin returned ${res.status}` };
    }

    const json = (await res.json()) as JellyfinAuthenticateByNameResponse;
    const id = asNonEmptyString(json.User?.Id);
    if (!id) return { ok: false, error: "Jellyfin did not return a user id" };
    const name = asNonEmptyString(json.User?.Name);
    const accessToken = asNonEmptyString(json.AccessToken);
    const isAdmin = json.User?.Policy?.IsAdministrator ?? false;

    return { ok: true, user: { id, name, isAdmin }, accessToken };
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      return { ok: false, error: "Jellyfin request timed out" };
    }
    return {
      ok: false,
      error: error instanceof Error ? error.message : "Jellyfin request failed",
    };
  }
}

type QuickConnectInitiateResponse = {
  Code?: string;
  Secret?: string;
};

type QuickConnectStateResponse = {
  Authenticated?: boolean;
};

/**
 * Whether the Jellyfin server has Quick Connect enabled.
 * Any failure is treated as "disabled" so the login page degrades gracefully.
 */
export async function isQuickConnectEnabled(args: {
  serverUrl: string;
}): Promise<boolean> {
  try {
    const res = await fetch(
      `${normalizeBaseUrl(args.serverUrl)}/QuickConnect/Enabled`,
      {
        method: "GET",
        headers: { "Content-Type": "application/json" },
        signal: AbortSignal.timeout(5000),
      },
    );
    if (!res.ok) return false;
    const json = (await res.json()) as unknown;
    return json === true;
  } catch {
    return false;
  }
}

/**
 * Start a Quick Connect session for the given device identity.
 * Returns the user-facing code and the secret used to poll and authenticate.
 */
export async function initiateQuickConnect(args: {
  serverUrl: string;
  device: { id: string; name: string };
}): Promise<
  { ok: true; code: string; secret: string } | { ok: false; error: string }
> {
  const base = normalizeBaseUrl(args.serverUrl);
  const headers = jellyfinHeaders(null, args.device);

  try {
    let res = await fetch(`${base}/QuickConnect/Initiate`, {
      method: "POST",
      headers,
      signal: AbortSignal.timeout(10_000),
    });

    // Jellyfin 10.8 exposed this endpoint as GET only
    if (res.status === 404 || res.status === 405) {
      res = await fetch(`${base}/QuickConnect/Initiate`, {
        method: "GET",
        headers,
        signal: AbortSignal.timeout(10_000),
      });
    }

    if (res.status === 401) {
      return { ok: false, error: "Quick Connect is disabled on this server" };
    }
    if (!res.ok) {
      return { ok: false, error: `Jellyfin returned ${res.status}` };
    }

    const json = (await res.json()) as QuickConnectInitiateResponse;
    const code = asNonEmptyString(json.Code);
    const secret = asNonEmptyString(json.Secret);
    if (!code || !secret) {
      return {
        ok: false,
        error: "Jellyfin did not return a Quick Connect code",
      };
    }
    return { ok: true, code, secret };
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      return { ok: false, error: "Jellyfin request timed out" };
    }
    return {
      ok: false,
      error:
        error instanceof Error ? error.message : "Quick Connect request failed",
    };
  }
}

/**
 * Poll the state of a pending Quick Connect session.
 * `expired` is set when the code is no longer known to the server.
 */
export async function getQuickConnectState(args: {
  serverUrl: string;
  secret: string;
}): Promise<
  | { ok: true; authenticated: boolean }
  | { ok: false; error: string; expired?: boolean }
> {
  try {
    const res = await fetch(
      `${normalizeBaseUrl(args.serverUrl)}/QuickConnect/Connect?secret=${encodeURIComponent(
        args.secret,
      )}`,
      {
        method: "GET",
        headers: { "Content-Type": "application/json" },
        signal: AbortSignal.timeout(10_000),
      },
    );

    if (res.status === 404) {
      return { ok: false, expired: true, error: "Quick Connect code expired" };
    }
    if (!res.ok) {
      return { ok: false, error: `Jellyfin returned ${res.status}` };
    }

    const json = (await res.json()) as QuickConnectStateResponse;
    return { ok: true, authenticated: json.Authenticated === true };
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      return { ok: false, error: "Jellyfin request timed out" };
    }
    return {
      ok: false,
      error:
        error instanceof Error ? error.message : "Quick Connect request failed",
    };
  }
}

/**
 * Exchange an approved Quick Connect secret for a user access token.
 * The device identity must match the one used to initiate the session.
 */
export async function authenticateWithQuickConnect(args: {
  serverUrl: string;
  secret: string;
  device: { id: string; name: string };
}): Promise<
  | { ok: true; user: JellyfinAuthUser; accessToken: string | null }
  | { ok: false; error: string }
> {
  try {
    const res = await fetch(
      `${normalizeBaseUrl(args.serverUrl)}/Users/AuthenticateWithQuickConnect`,
      {
        method: "POST",
        headers: jellyfinHeaders(null, args.device),
        body: JSON.stringify({ Secret: args.secret }),
        signal: AbortSignal.timeout(10_000),
      },
    );

    if (!res.ok) {
      if (res.status === 401) {
        return { ok: false, error: "Quick Connect request was not approved" };
      }
      return { ok: false, error: `Jellyfin returned ${res.status}` };
    }

    const json = (await res.json()) as JellyfinAuthenticateByNameResponse;
    const id = asNonEmptyString(json.User?.Id);
    if (!id) return { ok: false, error: "Jellyfin did not return a user id" };
    const name = asNonEmptyString(json.User?.Name);
    const accessToken = asNonEmptyString(json.AccessToken);
    const isAdmin = json.User?.Policy?.IsAdministrator ?? false;

    return { ok: true, user: { id, name, isAdmin }, accessToken };
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      return { ok: false, error: "Jellyfin request timed out" };
    }
    return {
      ok: false,
      error:
        error instanceof Error ? error.message : "Quick Connect request failed",
    };
  }
}
