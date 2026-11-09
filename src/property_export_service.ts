import { createServer } from "node:http";
import { z, ZodError } from "zod";
import { InfraiError } from "./infrai.js";
import { cleanupPropertyExport, exportPropertyRecords, exportRequestSchema } from "./property_export.js";

async function readJson(request: import("node:http").IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function json(response: import("node:http").ServerResponse, status: number, body: unknown) {
  response.writeHead(status, { "Content-Type": "application/json" });
  response.end(JSON.stringify(body));
}

export const server = createServer(async (request, response) => {
  if (!["POST", "DELETE"].includes(request.method ?? "") || request.url !== "/exports") {
    json(response, 404, { error: "Route not found" });
    return;
  }

  try {
    if (request.method === "DELETE") {
      const resource = z.object({ bucket: z.string().regex(/^property-exports-[0-9a-f-]{36}$/), key: z.string().min(1) }).parse(await readJson(request));
      await cleanupPropertyExport(resource.bucket, resource.key);
      json(response, 200, { deleted: true });
      return;
    }
    const input = exportRequestSchema.parse(await readJson(request));
    json(response, 201, await exportPropertyRecords(input));
  } catch (error) {
    if (error instanceof ZodError) {
      json(response, 400, { error: "Invalid export request", issues: error.issues });
      return;
    }
    if (error instanceof SyntaxError) {
      json(response, 400, { error: "Request body must be JSON" });
      return;
    }
    if (error instanceof InfraiError) {
      const status = error.status >= 400 && error.status < 500 ? error.status : 502;
      json(response, status, { error: error.code, message: error.message });
      return;
    }
    json(response, 502, { error: "Export could not be created" });
  }
});

if (process.env.NODE_ENV !== "test") {
  const port = Number(process.env.PORT ?? 3000);
  server.listen(port, () => console.log(`Property export service listening on ${port}`));
}
