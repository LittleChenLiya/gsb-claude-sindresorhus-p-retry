import type {Options, RetryContext} from './index.js';

/**
Thrown when an operation fails after it may have committed, so its result is unknown.
*/
export class UnknownResultError extends Error {
	readonly name: 'UnknownResultError';
	readonly unknownResult: true;
	readonly originalError: Error;

	constructor(error: unknown);
}

/**
The attempt context passed to the operation.
*/
export type CommittedAttemptContext = {
	/**
	The attempt number (starts at 1).
	*/
	readonly attemptNumber: number;

	/**
	Mark the current attempt as committed.

	Call it once, right after the operation's side effects have left the process
	(for example, right after a `fetch` resolves), before the outcome is known.
	*/
	commit(): void;
};

export type CommittedFailureContext = {
	/**
	The error thrown by the operation.
	*/
	readonly error: Error;

	/**
	The attempt number that failed.
	*/
	readonly attemptNumber: number;
};

export type CommittedOptions = Options & {
	/**
	Called when an attempt fails after having committed.

	Return `true` to allow one more replay, `false` (the default) to reject with an
	`UnknownResultError`. The function can be async — its result is awaited before
	retrying. If it throws (or rejects), retrying is aborted with that error.

	An aborted `AbortSignal` always wins over this callback: when the signal is aborted,
	the operation rejects with the abort reason and this callback is never consulted.
	*/
	readonly onCommittedFailure?: (context: CommittedFailureContext) => boolean | Promise<boolean>;
};

/**
Retry wrapper for operations that may have committed before they fail.

The operation receives an `attempt` context. Call `attempt.commit()` the moment the
operation's side effects have left the process:

- A failure *before* `commit()` is retried under the exact same rules as `pRetry`.
- A failure *after* `commit()` rejects with an `UnknownResultError` unless the caller
  explicitly grants replay permission through `onCommittedFailure`.
- Each attempt gets a fresh context, so committed state never leaks between attempts.
- An `AbortSignal` always wins: an aborted attempt rejects with the abort reason and
  replay permission is never consulted.

The wrapper is built on top of `pRetry` and does not modify it. It never guesses HTTP
status codes — only the operation itself knows when it has committed.

@example
```
import pRetryCommitted from 'p-retry/committed';

async function payOrder(attempt) {
	const response = await fetch('/api/pay', {method: 'POST'});
	attempt.commit(); // The request has reached the server; the outcome is unknown.
	if (!response.ok) {
		throw new Error(response.statusText);
	}
	return response.json();
}

const result = await pRetryCommitted(payOrder, {
	retries: 2,
	onCommittedFailure: async () => await confirmWithUser('Retry payment? It may be charged twice.'),
});
```
*/
export default function pRetryCommitted<T>(
	input: (context: CommittedAttemptContext) => PromiseLike<T> | T,
	options?: CommittedOptions
): Promise<T>;
