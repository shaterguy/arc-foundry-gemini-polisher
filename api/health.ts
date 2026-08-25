export function GET(): Response {
  return Response.json({
    name: "arc-foundry-gemini-polisher",
    version: "0.1.0-dev4",
    status: "ok",
  });
}
