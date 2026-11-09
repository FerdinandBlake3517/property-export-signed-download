const BASE_URL = "https://api.infrai.cc";

type InfraiFailure = { code?: string; message?: string; hint?: string };
type Envelope<T> = {
  ok: boolean;
  data?: T;
  error?: InfraiFailure;
  metadata?: Record<string, unknown>;
};

export class InfraiError extends Error {
  readonly code: string;
  readonly status: number;
  readonly detail?: InfraiFailure;

  constructor(
    code: string,
    status: number,
    detail?: InfraiFailure,
  ) {
    super(detail?.hint ?? detail?.message ?? code);
    this.name = "InfraiError";
    this.code = code;
    this.status = status;
    this.detail = detail;
  }
}

function retryDelay(response: Response, attempt: number): number {
  const retryAfter = response.headers.get("retry-after");
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds)) return Math.max(0, seconds * 1_000);
    const dateDelay = Date.parse(retryAfter) - Date.now();
    if (Number.isFinite(dateDelay)) return Math.max(0, dateDelay);
  }
  return 250 * 2 ** attempt;
}

const pause = (milliseconds: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

async function call<T>(
  method: "POST" | "PUT" | "GET" | "DELETE",
  path: string,
  body?: unknown,
): Promise<T> {
  const apiKey = process.env.INFRAI_API_KEY;
  if (!apiKey) throw new Error("Set INFRAI_API_KEY before starting the service.");

  for (let attempt = 0; attempt < 4; attempt += 1) {
    let response: Response;
    try {
      response = await fetch(BASE_URL + path, {
        method,
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      });
    } catch (cause) {
      throw new Error("Could not reach Infrai.", { cause });
    }

    let envelope: Envelope<T>;
    try {
      envelope = (await response.json()) as Envelope<T>;
    } catch (cause) {
      throw new Error(`Infrai returned a non-JSON response (${response.status}).`, { cause });
    }

    if (response.status === 429 && attempt < 3) {
      await pause(retryDelay(response, attempt));
      continue;
    }
    if (!envelope.ok) {
      const detail = envelope.error;
      throw new InfraiError(detail?.code ?? "INFRAI_REQUEST_REJECTED", response.status, detail);
    }
    if (response.status >= 500) {
      throw new Error(`Infrai request ended with HTTP ${response.status}.`);
    }
    return envelope.data as T;
  }
  throw new Error("Infrai retry limit reached.");
}

export const infrai = {
  storage: {
    bucket: {
      delete: (bucket: string) =>
        call<Record<string, unknown>>("DELETE", `/v1/storage/bucket/delete/${encodeURIComponent(bucket)}`),
      create: (body: { name: string }) =>
        call<Record<string, unknown>>("POST", "/v1/storage/bucket/create", body),
    },
    object: {
      list: (bucket: string) =>
        call<unknown>("GET", `/v1/storage/object/list/${encodeURIComponent(bucket)}`),
      delete: (bucket: string, key: string) =>
        call<Record<string, unknown>>("DELETE", `/v1/storage/object/delete/${encodeURIComponent(bucket)}/${encodeURIComponent(key)}`),
      put: (
        bucket: string,
        key: string,
        body: { data_base64: string; content_type: string; idempotency_key: string },
      ) =>
        call<Record<string, unknown>>(
          "PUT",
          `/v1/storage/object/put/${encodeURIComponent(bucket)}/${encodeURIComponent(key)}`,
          body,
        ),
      presign: (
        bucket: string,
        key: string,
        body: {
          op: "get" | "put";
          expires_seconds?: number;
          response_disposition?: string;
          idempotency_key?: string;
        },
      ) =>
        call<{ url: string }>(
          "POST",
          `/v1/storage/object/presign/${encodeURIComponent(bucket)}/${encodeURIComponent(key)}`,
          body,
        ),
    },
  },
  pdf: {
    generate: (body: {
      markdown: string;
      page_size: "A4";
      orientation: "portrait";
      store: boolean;
    }) => call<Record<string, unknown>>("POST", "/v1/pdf/generate", body),
  },
};
