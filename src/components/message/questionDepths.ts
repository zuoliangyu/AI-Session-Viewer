interface QuestionParent {
  messageIndex: number;
  parentMessageIndex: number | null;
}

/** Resolve each parent edge once, including broken links and cyclic histories. */
export function questionDepths(questions: readonly QuestionParent[]): Map<number, number> {
  const byIndex = new Map(questions.map((question) => [question.messageIndex, question]));
  const depths = new Map<number, number>();
  for (const start of byIndex.keys()) {
    if (depths.has(start)) continue;
    const path: number[] = [];
    const positions = new Map<number, number>();
    let current: number | null = start;
    while (current !== null && byIndex.has(current) && !depths.has(current) && !positions.has(current)) {
      positions.set(current, path.length);
      path.push(current);
      current = byIndex.get(current)!.parentMessageIndex;
    }

    const cycleStart = current === null ? undefined : positions.get(current);
    let depth: number;
    if (cycleStart !== undefined) {
      // A cycle node has exactly cycleLength distinct ancestors, including itself.
      depth = path.length - cycleStart;
      for (let index = cycleStart; index < path.length; index++) depths.set(path[index], depth);
      path.length = cycleStart;
    } else {
      // A missing parent, just like a root, adds no ancestor to the last node.
      depth = current === null ? -1 : depths.get(current) ?? -1;
    }
    for (let index = path.length - 1; index >= 0; index--) {
      depths.set(path[index], ++depth);
    }
  }
  return depths;
}
