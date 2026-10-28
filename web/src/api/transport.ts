export async function runtimeFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const request = input instanceof Request ? input : null
  const path = request?.url ?? input.toString()
  const url = new URL(path, window.location.origin)
  if (!url.pathname.startsWith("/api/")) return fetch(input, init)
  const requestInit: RequestInit = request ? {
    method: init?.method ?? request.method,
    headers: init?.headers ?? request.headers,
    signal: init?.signal ?? request.signal,
    body: init?.body ?? (request.method === "GET" || request.method === "HEAD" ? undefined : await request.clone().arrayBuffer()),
    ...init,
  } : init ?? {}
  const { handleBrowserRequest } = await import("../browser/router")
  return await handleBrowserRequest(`${url.pathname}${url.search}`, requestInit)
    ?? new Response(JSON.stringify({ detail: `Browser API route not implemented: ${requestInit.method ?? "GET"} ${url.pathname}` }), {
      status: 501,
      headers: { "Content-Type": "application/json" },
    })
}
