import { z } from 'zod';
import { apiErrorSchema } from './contracts.ts';

export class ApiError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

/** Fetch JSON once, check the HTTP result, then validate its runtime shape. */
export async function requestJson<S extends z.ZodType>(
  url: string,
  schema: S,
  init?: RequestInit,
): Promise<z.infer<S>> {
  return (await requestJsonWithResponse(url, schema, init)).data;
}

export async function requestJsonWithResponse<S extends z.ZodType>(
  url: string,
  schema: S,
  init?: RequestInit,
): Promise<{ data: z.infer<S>; response: Response }> {
  const response = await fetch(url, init);
  return { data: await parseJsonResponse(response, schema, url), response };
}

export async function parseJsonResponse<S extends z.ZodType>(
  response: Response,
  schema: S,
  url: string,
): Promise<z.infer<S>> {
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new ApiError(`Expected JSON from ${url}`, response.status);
  }

  if (!response.ok) {
    const parsedError = apiErrorSchema.safeParse(body);
    throw new ApiError(parsedError.success ? parsedError.data.error : `HTTP ${response.status}`, response.status);
  }

  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map(issue => `${issue.path.map(String).join('.') || '<root>'}: ${issue.message}`)
      .join('; ');
    throw new ApiError(`Invalid API response from ${url}: ${details}`, response.status);
  }
  return parsed.data;
}
