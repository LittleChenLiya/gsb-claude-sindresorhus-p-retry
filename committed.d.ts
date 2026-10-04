import {type Options} from './index.js';

/**
Error thrown when an operation failed after it was committed.

The operation may (or may not) have been applied by the other side, so its result is unknown. Carries the `unknownResult` marker, the original failure as `cause`, and the `attemptNumber` that committed.
*/
export class UnknownResultError extends Error {
	readonly name: 'UnknownResultError';

	/**
	Marker identifying failures whose result is unknown because the operation had already committed.
	*/
	readonly unknownResult: true;

	/**
	The original failure that occurred after the commit point.
	*/
	readonly cause: unknown;

	/**
	The attempt number during which the operation committed and then failed.
	*/
	readonly attemptNumber: number;

	constructor(cause: unknown, attemptNumber: number);
}

/**
Check whether an error carries the unknown-result marker.
*/
export function isUnknownResultError(error: unknown): boolean;

/**
Per-attempt context passed to the `input` function of `pRetryCommitted`.

A fresh context is created for every attempt, so commit state never leaks from one attempt into the next.
*/
export type CommittedAttempt = {
	/**
	The current attempt number, starting at 1.
	*/
	readonly attemptNumber: number;

	/**
	Whether this attempt has passed its commit point.
	*/
	readonly committed: boolean;

	/**
	Mark this attempt as committed: the operation may have caused an irreversible side effect, so a later failure has an unknown result and must not be retried automatically.
	*/
	markCommitted(): void;
};

export type ReplayContext = {
	/**
	The failure that occurred after the commit point.
	*/
	readonly error: unknown;

	/**
	The attempt number that committed and then failed.
	*/
	readonly attemptNumber: number;
};

export type CommittedOptions = Options & {
	/**
	Explicit replay permission, consulted only when an attempt failed after `markCommitted()` was called.

	Return `true` to allow the failure to be retried under p-retry's normal conditions. Return `false` (or omit the option) to stop retrying and reject with an `UnknownResultError`.

	May be sync or async. An aborted `signal` always wins over the granted permission, even if the abort happens while this function is pending.
	*/
	readonly shouldReplay?: (context: ReplayContext) => boolean | Promise<boolean>;
};

/**
Retry wrapper for operations that may commit (perform an irreversible side effect) before their outcome is known.

- Failures before `attempt.markCommitted()` are retried under p-retry's normal conditions.
- Failures after `attempt.markCommitted()` reject with an `UnknownResultError` (marked `unknownResult: true`), unless `shouldReplay` explicitly grants replay permission.
- The wrapper never guesses commit points from HTTP status codes or error shapes; only `markCommitted()` defines them.

@example
```
import pRetryCommitted, {isUnknownResultError} from 'p-retry/committed';

try {
	const charge = await pRetryCommitted(async attempt => {
		const request = buildChargeRequest();
		const response = await send(request);
		attempt.markCommitted(); // The charge may now exist on the server.
		return parseChargeResponse(response);
	}, {retries: 3});
} catch (error) {
	if (isUnknownResultError(error)) {
		// Reconcile out of band instead of retrying blindly.
	}
}
```
*/
export default function pRetryCommitted<T>(
	input: (attempt: CommittedAttempt) => PromiseLike<T> | T,
	options?: CommittedOptions
): Promise<T>;
