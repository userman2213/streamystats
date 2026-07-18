"use server";

import "server-only";

import { getInternalUrl } from "@streamystats/database/server-url";
import { cookies } from "next/headers";
import { shouldUseSecureCookies } from "@/lib/secure-cookies";
import { getServerWithSecrets } from "./db/server";
import { parseDeviceName } from "./device";
import {
  authenticateWithQuickConnect,
  getQuickConnectState,
  initiateQuickConnect,
  isQuickConnectEnabled,
  jellyfinHeaders,
} from "./jellyfin-auth";
import { createSession } from "./session";

const QUICK_CONNECT_COOKIE = "streamystats-qc";
// Jellyfin Quick Connect codes expire server-side after ~10 minutes
const QUICK_CONNECT_COOKIE_MAX_AGE = 600;

interface QuickConnectCookiePayload {
  serverId: number;
  secret: string;
  deviceId: string;
  deviceName: string;
}

function parseQuickConnectCookie(
  value: string | undefined,
): QuickConnectCookiePayload | null {
  if (!value) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      "serverId" in parsed &&
      typeof parsed.serverId === "number" &&
      "secret" in parsed &&
      typeof parsed.secret === "string" &&
      "deviceId" in parsed &&
      typeof parsed.deviceId === "string" &&
      "deviceName" in parsed &&
      typeof parsed.deviceName === "string"
    ) {
      return {
        serverId: parsed.serverId,
        secret: parsed.secret,
        deviceId: parsed.deviceId,
        deviceName: parsed.deviceName,
      };
    }
    return null;
  } catch {
    return null;
  }
}

async function setSessionCookies({
  serverId,
  userId,
  userName,
  isAdmin,
  accessToken,
}: {
  serverId: number;
  userId: string;
  userName: string;
  isAdmin: boolean;
  accessToken: string;
}): Promise<void> {
  const secure = await shouldUseSecureCookies();
  const maxAge = 30 * 24 * 60 * 60;

  // Create signed session (tamper-proof)
  await createSession({
    id: userId,
    name: userName,
    serverId,
    isAdmin,
  });

  // Store Jellyfin access token separately for API calls
  const c = await cookies();
  c.set("streamystats-token", accessToken, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge,
    secure,
  });
}

export const login = async ({
  serverId,
  username,
  password,
  userAgent,
}: {
  serverId: number;
  username: string;
  password?: string | null;
  userAgent?: string;
}): Promise<void> => {
  const server = await getServerWithSecrets({ serverId: serverId.toString() });

  if (!server) {
    throw new Error("Server not found");
  }

  // Each browser session gets a unique DeviceId so Jellyfin tracks them as
  // separate devices. Without this, re-authenticating revokes the previous
  // token and breaks multi-device sessions (#370).
  const device = {
    id: crypto.randomUUID(),
    name: userAgent ? parseDeviceName(userAgent) : "Streamystats Web",
  };

  const res = await fetch(
    `${getInternalUrl(server)}/Users/AuthenticateByName`,
    {
      method: "POST",
      headers: jellyfinHeaders(server.apiKey, device),
      body: JSON.stringify({ Username: username, Pw: password }),
    },
  );

  if (!res.ok) {
    throw new Error("Failed to login");
  }

  const data = await res.json();

  await setSessionCookies({
    serverId,
    userId: data.User.Id,
    userName: data.User.Name,
    isAdmin: data.User.Policy.IsAdministrator,
    accessToken: data.AccessToken,
  });
};

/**
 * Whether the Jellyfin server behind serverId has Quick Connect enabled.
 */
export const getQuickConnectAvailability = async ({
  serverId,
}: {
  serverId: number;
}): Promise<boolean> => {
  const server = await getServerWithSecrets({ serverId: serverId.toString() });
  if (!server) return false;
  return isQuickConnectEnabled({ serverUrl: getInternalUrl(server) });
};

/**
 * Start a Quick Connect login. Returns the code the user must approve in
 * their Jellyfin app. The secret never reaches the browser: it is kept in a
 * short-lived httpOnly cookie together with the device identity, which
 * `pollQuickConnect` uses to complete the login.
 */
export const startQuickConnect = async ({
  serverId,
  userAgent,
}: {
  serverId: number;
  userAgent?: string;
}): Promise<
  { success: true; code: string } | { success: false; error: string }
> => {
  const server = await getServerWithSecrets({ serverId: serverId.toString() });
  if (!server) {
    return { success: false, error: "Server not found" };
  }

  const device = {
    id: crypto.randomUUID(),
    name: userAgent ? parseDeviceName(userAgent) : "Streamystats Web",
  };

  const result = await initiateQuickConnect({
    serverUrl: getInternalUrl(server),
    device,
  });
  if (!result.ok) {
    return { success: false, error: result.error };
  }

  const payload: QuickConnectCookiePayload = {
    serverId,
    secret: result.secret,
    deviceId: device.id,
    deviceName: device.name,
  };
  const c = await cookies();
  c.set(QUICK_CONNECT_COOKIE, JSON.stringify(payload), {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: QUICK_CONNECT_COOKIE_MAX_AGE,
    secure: await shouldUseSecureCookies(),
  });

  return { success: true, code: result.code };
};

export type QuickConnectPollResult =
  | { status: "pending" }
  | { status: "authorized" }
  | { status: "expired" }
  | { status: "error"; error: string };

/**
 * Poll the pending Quick Connect login started by `startQuickConnect`.
 * Once the user approves the code in Jellyfin, this exchanges the secret
 * for an access token and creates the Streamystats session.
 */
export const pollQuickConnect = async ({
  serverId,
}: {
  serverId: number;
}): Promise<QuickConnectPollResult> => {
  const c = await cookies();
  const payload = parseQuickConnectCookie(c.get(QUICK_CONNECT_COOKIE)?.value);
  if (!payload || payload.serverId !== serverId) {
    return { status: "expired" };
  }

  const server = await getServerWithSecrets({ serverId: serverId.toString() });
  if (!server) {
    return { status: "error", error: "Server not found" };
  }
  const serverUrl = getInternalUrl(server);

  const state = await getQuickConnectState({
    serverUrl,
    secret: payload.secret,
  });
  if (!state.ok) {
    if (state.expired) {
      c.delete(QUICK_CONNECT_COOKIE);
      return { status: "expired" };
    }
    return { status: "error", error: state.error };
  }
  if (!state.authenticated) {
    return { status: "pending" };
  }

  const auth = await authenticateWithQuickConnect({
    serverUrl,
    secret: payload.secret,
    device: { id: payload.deviceId, name: payload.deviceName },
  });
  if (!auth.ok || !auth.accessToken) {
    c.delete(QUICK_CONNECT_COOKIE);
    return {
      status: "error",
      error: auth.ok ? "Jellyfin did not return an access token" : auth.error,
    };
  }

  await setSessionCookies({
    serverId,
    userId: auth.user.id,
    userName: auth.user.name ?? auth.user.id,
    isAdmin: auth.user.isAdmin,
    accessToken: auth.accessToken,
  });
  c.delete(QUICK_CONNECT_COOKIE);

  return { status: "authorized" };
};

/**
 * Abandon a pending Quick Connect login.
 */
export const cancelQuickConnect = async (): Promise<void> => {
  const c = await cookies();
  c.delete(QUICK_CONNECT_COOKIE);
};
