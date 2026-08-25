import {
  defaultOAuthStore,
  exchangeAuthorizationCode,
  oauthErrorResponse,
  oauthJson,
  oauthRuntimeConfigured,
  readFormUrlEncoded,
  rotateRefreshToken,
} from "../lib/oauth.js";

export async function POST(request: Request): Promise<Response> {
  if (!oauthRuntimeConfigured()) return oauthErrorResponse(new Error("configuration"));
  try {
    const form = await readFormUrlEncoded(request);
    const grantType = form.get("grant_type");
    const tokens = grantType === "authorization_code"
      ? await exchangeAuthorizationCode(defaultOAuthStore, form)
      : grantType === "refresh_token"
        ? await rotateRefreshToken(defaultOAuthStore, form)
        : null;
    if (!tokens) return oauthJson({ error: "unsupported_grant_type" }, 400);
    return oauthJson(tokens);
  } catch (error) {
    return oauthErrorResponse(error);
  }
}

export function GET(): Response {
  return oauthJson({ error: "invalid_request" }, 405, { allow: "POST" });
}
