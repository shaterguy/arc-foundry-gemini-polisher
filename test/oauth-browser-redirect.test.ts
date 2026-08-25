import assert from "node:assert/strict";
import test from "node:test";
import {
  OAUTH_RESOURCE,
  OAUTH_SCOPE,
  OAuthProtocolError,
  oauthErrorResponse,
  renderAuthorizationPage,
} from "../lib/oauth";

const authorization = {
  clientId: "https://chatgpt.com/oauth/arc-foundry/client.json",
  redirectUri: "https://chatgpt.com/connector/oauth/callback-test",
  resource: OAUTH_RESOURCE,
  scopes: [OAUTH_SCOPE, "offline_access"],
  state: "state-browser-redirect-1234",
  codeChallenge: "a".repeat(43),
};

test("authorization page permits only self and ChatGPT for form redirect navigation", () => {
  const response = renderAuthorizationPage(authorization, "csrf-test");
  assert.equal(response.status, 200);
  assert.equal(
    response.headers.get("content-security-policy"),
    "default-src 'none'; form-action 'self' https://chatgpt.com; frame-ancestors 'none'; base-uri 'none'",
  );
  assert.match(response.headers.get("set-cookie") ?? "", /__Host-af_oauth_csrf=/u);
});

test("CSRF protocol failures are represented as invalid_request rather than storage outage", async () => {
  const response = oauthErrorResponse(new OAuthProtocolError("invalid_request"));
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: "invalid_request" });
});
