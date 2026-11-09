import { randomUUID } from "node:crypto";
import { InfraiError } from "./infrai.js";
import { z } from "zod";
import { infrai } from "./infrai.js";

const isoDate = /^\d{4}-\d{2}-\d{2}$/;

export const exportRequestSchema = z.object({
  propertyId: z.string().min(1),
  asOf: z.string().regex(isoDate),
  maintenanceRequests: z.array(z.object({
    id: z.string().min(1),
    unit: z.string().min(1),
    summary: z.string().min(1),
    status: z.enum(["open", "scheduled", "closed"]),
    openedOn: z.string().regex(isoDate),
  })),
  tenantDocuments: z.array(z.object({
    id: z.string().min(1),
    unit: z.string().min(1),
    kind: z.string().min(1),
    expiresOn: z.string().regex(isoDate).nullable(),
  })),
  inspectionReminders: z.array(z.object({
    id: z.string().min(1),
    unit: z.string().min(1),
    dueOn: z.string().regex(isoDate),
    completed: z.boolean(),
  })),
});

export type ExportRequest = z.infer<typeof exportRequestSchema>;

type ExportRow = {
  recordType: "inspection_reminder" | "maintenance_request" | "tenant_document";
  recordId: string;
  unit: string;
  detail: string;
  date: string;
  state: string;
};

function csvCell(value: string): string {
  return /[",\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}

export function buildPropertyCsv(input: ExportRequest): string {
  const overdue = input.inspectionReminders
    .filter((item) => !item.completed && item.dueOn < input.asOf)
    .sort((a, b) => a.dueOn.localeCompare(b.dueOn))
    .map<ExportRow>((item) => ({
      recordType: "inspection_reminder",
      recordId: item.id,
      unit: item.unit,
      detail: "Inspection due",
      date: item.dueOn,
      state: "overdue",
    }));

  const maintenance = input.maintenanceRequests
    .filter((item) => item.status !== "closed")
    .sort((a, b) => a.openedOn.localeCompare(b.openedOn))
    .map<ExportRow>((item) => ({
      recordType: "maintenance_request",
      recordId: item.id,
      unit: item.unit,
      detail: item.summary,
      date: item.openedOn,
      state: item.status,
    }));

  const documents = input.tenantDocuments
    .sort((a, b) => a.unit.localeCompare(b.unit) || a.kind.localeCompare(b.kind))
    .map<ExportRow>((item) => ({
      recordType: "tenant_document",
      recordId: item.id,
      unit: item.unit,
      detail: item.kind,
      date: item.expiresOn ?? "",
      state: item.expiresOn && item.expiresOn < input.asOf ? "expired" : "on_file",
    }));

  const header = ["record_type", "record_id", "unit", "detail", "date", "state"];
  const lines = [...overdue, ...maintenance, ...documents].map((row) =>
    [row.recordType, row.recordId, row.unit, row.detail, row.date, row.state]
      .map(csvCell)
      .join(","),
  );
  return [header.join(","), ...lines].join("\n") + "\n";
}

function safeSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, "-");
}

export async function exportPropertyRecords(input: ExportRequest) {
  const bucket = `property-exports-${randomUUID()}`;
  const exportId = `${safeSegment(input.propertyId)}-${input.asOf}`;
  const key = `${safeSegment(input.propertyId)}/${input.asOf}.csv`;
  const csv = buildPropertyCsv(input);

  await infrai.storage.bucket.create({ name: bucket });
  try {
    await infrai.storage.object.put(bucket, key, {
      data_base64: Buffer.from(csv, "utf8").toString("base64"),
      content_type: "text/csv; charset=utf-8",
      idempotency_key: `property-export-${exportId}`,
    });
    const signed = await infrai.storage.object.presign(bucket, key, {
      op: "get",
      expires_seconds: 900,
      response_disposition: `attachment; filename="${exportId}.csv"`,
      idempotency_key: `property-download-${exportId}`,
    });
    const renderedDocument = await infrai.pdf.generate({
      markdown: `# Property export\n\nProperty: ${input.propertyId}\n\nSnapshot date: ${input.asOf}\n\nCSV rows: ${csv.trimEnd().split("\n").length - 1}`,
      page_size: "A4",
      orientation: "portrait",
      store: false,
    });

    return {
      bucket,
      key,
      propertyId: input.propertyId,
      rowCount: csv.trimEnd().split("\n").length - 1,
      downloadUrl: signed.url,
      expiresInSeconds: 900,
      renderedDocument,
    };
  } catch (error) {
    try {
      await cleanupPropertyExport(bucket, key);
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], `Export failed; cleanup required for ${bucket}/${key}`);
    }
    throw error;
  }
}

export async function cleanupPropertyExport(bucket: string, key: string) {
  const ignoreMissing = async (operation: () => Promise<unknown>) => {
    try { await operation(); } catch (error) {
      if (!(error instanceof InfraiError && error.status === 404)) throw error;
    }
  };
  await ignoreMissing(() => infrai.storage.object.delete(bucket, key));
  await ignoreMissing(() => infrai.storage.bucket.delete(bucket));
  try {
    await infrai.storage.object.list(bucket);
  } catch (error) {
    if (error instanceof InfraiError && error.status === 404) return;
    throw error;
  }
  throw new Error(`Bucket deletion could not be verified: ${bucket}`);
}
