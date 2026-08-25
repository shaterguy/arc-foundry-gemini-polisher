import {
  OAUTH_CSRF_COOKIE,
  OWNER_ATTEMPT_LIMIT,
  clearCsrfCookie,
  constantTimeEqual,
  defaultOAuthStore,
  getOwnerFailureCount,
  getOwnerSecret,
  issueAuthorizationCode,
  oauthErrorResponse,
  oauthRuntimeConfigured,
  parseCookie,
  randomOpaqueToken,
  readFormUrlEncoded,
  recordOwnerFailure,
  renderAuthorizationPage,
  validateAuthorizationRequest,
} from "../lib/oauth.js";

export async function GET(request: Request): Promise<Response> {
  if (!oauthRuntimeConfigured()) return oauthErrorResponse(new Error("configuration"));
  try {
    const authorization = await validateAuthorizationRequest(new URL(request.url).searchParams);
    return renderAuthorizationPage(authorization, randomOpaqueToken());
  } catch (error) {
    return oauthErrorResponse(error);
  }
}

export async function POST(request: Request): Promise<Response> {
  if (!oauthRuntimeConfigured()) return oauthErrorResponse(new Error("configuration"));
  try {
    const form = await readFormUrlEncoded(request);
    const authorization = await validateAuthorizationRequest(form);
    const csrfCookie = parseCookie(request, OAUTH_CSRF_COOKIE) ?? "";
    const csrfForm = form.get("csrf") ?? "";
    if (!csrfCookie || !csrfForm || !constantTimeEqual(csrfCookie, csrfForm)) {
      return oauthErrorResponse(new Error("csrf"));
    }
    const priorFailures = await getOwnerFailureCount(defaultOAuthStore, authorization);
    if (priorFailures >= OWNER_ATTEMPT_LIMIT) {
      return new Response("Too many failed authorization attempts", { status: 429, headers: { "cache-control": "no-store" } });
    }
    const suppliedSecret = form.get("owner_secret") ?? "";
    if (!constantTimeEqual(suppliedSecret, getOwnerSecret())) {
      const failures = await recordOwnerFailure(defaultOAuthStore, authorization);
      if (failures >= OWNER_ATTEMPT_LIMIT) {
        return new Response("Too many failed authorization attempts", { status: 429, headers: { "cache-control": "no-store" } });
      }
      return renderAuthorizationPage(authorization, randomOpaqueToken(), "승인 정보가 올바르지 않습니다.");
    }
    const code = await issueAuthorizationCode(defaultOAuthStore, authorization);
    const redirect = new URL(authorization.redirectUri);
    redirect.searchParams.set("code", code);
    redirect.searchParams.set("state", authorization.state);
    return new Response(null, {
      status: 302,
      headers: {
        location: redirect.toString(),
        "cache-control": "no-store",
        "referrer-policy": "no-referrer",
        "set-cookie": clearCsrfCookie(),
      },
    });
  } catch (error) {
    return oauthErrorResponse(error);
  }
}
