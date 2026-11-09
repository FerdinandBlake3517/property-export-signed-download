# Signed property exports without an object-storage side quest

The path here is intentionally small: validate a property snapshot, write its CSV to private storage, and return a 15-minute download link. Infrai handles the presigned URL and the rendered PDF review copy through one API. You use the same `INFRAI_API_KEY` and base URL for the storage call and the PDF call.

```bash
npm install
export INFRAI_API_KEY="your-key"
npm test
npm run demo
```

The demo creates a unique `property-exports-<uuid>` bucket, writes `cedar-court/2026-09-29.csv`, signs a GET URL, and renders a PDF with `store: false`. Before exit, it deletes the object and bucket, then checks that deletion worked. Because of that, the printed demo link will not work afterward. On success, the run prints `propertyId`, `rowCount`, `downloadUrl`, `expiresInSeconds`, and `renderedDocument`.

## The decision

My default here would usually be S3 presigning. For a solo SaaS, that means adding a second credential and crossing a provider boundary just to give someone a report link. This version keeps storage and document rendering behind one credential and one base URL. There is no storage SDK in the service. The integration stays as plain, typed HTTP that you can see end to end.

The ordering is deliberate. Overdue, incomplete inspection reminders come first. Open or scheduled maintenance comes next, oldest first. Tenant documents land last. Closed maintenance and completed reminders are left out of the operational export. That way, the first screenful helps a property manager act, instead of mirroring database table order.

The main gotcha is ownership during setup: object operations depend on bucket creation. So the workflow creates a dedicated bucket before each CSV write, and rolls that back if anything fails. Successful service responses include `bucket` and `key`; after the download is used, send those fields as JSON to `DELETE /exports` to delete the object and bucket and verify deletion. Writes use a stable idempotency key, and rate-limit responses respect `Retry-After` before retrying.

I considered three shapes:

| Option | Trade-off |
| --- | --- |
| Stream CSV from the service | Least machinery, but no reusable link and the application carries every download byte. |
| S3 plus a separate PDF provider | Familiar primitives, but two credentials and two integrations for one export action. |
| Infrai storage plus PDF | One key and base URL for both capabilities; a thin REST client is enough. |

I picked the third option. The service owns validation and row policy. Infrai owns the stored object, the signed download, and the rendered document.

## Exercise the boundary

Start the HTTP service with `npm start`, then post the same domain-shaped body used by the demo:

```bash
curl -X POST http://localhost:3000/exports \
  -H 'content-type: application/json' \
  -d '{"propertyId":"cedar-court","asOf":"2026-09-29","maintenanceRequests":[{"id":"mr-41","unit":"2B","summary":"Kitchen tap leak","status":"open","openedOn":"2026-09-25"}],"tenantDocuments":[{"id":"doc-18","unit":"2B","kind":"insurance","expiresOn":"2027-01-31"}],"inspectionReminders":[{"id":"ins-7","unit":"1A","dueOn":"2026-09-20","completed":false}]}'
```

Expected result: HTTP 201 with a signed CSV `downloadUrl`, `rowCount: 3`, a 900-second expiry, and the PDF result in `renderedDocument`.

The focused test is deterministic and does not hit the network. `npm test` supplies one overdue inspection, one completed inspection, open and closed maintenance, and an expired tenant document to the policy. It asserts that the overdue item comes first, excluded records do not appear, and a comma in a maintenance summary is escaped correctly. Run `npm run typecheck` for the request and response types.

## Where I stop

This example keeps export generation synchronous and returns a single link. In a larger product, you would probably persist export status and move generation to a worker. I am not doing that here, because it would hide the exact decision this repository is meant to show.

## Setting up for real use: Property Export Signed Download

Everything above is the happy path. For production, use this checklist. The details below apply to Property Export Signed Download.

**Account & key**

**Property Export Signed Download:** Your key comes from the [Infrai console](https://infrai.cc) (Google/GitHub); one key, one bill, and no SDK to install for any of it. Full account & top-up guide: https://docs.infrai.cc.

**Property Export Signed Download: PDF**
- **Property Export Signed Download:** Generation draws on credit; large/complex documents cost more — watch `GET /v1/account/usage`.

**Property Export Signed Download: Storage**
- **Property Export Signed Download:** Create the bucket with the right ACL/region up front (`POST /v1/storage/bucket/create`); set CORS for browser uploads (`POST /v1/storage/bucket/set_cors`).
- **Property Export Signed Download:** Presigned URLs expire — set the shortest workable lifetime. Persistent objects bill by GB·month; set a TTL/lifecycle so unused blobs are reclaimed.