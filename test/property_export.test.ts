import assert from "node:assert/strict";
import test from "node:test";
import { buildPropertyCsv, exportRequestSchema } from "../src/property_export.js";

test("puts overdue inspections first and omits closed maintenance", () => {
  const input = exportRequestSchema.parse({
    propertyId: "cedar-court",
    asOf: "2026-09-29",
    maintenanceRequests: [
      { id: "closed-1", unit: "3C", summary: "Paint", status: "closed", openedOn: "2026-09-01" },
      { id: "open-1", unit: "2B", summary: "Tap, leaking", status: "open", openedOn: "2026-09-25" },
    ],
    tenantDocuments: [
      { id: "doc-1", unit: "1A", kind: "insurance", expiresOn: "2026-09-10" },
    ],
    inspectionReminders: [
      { id: "done-1", unit: "4D", dueOn: "2026-09-01", completed: true },
      { id: "due-1", unit: "1A", dueOn: "2026-09-20", completed: false },
    ],
  });

  const lines = buildPropertyCsv(input).trim().split("\n");
  assert.match(lines[1], /^inspection_reminder,due-1/);
  assert.match(lines[2], /^maintenance_request,open-1,2B,"Tap, leaking"/);
  assert.match(lines[3], /^tenant_document,doc-1/);
  assert.equal(lines.some((line) => line.includes("closed-1") || line.includes("done-1")), false);
});

test("export has explicit cleanup and rolls back failed generation", async () => {
  const { exportPropertyRecords, cleanupPropertyExport } = await import("../src/property_export.js");
  const previousKey = process.env.INFRAI_API_KEY;
  process.env.INFRAI_API_KEY = "test";
  const originalFetch = globalThis.fetch;
  const calls: string[] = [];
  let failPdf = false;
  globalThis.fetch = async (url, init) => {
    const path = new URL(String(url)).pathname;
    calls.push(`${init?.method} ${path}`);
    if (path === "/v1/pdf/generate") {
      assert.equal(JSON.parse(String(init?.body)).store, false);
      if (failPdf) return Response.json({ ok: false, error: { code: "REJECTED" } }, { status: 400 });
    }
    if (path.includes("/object/list/")) return Response.json({ ok: false, error: { code: "NOT_FOUND" } }, { status: 404 });
    return Response.json({ ok: true, data: { url: "https://example.test/download" } });
  };
  const input = exportRequestSchema.parse({ propertyId: "test", asOf: "2026-09-29", maintenanceRequests: [], tenantDocuments: [], inspectionReminders: [] });
  try {
    const result = await exportPropertyRecords(input);
    assert.match(result.bucket, /^property-exports-/);
    assert.equal(calls.some(call => call.startsWith("DELETE")), false);
    await cleanupPropertyExport(result.bucket, result.key);
    assert.match(calls.at(-3)!, /^DELETE .*object\/delete\//);
    assert.match(calls.at(-2)!, /^DELETE .*bucket\/delete\//);
    assert.match(calls.at(-1)!, /^GET .*object\/list\//);
    failPdf = true;
    await assert.rejects(exportPropertyRecords(input), /REJECTED/);
    assert.match(calls.at(-3)!, /^DELETE .*object\/delete\//);
    assert.match(calls.at(-2)!, /^DELETE .*bucket\/delete\//);
    assert.match(calls.at(-1)!, /^GET .*object\/list\//);
  } finally {
    globalThis.fetch = originalFetch;
    if (previousKey === undefined) delete process.env.INFRAI_API_KEY;
    else process.env.INFRAI_API_KEY = previousKey;
  }
});
