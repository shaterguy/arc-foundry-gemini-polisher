import { OAUTH_OFFLINE_SCOPE, OAUTH_ORIGIN, OAUTH_SCOPE, oauthJson } from "../lib/oauth.js";

export function GET(): Response {
  return oauthJson({
    issuer: OAUTH_ORIGIN,
    authorization_endpoint: `${OAUTH_ORIGIN}/oauth/authorize`,
    token_endpoint: `${OAUTH_ORIGIN}/oauth/token`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    token_endpoint_auth_methods_supported: ["none"],
    code_challenge_methods_supported: ["S256"],
    client_id_metadata_document_supported: true,
    scopes_supported: [OAUTH_SCOPE, OAUTH_OFFLINE_SCOPE],
  }, 200, { "access-control-allow-origin": "*" });
}

export function OPTIONS(): Response {
  return new Response(null, {
    status: 204,
    headers: {
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET, OPTIONS",
      "access-control-allow-headers": "content-type",
      "cache-control": "no-store",
    },
  });
}
