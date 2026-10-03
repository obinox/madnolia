import type { CompositionProject, ExportTarget, SaveCompositionRequest } from "../types"
import { request } from "./client"

export const fetchCompositions = (projectId: string): Promise<CompositionProject[]> =>
  request(`/api/projects/${encodeURIComponent(projectId)}/compositions`)

export const createComposition = (
  projectId: string,
  body: SaveCompositionRequest,
): Promise<CompositionProject> => request(
  "/api/collages",
  undefined,
  { method: "POST", body: JSON.stringify({ project_id: projectId, composition: body }) },
)

export const updateComposition = (
  compositionId: string,
  body: SaveCompositionRequest,
): Promise<CompositionProject> => request(
  `/api/collages/${encodeURIComponent(compositionId)}`,
  undefined,
  { method: "PUT", body: JSON.stringify(body) },
)

export const previewComposition = async (
  projectId: string,
  body: SaveCompositionRequest,
  signal: AbortSignal,
): Promise<Blob> => {
  const response = await fetch(
    `/api/projects/${encodeURIComponent(projectId)}/compositions/preview`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal,
    },
  )
  if (!response.ok) throw new Error(`${response.status} ${await response.text()}`)
  return response.blob()
}

export const exportComposition = async (
  compositionId: string,
  target: ExportTarget,
): Promise<void> => {
  const response = await fetch(
    `/api/collages/${encodeURIComponent(compositionId)}/export/${target}`,
    { method: "POST" },
  )
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`)
  const blob = await response.blob()
  const disposition = response.headers.get("content-disposition") ?? ""
  const filename = disposition.match(/filename="?([^";]+)"?/)?.[1] ?? `export.${target.toLowerCase()}`
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement("a")
  anchor.href = url
  anchor.download = filename
  anchor.click()
  URL.revokeObjectURL(url)
}
