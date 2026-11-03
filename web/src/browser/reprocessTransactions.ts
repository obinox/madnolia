import type { BrowserReprocessPublishUpdate, BrowserReprocessTransactionJournal } from "../types/browserAnalysis"
import { BROWSER_ANALYSIS_REPROCESS_JOURNAL, BROWSER_ANALYSIS_REPROCESS_STAGE_DIRECTORY } from "../browserAnalysisConstants"
import { readWorkspaceFile, readWorkspaceJson, removeWorkspaceEntry, writeWorkspaceFile, writeWorkspaceJson } from "./workspace"

let transactionQueue: Promise<void> = Promise.resolve()

function serialize<T>(operation: () => Promise<T>): Promise<T> {
  const result = transactionQueue.catch(() => undefined).then(operation)
  transactionQueue = result.then(() => undefined, () => undefined)
  return result
}

async function removeIfPresent(path: string): Promise<void> {
  try { await removeWorkspaceEntry(path) }
  catch (error) { if (!(error instanceof DOMException && error.name === "NotFoundError")) throw error }
}

function validateJournal(value: unknown): asserts value is BrowserReprocessTransactionJournal {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Reprocess transaction journal is corrupt: expected an object.")
  const candidate = value as Partial<BrowserReprocessTransactionJournal>
  if (typeof candidate.transaction_id !== "string" || !Array.isArray(candidate.entries)) throw new Error("Reprocess transaction journal is corrupt: invalid transaction fields.")
  const stage = `${BROWSER_ANALYSIS_REPROCESS_STAGE_DIRECTORY}/${candidate.transaction_id}`
  if (!/^[\w-]{1,128}$/u.test(candidate.transaction_id) || !["applying", "rollback-complete", "committed"].includes(candidate.state ?? "")) throw new Error("Reprocess transaction journal is corrupt: invalid transaction fields.")
  const paths = new Set<string>()
  for (const entry of candidate.entries) {
    if (!entry || typeof entry.path !== "string" || !/^(analyses|projects)\/[\w.-]+\/.+$/u.test(entry.path) || entry.path.split("/").includes("..") || paths.has(entry.path)) throw new Error("Reprocess transaction journal is corrupt: invalid or duplicate target path.")
    paths.add(entry.path)
    if (entry.backup_path !== null && (typeof entry.backup_path !== "string" || !entry.backup_path.startsWith(`${stage}/backup-`) || entry.backup_path.includes(".."))) throw new Error("Reprocess transaction journal is corrupt: invalid backup path.")
    if (entry.delete_after !== undefined && typeof entry.delete_after !== "boolean") throw new Error("Reprocess transaction journal is corrupt: invalid operation.")
  }
}

async function recoverInternal(): Promise<void> {
  let journal: BrowserReprocessTransactionJournal
  try { journal = await readWorkspaceJson(BROWSER_ANALYSIS_REPROCESS_JOURNAL) }
  catch (error) {
    if (error instanceof DOMException && error.name === "NotFoundError") return
    if (error instanceof SyntaxError) throw new Error(`Reprocess transaction journal is corrupt JSON: ${error.message}`)
    throw error
  }
  validateJournal(journal)
  if (journal.state === "applying") {
    for (const entry of [...journal.entries].reverse()) {
      if (entry.backup_path) await writeWorkspaceFile(entry.path, await readWorkspaceFile(entry.backup_path))
      else await removeIfPresent(entry.path)
    }
    journal = { ...journal, state: "rollback-complete" }
    await writeWorkspaceJson(BROWSER_ANALYSIS_REPROCESS_JOURNAL, journal)
  }
  await removeIfPresent(BROWSER_ANALYSIS_REPROCESS_JOURNAL)
  await removeIfPresent(`${BROWSER_ANALYSIS_REPROCESS_STAGE_DIRECTORY}/${journal.transaction_id}`)
}

export function recoverReprocessTransaction(): Promise<void> {
  return serialize(recoverInternal)
}

export function transactionalPublish(transactionId: string, updates: BrowserReprocessPublishUpdate[]): Promise<void> {
  return serialize(async () => {
    if (!/^[\w-]{1,128}$/u.test(transactionId)) throw new Error("Reprocess transaction id is invalid.")
    await recoverInternal()
    const stage = `${BROWSER_ANALYSIS_REPROCESS_STAGE_DIRECTORY}/${transactionId}`
    const journal: BrowserReprocessTransactionJournal = { transaction_id: transactionId, state: "applying", entries: [] }
    for (const [index, update] of updates.entries()) {
      const stagedPath = `${stage}/staged-${index}.bin`
      if (update.data) await writeWorkspaceFile(stagedPath, update.data)
      let backupPath: string | null = null
      try {
        backupPath = `${stage}/backup-${index}.bin`
        const original = await readWorkspaceFile(update.path)
        await writeWorkspaceFile(backupPath, original)
        if (update.backup_archive_path) await writeWorkspaceFile(update.backup_archive_path, original)
      } catch (error) {
        if (!(error instanceof DOMException && error.name === "NotFoundError")) throw error
        backupPath = null
      }
      journal.entries.push({ path: update.path, backup_path: backupPath, delete_after: update.delete_after })
    }
    await writeWorkspaceJson(BROWSER_ANALYSIS_REPROCESS_JOURNAL, journal)
    try {
      for (const [index, update] of updates.entries()) {
        if (update.delete_after) await removeIfPresent(update.path)
        else await writeWorkspaceFile(update.path, await readWorkspaceFile(`${stage}/staged-${index}.bin`))
      }
      await writeWorkspaceJson(BROWSER_ANALYSIS_REPROCESS_JOURNAL, { ...journal, state: "committed" })
    } catch (error) {
      await recoverInternal()
      throw error
    }
    try { await recoverInternal() }
    catch (error) {
      console.error("Committed reprocess transaction cleanup failed; committed journal retained for recovery.", error)
    }
  })
}
