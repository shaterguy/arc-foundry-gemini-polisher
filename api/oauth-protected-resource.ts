import { OAUTH_ORIGIN, OAUTH_RESOURCE, OAUTH_SCOPE, oauthJson } from "../lib/oauth.js";

export function GET(): Response {
  return oauthJson({
    resource: OAUTH_RESOURCE,
    authorization_servers: [OAUTH_ORIGIN],
    scopes_supported: [OAUTH_SCOPE],
    bearer_methods_supported: ["header"],
  }, 200, { "access-control-allow-origin": "*" });
}

export function OPTIONS(): Response {
  return new Response(null, {
    status: 204,
    headers: {
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET, OPTIONS",
      "access-control-allow-headers": "content-type, authorization",
      "cache-control": "no-store",
    },
  });
}
