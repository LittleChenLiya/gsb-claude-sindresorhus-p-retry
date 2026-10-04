import pRetry, {AbortError} from './index.js';

/**
Error thrown when an operation failed after it was committed.

The operation may (or may not) have been applied by the other side, so its
result is unknown. The wrapper refuses to retry such failures automatically;
the caller must decide (for example via `shouldReplay` or by reconciling out
of band).
*/
export class UnknownResultError extends Error {
	constructor(cause, attemptNumber) {
		super('The operation was committed before it failed, so its result is unknown. It may have been applied and must not be retried blindly.');
		this.name = 'UnknownResultError';
		this.unknownResult = true;
		this.cause = cause;
		this.attemptNumber = attemptNumber;
	}
}

/**
Check whether an error carries the unknown-result marker.

@param error - The error to check.
*/
export function isUnknownResultError(error) {
	return error instanceof UnknownResultError || Boolean(error?.unknownResult);
}

/**
Retry wrapper for operations that may commit (perform an irreversible side
effect, such as sending a request) before their outcome is known.

Protocol:

- `input` receives an `attempt` context: `{attemptNumber, committed, markCommitted()}`.
  The context is created fresh for every attempt, so commit state can never
  leak from one attempt into the next.
- Call `attempt.markCommitted()` at the exact point where the operation
  becomes non-replayable (for example right after the request bytes are sent,
  before the response is known).
- A failure before `markCommitted()` is safe: it is retried under p-retry's
  normal conditions (`retries`, `shouldRetry`, `shouldConsumeRetry`, …).
- A failure after `markCommitted()` stops retrying immediately and rejects
  with an `UnknownResultError` (marked with `unknownResult: true`), unless the
  caller explicitly grants replay permission via the `shouldReplay` option.
- `shouldReplay` may be sync or async. It is only consulted for committed
  failures. Returning `false` (or omitting the option) yields the
  `UnknownResultError`; returning `true` lets the failure fall back to
  p-retry's normal retry conditions.
- An aborted `signal` always wins: cancellation is never overridden by replay
  permission, even if the abort happens while an async `shouldReplay` is
  pending.
- The wrapper never inspects HTTP status codes or error shapes to guess
  whether a commit happened; only `markCommitted()` defines that point.

@param input - Receives the per-attempt context and returns the result.
@param options - All `pRetry` options, plus `shouldReplay`.
*/
export default async function pRetryCommitted(input, options = {}) {
	const {shouldReplay, ...retryOptions} = options;

	if (shouldReplay !== undefined && typeof shouldReplay !== 'function') {
		throw new TypeError('Expected `shouldReplay` to be a function.');
	}

	return pRetry(async attemptNumber => {
		// Fresh, isolated commit state for this attempt only.
		let committed = false;
		const attempt = Object.freeze({
			attemptNumber,
			get committed() {
				return committed;
			},
			markCommitted() {
				committed = true;
			},
		});

		try {
			return await input(attempt);
		} catch (error) {
			if (!committed) {
				// Failed before committing: safe to retry under the normal conditions.
				throw error;
			}

			// Committed: cancellation always takes priority over replay permission.
			retryOptions.signal?.throwIfAborted();

			const replayAllowed = shouldReplay
				? await shouldReplay(Object.freeze({error, attemptNumber}))
				: false;

			// The signal may have been aborted while the permission was pending.
			retryOptions.signal?.throwIfAborted();

			if (!replayAllowed) {
				// AbortError unwraps to the UnknownResultError and stops p-retry.
				throw new AbortError(new UnknownResultError(error, attemptNumber));
			}

			// Explicit replay permission granted: fall back to p-retry's
			// normal retry conditions for this failure.
			throw error;
		}
	}, retryOptions);
}
