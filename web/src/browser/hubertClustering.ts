export function hubertLinspaceSeeds(vectorCount: number, clusterCount: number): number[] {
  if (vectorCount <= 0 || clusterCount <= 0) return []
  return Array.from({ length: clusterCount }, (_, index) => clusterCount === 1
    ? 0
    : Math.floor(index * (vectorCount - 1) / (clusterCount - 1)))
}
