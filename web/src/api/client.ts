import type { ApiError, ApiErrorResponse } from "../types"

export const responseError = async (response: Response): Promise<ApiError> => {
  let message = `${response.status} ${response.statusText}`
  try {
    const body = await response.json() as ApiErrorResponse
    if (typeof body.detail === "string") message = body.detail
  } catch { }
  const error = new Error(message) as ApiError
  error.status = response.status
  return error
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
  if (!response.ok) throw await responseError(response)
  return response.json() as Promise<T>
}
