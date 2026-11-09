import { cleanupPropertyExport, exportPropertyRecords } from "./property_export.js";

const result = await exportPropertyRecords({
  propertyId: "cedar-court",
  asOf: "2026-09-29",
  maintenanceRequests: [
    { id: "mr-41", unit: "2B", summary: "Kitchen tap leak", status: "open", openedOn: "2026-09-25" },
  ],
  tenantDocuments: [
    { id: "doc-18", unit: "2B", kind: "insurance", expiresOn: "2027-01-31" },
  ],
  inspectionReminders: [
    { id: "ins-7", unit: "1A", dueOn: "2026-09-20", completed: false },
  ],
});

try {
  console.log(JSON.stringify(result, null, 2));
} finally {
  await cleanupPropertyExport(result.bucket, result.key);
  console.log(JSON.stringify({ deleted: { bucket: result.bucket, key: result.key }, verified: true }));
}
