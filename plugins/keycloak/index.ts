/**
 * Keycloak user plugin for Degoog
 *
 * Drop this folder into:  data/plugins/keycloak/
 *
 * What it does:
 *   - Gates the Settings page with Keycloak OIDC (RequestMiddleware / settingsGate)
 *   - Injects an email + Gravatar chip next to the gear icon on every search page
 *
 * Routes:
 *   GET /api/plugin/keycloak/whoami      → {authenticated, email, gravatarUrl}
 *   GET /api/plugin/keycloak/login       → redirect to Keycloak auth endpoint
 *   GET /api/plugin/keycloak/logout      → clear session cookie + redirect to Keycloak logout
 *   GET /api/plugin/keycloak/client.js   → DOM injection script for the chip
 *
 * Session is a HMAC-SHA256-signed cookie (kc-session) issued after OIDC callback.
 * The chip uses the session for email/Gravatar — no Traefik header required,
 * though the emailHeader setting is read as a fallback if set.
 */

// ---------------------------------------------------------------------------
// Inline type declarations
// ---------------------------------------------------------------------------

type PluginRouteMethod = "get" | "post" | "put" | "delete" | "patch";

interface PluginRoute {
  method: PluginRouteMethod;
  path: string;
  handler: (req: Request) => Response | Promise<Response>;
}

type SlotPanelPosition =
  | "above-results"
  | "below-results"
  | "above-sidebar"
  | "below-sidebar"
  | "knowledge-panel"
  | "at-a-glance";

interface SlotPlugin {
  id: string;
  name: string;
  description: string;
  position: SlotPanelPosition;
  trigger: (query: string) => boolean | Promise<boolean>;
  execute: (
    query: string,
    context?: unknown,
  ) => Promise<{ title?: string; html: string }>;
  settingsSchema?: SettingField[];
  configure?: (settings: Record<string, string | string[]>) => void;
}

interface MiddlewareResult {
  redirect: string;
}

interface RequestMiddleware {
  id: string;
  name: string;
  settingsGate?: boolean;
  handle: (
    req: Request,
    context?: { route?: string },
  ) => Response | Promise<Response | MiddlewareResult | null>;
  settingsSchema?: SettingField[];
  configure?: (settings: Record<string, string | string[]>) => void;
  isConfigured?: () => boolean | Promise<boolean>;
}

interface SettingField {
  key: string;
  label: string;
  type:
    | "text"
    | "password"
    | "toggle"
    | "textarea"
    | "select"
    | "urllist";
  required?: boolean;
  placeholder?: string;
  description?: string;
  default?: string;
}

// ---------------------------------------------------------------------------
// Runtime configuration
// ---------------------------------------------------------------------------

const cfg: Record<string, string> = {
  keycloakUrl: "",        // https://<host>/realms/<realm>
  clientId: "",
  clientSecret: "",
  sessionSecret: "",      // random string, used to sign session cookies
  sessionTtl: "28800",   // seconds — 8 hours
  logoutUrl: "",          // Keycloak realm logout URL
  emailHeader: "",        // optional Traefik header fallback (X-Forwarded-Email)
};

// ---------------------------------------------------------------------------
// OIDC state store  (in-memory CSRF protection, 5-minute TTL)
// ---------------------------------------------------------------------------

const oidcStates = new Map<string, number>();

function generateState(): string {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  return Array.from(b)
    .map((x) => x.toString(16).padStart(2, "0"))
    .join("");
}

function storeState(state: string): void {
  const now = Date.now();
  for (const [k, exp] of oidcStates) if (exp < now) oidcStates.delete(k);
  oidcStates.set(state, now + 5 * 60 * 1000);
}

function consumeState(state: string): boolean {
  const exp = oidcStates.get(state);
  if (!exp || exp < Date.now()) return false;
  oidcStates.delete(state);
  return true;
}

// ---------------------------------------------------------------------------
// Session cookie helpers  (HMAC-SHA256 signed)
// ---------------------------------------------------------------------------

async function signingKey(): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(cfg.sessionSecret || "changeme-set-sessionSecret"),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

async function signSession(email: string): Promise<string> {
  const exp =
    Math.floor(Date.now() / 1000) + parseInt(cfg.sessionTtl || "28800");
  const payload = btoa(JSON.stringify({ email, exp }));
  const key = await signingKey();
  const raw = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(payload),
  );
  const sig = btoa(String.fromCharCode(...new Uint8Array(raw)));
  return `${payload}.${sig}`;
}

async function verifySession(token: string): Promise<string | null> {
  const dot = token.lastIndexOf(".");
  if (dot < 0) return null;
  const payload = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  try {
    const key = await signingKey();
    const rawSig = Uint8Array.from(atob(sig), (c) => c.charCodeAt(0));
    const ok = await crypto.subtle.verify(
      "HMAC",
      key,
      rawSig,
      new TextEncoder().encode(payload),
    );
    if (!ok) return null;
    const { email, exp } = JSON.parse(atob(payload)) as {
      email: string;
      exp: number;
    };
    if (exp < Math.floor(Date.now() / 1000)) return null;
    return email;
  } catch {
    return null;
  }
}

function getCookie(req: Request, name: string): string | null {
  const header = req.headers.get("cookie") ?? "";
  const m = header.match(new RegExp(`(?:^|; )${name}=([^;]*)`));
  return m ? decodeURIComponent(m[1]) : null;
}

// ---------------------------------------------------------------------------
// Gravatar URL helper  (SHA-256, Gravatar detects by hash length)
// ---------------------------------------------------------------------------

async function gravatarUrl(email: string): Promise<string> {
  const bytes = new TextEncoder().encode(email.trim().toLowerCase());
  const buf = await crypto.subtle.digest("SHA-256", bytes);
  const hash = Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return `https://www.gravatar.com/avatar/${hash}?s=82&d=identicon`;
}

// ---------------------------------------------------------------------------
// Shared settings schema  (used by both middleware and slot)
// ---------------------------------------------------------------------------

const settingsSchema: SettingField[] = [
  {
    key: "keycloakUrl",
    label: "Keycloak realm URL",
    type: "text",
    placeholder: "https://keycloak.example.com/realms/myrealm",
    description: "Base URL of the Keycloak realm — no trailing slash.",
    required: true,
  },
  {
    key: "clientId",
    label: "Client ID",
    type: "text",
    placeholder: "degoog",
    required: true,
  },
  {
    key: "clientSecret",
    label: "Client secret",
    type: "password",
    required: true,
  },
  {
    key: "sessionSecret",
    label: "Session signing secret",
    type: "password",
    description: "Random string used to sign session cookies. Change this!",
    required: true,
  },
  {
    key: "sessionTtl",
    label: "Session lifetime (seconds)",
    type: "text",
    placeholder: "28800",
    description: "How long a settings session stays valid. Default: 28800 (8 h).",
    default: "28800",
  },
  {
    key: "logoutUrl",
    label: "Logout URL",
    type: "text",
    placeholder:
      "https://keycloak.example.com/realms/myrealm/protocol/openid-connect/logout?redirect_uri=https://search.example.com/",
    description:
      "Full Keycloak realm logout URL including redirect_uri query param.",
  },
  {
    key: "emailHeader",
    label: "Email header (optional fallback)",
    type: "text",
    placeholder: "X-Forwarded-Email",
    description:
      "If set, /whoami also checks this Traefik-injected header. " +
      "Not needed if the OIDC session is active.",
  },
];

function applySettings(settings: Record<string, string | string[]>): void {
  for (const [k, v] of Object.entries(settings)) {
    if (k in cfg && typeof v === "string" && v.trim() !== "") {
      cfg[k] = v.trim();
    }
  }
}

// ---------------------------------------------------------------------------
// Route: GET /debug  — verify cfg was populated by configure()
// ---------------------------------------------------------------------------

const debugRoute: PluginRoute = {
  method: "get",
  path: "/debug",
  handler(): Response {
    return new Response(
      JSON.stringify({
        configured: !!(cfg.keycloakUrl && cfg.clientId && cfg.clientSecret && cfg.sessionSecret),
        keycloakUrl: cfg.keycloakUrl || "(not set)",
        clientId: cfg.clientId || "(not set)",
        clientSecret: cfg.clientSecret ? "***" : "(not set)",
        sessionSecret: cfg.sessionSecret ? "***" : "(not set)",
        sessionTtl: cfg.sessionTtl,
        logoutUrl: cfg.logoutUrl || "(not set)",
        emailHeader: cfg.emailHeader || "(not set)",
      }, null, 2),
      { headers: { "content-type": "application/json" } },
    );
  },
};

// ---------------------------------------------------------------------------
// Route: GET /whoami
// ---------------------------------------------------------------------------

const whoamiRoute: PluginRoute = {
  method: "get",
  path: "/whoami",
  async handler(req: Request): Promise<Response> {
    // 1. Try OIDC session cookie
    const sessionToken = getCookie(req, "kc-session");
    let email: string | null = sessionToken
      ? await verifySession(sessionToken)
      : null;

    // 2. Fall back to Traefik-injected header (if configured)
    if (!email && cfg.emailHeader) {
      email = req.headers.get(cfg.emailHeader) || null;
    }

    const gUrl = email ? await gravatarUrl(email) : null;

    return new Response(
      JSON.stringify({ authenticated: !!email, email, gravatarUrl: gUrl }),
      {
        headers: {
          "content-type": "application/json",
          "cache-control": "no-store",
        },
      },
    );
  },
};

// ---------------------------------------------------------------------------
// Route: GET /login  — redirect to Keycloak auth
// ---------------------------------------------------------------------------

const loginRoute: PluginRoute = {
  method: "get",
  path: "/login",
  handler(req: Request): Response {
    const state = generateState();
    storeState(state);

    const origin = new URL(req.url).origin;
    const params = new URLSearchParams({
      client_id: cfg.clientId,
      redirect_uri: `${origin}/api/settings/auth/callback`,
      response_type: "code",
      scope: "openid email",
      state,
    });

    return new Response(null, {
      status: 302,
      headers: {
        Location: `${cfg.keycloakUrl}/protocol/openid-connect/auth?${params}`,
      },
    });
  },
};

// ---------------------------------------------------------------------------
// Route: GET /logout  — clear cookie + redirect to Keycloak logout
// ---------------------------------------------------------------------------

const logoutRoute: PluginRoute = {
  method: "get",
  path: "/logout",
  handler(): Response {
    return new Response(null, {
      status: 302,
      headers: {
        Location: cfg.logoutUrl || "/",
        "Set-Cookie":
          "kc-session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0",
      },
    });
  },
};

// ---------------------------------------------------------------------------
// Route: GET /client.js  — chip DOM injection (served fresh for cfg values)
// ---------------------------------------------------------------------------

const clientJsRoute: PluginRoute = {
  method: "get",
  path: "/client.js",
  handler(): Response {
    const js = `
(function () {
  if (document.getElementById('kc-user-chip')) return;

  fetch('/api/plugin/keycloak/whoami')
    .then(function (r) { return r.json(); })
    .then(function (u) {
      if (!u.authenticated || !u.email) return;

      var gear = document.getElementById('nav-settings-results');
      if (!gear || !gear.parentNode) return;

      var avatarStyle = 'width:40.8px;height:40.8px;border-radius:50%;flex-shrink:0;';

      var av = document.createElement('img');
      av.id = 'kc-avatar';
      av.src = u.gravatarUrl;
      av.alt = u.email.charAt(0).toUpperCase();
      av.style.cssText = avatarStyle + 'object-fit:cover;';
      av.onerror = function () {
        var fb = document.createElement('span');
        fb.textContent = u.email.charAt(0).toUpperCase();
        fb.style.cssText = avatarStyle +
          'background:var(--accent,#5b5ea6);color:#fff;' +
          'display:inline-flex;align-items:center;justify-content:center;' +
          'font-weight:700;font-size:1em;';
        av.parentNode && av.parentNode.replaceChild(fb, av);
      };

      var nm = document.createElement('span');
      nm.id = 'kc-email';
      nm.textContent = u.email;
      nm.style.cssText = 'display:inline-flex;align-items:center;line-height:1;';

      var chip = document.createElement('a');
      chip.id = 'kc-user-chip';
      chip.href = '/api/plugin/keycloak/logout';
      chip.title = 'Signed in as ' + u.email + ' — click to sign out';
      chip.style.cssText =
        'display:inline-flex;align-items:center;gap:8px;' +
        'font-size:0.95em;text-decoration:none;color:inherit;' +
        'margin-left:12px;cursor:pointer;line-height:1;';

      chip.appendChild(nm);
      chip.appendChild(av);

      gear.parentNode.insertBefore(chip, gear.nextSibling);
    })
    .catch(function () {});
}());
`;
    return new Response(js, {
      headers: {
        "content-type": "application/javascript; charset=utf-8",
        "cache-control": "no-store",
      },
    });
  },
};

// ---------------------------------------------------------------------------
// RequestMiddleware: OIDC gate for Settings
// ---------------------------------------------------------------------------

const oidcMiddleware: RequestMiddleware = {
  id: "keycloak",
  name: "Keycloak OIDC",
  settingsGate: true,

  async handle(
    req: Request,
    context?: { route?: string },
  ): Promise<Response | MiddlewareResult | null> {
    const route = context?.route;
    console.error(`[keycloak] handle called — route=${route ?? "(none)"} configured=${!!(cfg.keycloakUrl && cfg.clientId)}`);

    // ------------------------------------------------------------------
    // 1. Check auth status — called before showing settings
    // ------------------------------------------------------------------
    if (route === "settings-auth") {
      const token = getCookie(req, "kc-session");
      if (token && (await verifySession(token))) return null; // valid session

      return new Response(
        JSON.stringify({
          required: true,
          valid: false,
          loginUrl: "/api/plugin/keycloak/login",
        }),
        { headers: { "content-type": "application/json" } },
      );
    }

    // ------------------------------------------------------------------
    // 2. OIDC callback — exchange code for tokens, issue session cookie
    // ------------------------------------------------------------------
    if (route === "settings-auth-callback") {
      const url = new URL(req.url);
      const code = url.searchParams.get("code");
      const state = url.searchParams.get("state");

      if (!code || !state || !consumeState(state)) {
        return new Response("Invalid or expired state", { status: 400 });
      }

      // Exchange code for tokens
      const tokenRes = await fetch(
        `${cfg.keycloakUrl}/protocol/openid-connect/token`,
        {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            grant_type: "authorization_code",
            client_id: cfg.clientId,
            client_secret: cfg.clientSecret,
            code,
            redirect_uri: `${url.origin}/api/settings/auth/callback`,
          }),
        },
      );

      if (!tokenRes.ok) {
        return new Response("Token exchange failed", { status: 502 });
      }

      const tokens = (await tokenRes.json()) as {
        id_token?: string;
        access_token?: string;
      };

      // Extract email from id_token claims
      let email: string | null = null;
      if (tokens.id_token) {
        try {
          const claims = JSON.parse(
            atob(tokens.id_token.split(".")[1]),
          ) as { email?: string; preferred_username?: string };
          email = claims.email ?? claims.preferred_username ?? null;
        } catch { /* ignore */ }
      }

      // Fall back to userinfo endpoint
      if (!email && tokens.access_token) {
        try {
          const ui = await fetch(
            `${cfg.keycloakUrl}/protocol/openid-connect/userinfo`,
            { headers: { Authorization: `Bearer ${tokens.access_token}` } },
          );
          if (ui.ok) {
            const data = (await ui.json()) as {
              email?: string;
              preferred_username?: string;
            };
            email = data.email ?? data.preferred_username ?? null;
          }
        } catch { /* ignore */ }
      }

      if (!email) {
        return new Response("Could not resolve email from token", {
          status: 502,
        });
      }

      const sessionToken = await signSession(email);
      const ttl = cfg.sessionTtl || "28800";

      return new Response(null, {
        status: 302,
        headers: {
          Location: "/settings",
          "Set-Cookie": `kc-session=${encodeURIComponent(sessionToken)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${ttl}`,
        },
      });
    }

    // ------------------------------------------------------------------
    // 3. Password fallback — not supported
    // ------------------------------------------------------------------
    if (route === "settings-auth-post") {
      return new Response(null, { status: 400 });
    }

    return null;
  },

  settingsSchema,
  configure: applySettings,

  isConfigured(): boolean {
    return !!(cfg.keycloakUrl && cfg.clientId && cfg.clientSecret && cfg.sessionSecret);
  },
};

// ---------------------------------------------------------------------------
// Slot: invisible bootstrap for client.js
// ---------------------------------------------------------------------------

const userSlot: SlotPlugin = {
  id: "keycloak",
  name: "Keycloak OIDC",
  description: "Protects the Settings page with Keycloak OIDC",
  position: "above-results",

  trigger(_query: string): boolean {
    return true;
  },

  async execute(_query: string): Promise<{ title?: string; html: string }> {
    const html = `<img src="/__kc_boot__" style="display:none;position:absolute;width:0;height:0"
  onerror="(function(i){var s=document.createElement('script');s.src='/api/plugin/keycloak/client.js';document.head.appendChild(s);i.remove();})(this)">`;
    return { html };
  },

  settingsSchema,
  configure: applySettings,
};

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export const routes: PluginRoute[] = [
  debugRoute,
  whoamiRoute,
  loginRoute,
  logoutRoute,
  clientJsRoute,
];
export const middleware: RequestMiddleware = oidcMiddleware;
export const slot: SlotPlugin = userSlot;
export default oidcMiddleware;
