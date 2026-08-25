export const runtime = "nodejs";

export function GET(): Response {
  return Response.json({
    name: "arc-foundry-gemini-polisher",
    version: "0.1.0-dev1",
    status: "ok",
  });
}
