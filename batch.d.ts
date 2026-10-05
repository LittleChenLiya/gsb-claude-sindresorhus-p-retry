import type {Options, RetryContext} from './index.js';

/**
The retry context passed to batch-level callbacks. Same as `RetryContext`, plus the `index` of the item in the input array.
*/
export type BatchRetryContext = RetryContext & {
	/**
	The index of the item in the input array.
	*/
	readonly index: number;
};

export type BatchOptions = Omit<Options, 'onFailedAttempt' | 'shouldRetry' | 'shouldConsumeRetry'> & {
	/**
	The maximum number of item function calls allowed to run at the same time. Must be an integer ≥ 1 or `Infinity`.

	Only the actual function calls are limited. Backoff waits and failure callbacks never hold a slot, so other items can run while an item is waiting to retry.

	@default Infinity
	*/
	readonly concurrency?: number;

	/**
	Same as `pRetry` `onFailedAttempt`, except the context also includes the item `index`.
	*/
	readonly onFailedAttempt?: (context: BatchRetryContext) => void | Promise<void>;

	/**
	Same as `pRetry` `shouldRetry`, except the context also includes the item `index`.
	*/
	readonly shouldRetry?: (context: BatchRetryContext) => boolean | Promise<boolean>;

	/**
	Same as `pRetry` `shouldConsumeRetry`, except the context also includes the item `index`.
	*/
	readonly shouldConsumeRetry?: (context: BatchRetryContext) => boolean | Promise<boolean>;
};

/**
The settled outcome of one batch item, in the style of `Promise.allSettled`.
*/
export type BatchResult<ValueType> = {
	readonly status: 'fulfilled';
	readonly value: ValueType;
} | {
	readonly status: 'rejected';
	readonly reason: unknown;
};

export type Batch<ValueType> = {
	/**
	Resolves with the fixed-length results array (one slot per input item, in input order) once every item has fulfilled or rejected.

	Never rejects because of an item failure: a failing item only occupies its own slot and does not cancel the other items.
	*/
	readonly promise: Promise<Array<BatchResult<ValueType>>>;

	/**
	Live view of the result slots, in input order. A slot is `undefined` until the corresponding item settles.
	*/
	readonly results: Array<BatchResult<ValueType> | undefined>;

	/**
	Cancel the batch.

	Items still waiting for a permit are rejected with the given reason and their functions are never called. Cancelling never starts a permit-waiting item.

	In-flight function calls are not interrupted: a non-cooperative function keeps its permit until it settles. Use `drain()` to wait for those.
	*/
	cancel(reason?: unknown): void;

	/**
	Returns a promise that resolves once no permits are held and no items are waiting for one.

	Items sleeping between retries (backoff) do not hold permits, so `drain()` can resolve while retries are still pending.
	*/
	drain(): Promise<void>;
};

/**
Run a batch of functions with independent `pRetry` retry state per item, while limiting only the concurrency of the actual function calls.

Each item is retried independently with the given `pRetry` options. The `concurrency` limit applies only to the actual function calls: a permit is acquired before each attempt and released as soon as the attempt settles, so backoff waits and failure callbacks never hold a slot. The retry loop as a whole never occupies a slot.

Results keep the input order: `results[i]` corresponds to `tasks[i]`, and the array always has exactly one slot per input item.

@example
```
import {pRetryBatch} from 'p-retry';

const batch = pRetryBatch([
	() => fetchUser(1),
	() => fetchUser(2),
	() => fetchUser(3),
], {
	concurrency: 2,
	retries: 3,
	onFailedAttempt: ({index, attemptNumber, retriesLeft}) => {
		console.log(`Item ${index} attempt ${attemptNumber} failed. ${retriesLeft} retries left.`);
	},
});

const results = await batch.promise;
//=> [{status: 'fulfilled', value: …}, …]
```
*/
export function pRetryBatch<ValueType>(
	tasks: Iterable<(attemptNumber: number, index: number) => PromiseLike<ValueType> | ValueType>,
	options?: BatchOptions
): Batch<ValueType>;
