import type { ApiErrorResponse } from "../types"

const responseError = async (response: Response): Promise<string> => {
  try {
    const body = await response.json() as ApiErrorResponse
    if (typeof body.detail === "string") return body.detail
  } catch { }
  return `${response.status} ${response.statusText}`
}

export const request = async <T>(
  path: string,
  signal?: AbortSignal,
  init?: RequestInit,
): Promise<T> => {
  const response = await fetch(path, {
    ...init,
    signal,
    headers: init?.body ? { "Content-Type": "application/json", ...init.headers } : init?.headers,
  })
  if (!response.ok) throw new Error(await responseError(response))
  return response.json() as Promise<T>
}
