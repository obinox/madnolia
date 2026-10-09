import type { ExportProgressProps } from "../types"
import { remoteTaskStage } from "../api/remoteTasks"

export function ExportProgress({ job }: ExportProgressProps) {
  return <div className="search-progress export-progress" role="status" aria-live="polite">
    <div>
      <span>{remoteTaskStage(job.stage)}</span>
      <strong>{Math.floor(job.percent)}%</strong>
    </div>
    <progress max={100} value={job.percent} aria-label="Export progress" />
  </div>
}
