import assert from "node:assert/strict";
import { questionDepths } from "../src/components/message/questionDepths.ts";

const question = (messageIndex, parentMessageIndex) => ({ messageIndex, parentMessageIndex });
const parents = [question(4, 2), question(1, null), question(3, 1), question(2, 1), question(5, 99)];
assert.deepEqual([...questionDepths(parents)].sort((a, b) => a[0] - b[0]), [[1, 0], [2, 1], [3, 1], [4, 2], [5, 0]]);
const cycles = [question(1, 2), question(2, 3), question(3, 1), question(4, 1), question(5, 4), question(6, 6)];
assert.deepEqual([...questionDepths(cycles)].sort((a, b) => a[0] - b[0]), [[1, 3], [2, 3], [3, 3], [4, 4], [5, 5], [6, 1]]);
assert.equal(questionDepths([]).size, 0);

// Reverse ordering exercises the longest unresolved path without recursion.
let parentReads = 0;
const count = 50_000;
const chain = Array.from({ length: count }, (_, index) => ({
  messageIndex: count - index,
  get parentMessageIndex() { parentReads++; return count - index === 1 ? null : count - index - 1; },
}));
const depths = questionDepths(chain);
assert.equal(depths.get(count), count - 1);
assert.equal(depths.get(1), 0);
assert.equal(depths.size, count);
assert.ok(parentReads <= count, `Expected linear parent reads, got ${parentReads}`);
console.log(`Question depths passed: roots, branches, missing parents, cycles, ${count} nodes / ${parentReads} parent reads.`);
