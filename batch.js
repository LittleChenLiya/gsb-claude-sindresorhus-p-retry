import pRetry, {AbortError} from './index.js';

function validateConcurrency(concurrency) {
	if (concurrency === undefined) {
		return;
	}

	if (typeof concurrency !== 'number' || Number.isNaN(concurrency)) {
		throw new TypeError('Expected `concurrency` to be a number or Infinity.');
	}

	if (Number.isFinite(concurrency) && (!Number.isInteger(concurrency) || concurrency < 1)) {
		throw new TypeError('Expected `concurrency` to be an integer ≥ 1 or Infinity.');
	}
}

function asAbortError(reason) {
	if (reason instanceof Error) {
		return new AbortError(reason);
	}

	// Preserve non-Error reasons (for example, the default DOMException abort
	// reason) so the rejected slot keeps the original reason.
	const error = new AbortError('The batch was cancelled.');

	if (reason !== undefined) {
		error.originalError = reason;
	}

	return error;
}

export function pRetryBatch(tasks, options = {}) {
	if (tasks === null || tasks === undefined || typeof tasks[Symbol.iterator] !== 'function') {
		throw new TypeError('Expected `tasks` to be an iterable of functions.');
	}

	const taskList = [];

	for (const task of tasks) {
		if (typeof task !== 'function') {
			throw new TypeError('Expected every item of `tasks` to be a function.');
		}

		taskList.push(task);
	}

	if (options === null || typeof options !== 'object') {
		throw new TypeError('Expected `options` to be an object.');
	}

	const {
		concurrency = Number.POSITIVE_INFINITY,
		signal,
		onFailedAttempt,
		shouldRetry,
		shouldConsumeRetry,
		...retryOptions
	} = options;

	validateConcurrency(concurrency);

	// Internal cancellation. Combined with the user-provided signal so either
	// one stops the batch.
	const controller = new AbortController();
	const combinedSignal = signal
		? AbortSignal.any([signal, controller.signal])
		: controller.signal;

	// Semaphore. A permit is held only while an item's actual function call is
	// in flight. Backoff waits and failure callbacks run without a permit, so
	// other items can use the slot meanwhile.
	let available = concurrency;
	let held = 0;
	const waiters = new Set();
	const idleListeners = new Set();

	const notifyIdle = () => {
		if (held === 0 && waiters.size === 0) {
			for (const listener of idleListeners) {
				listener();
			}

			idleListeners.clear();
		}
	};

	const acquire = () => {
		if (combinedSignal.aborted) {
			return Promise.reject(asAbortError(combinedSignal.reason));
		}

		if (waiters.size === 0 && available > 0) {
			available--;
			held++;
			return Promise.resolve();
		}

		return new Promise((resolve, reject) => {
			const waiter = {resolve, reject, onAbort: undefined};
			waiter.onAbort = () => {
				waiters.delete(waiter);
				reject(asAbortError(combinedSignal.reason));
				notifyIdle();
			};

			waiters.add(waiter);
			combinedSignal.addEventListener('abort', waiter.onAbort, {once: true});
		});
	};

	const release = () => {
		held--;

		// Hand the permit directly to the oldest waiter. Cancelled waiters have
		// already been removed by their abort handlers, so a cancelled batch
		// never starts a permit-waiting item.
		const waiter = waiters.values().next().value;
		if (waiter && !combinedSignal.aborted) {
			waiters.delete(waiter);
			combinedSignal.removeEventListener('abort', waiter.onAbort);
			held++;
			waiter.resolve();
		} else {
			available++;
		}

		notifyIdle();
	};

	// Fixed-size result array, filled in input order as items settle. A failing
	// item only occupies its own slot and never cancels the others.
	const results = Array.from({length: taskList.length});
	let remaining = taskList.length;
	let settleBatch;
	const batchSettled = new Promise(resolve => {
		settleBatch = resolve;
	});

	// Batch-level callbacks receive the item `index` in addition to the
	// regular retry context.
	const withIndex = (callback, index) => callback && (context => callback({...context, index}));

	const runItem = async (task, index) => {
		const itemOptions = {
			...retryOptions,
			signal: combinedSignal,
			onFailedAttempt: withIndex(onFailedAttempt, index),
			shouldRetry: withIndex(shouldRetry, index),
			shouldConsumeRetry: withIndex(shouldConsumeRetry, index),
		};

		try {
			const value = await pRetry(async attemptNumber => {
				// The permit is acquired per attempt, never for the whole retry loop.
				await acquire();

				try {
					if (combinedSignal.aborted) {
						throw asAbortError(combinedSignal.reason);
					}

					return await task(attemptNumber, index);
				} finally {
					release();
				}
			}, itemOptions);

			results[index] = {status: 'fulfilled', value};
		} catch (error) {
			results[index] = {status: 'rejected', reason: error};
		}

		remaining--;

		if (remaining === 0) {
			settleBatch();
		}

		notifyIdle();
	};

	for (const [index, task] of taskList.entries()) {
		runItem(task, index);
	}

	if (taskList.length === 0) {
		settleBatch();
	}

	let cancelled = false;

	return {
		// Resolves with the fixed-length results array once every item has
		// either fulfilled or rejected. Never rejects because of an item
		// failure.
		promise: (async () => {
			await batchSettled;
			return results;
		})(),

		// Live view of the result slots, in input order. Slots are `undefined`
		// until the corresponding item settles.
		results,

		// Cancel the batch. Items still waiting for a permit are rejected with
		// the reason and their functions are never called. In-flight function
		// calls are not interrupted; they keep their permit until they settle.
		cancel(reason) {
			if (cancelled) {
				return;
			}

			cancelled = true;
			controller.abort(reason ?? new Error('The batch was cancelled.'));
		},

		// Resolves once no permits are held and no items are waiting for one.
		// Items sleeping between retries do not hold permits.
		async drain() {
			if (held === 0 && waiters.size === 0) {
				return;
			}

			await new Promise(resolve => {
				const listener = () => {
					idleListeners.delete(listener);
					resolve();
				};

				idleListeners.add(listener);
			});
		},
	};
}
