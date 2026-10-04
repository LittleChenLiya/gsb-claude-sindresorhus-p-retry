import pRetry, {AbortError} from './index.js';

const toError = value => value instanceof Error
	? value
	: new TypeError(`Non-error was thrown: "${value}". You should only throw errors.`);

/**
Thrown when an operation fails after it may have committed, so its result is unknown.

Replaying the operation could cause the side effects to happen twice (a double charge,
a duplicate email, …), so the wrapper rejects with this error unless the caller explicitly
grants replay permission through `onCommittedFailure`.
*/
export class UnknownResultError extends Error {
	constructor(error) {
		super();
		this.name = 'UnknownResultError';
		this.unknownResult = true;
		this.originalError = toError(error);
		this.message = `Operation failed after it may have committed, so its result is unknown: ${this.originalError.message}`;
	}
}

function abortWith(reason) {
	return new AbortError(toError(reason));
}

/**
Retry wrapper for operations that may have committed before they fail.

The operation receives an `attempt` context. Call `attempt.commit()` the moment the
operation's side effects have left the process (for example, right after a `fetch`
resolves, before reading the response):

- A failure *before* `commit()` is retried under the exact same rules as `pRetry`.
- A failure *after* `commit()` rejects with an `UnknownResultError` unless the caller
  explicitly grants replay permission through `onCommittedFailure`.
- Each attempt gets a fresh context, so committed state never leaks between attempts.
- An `AbortSignal` always wins: an aborted attempt rejects with the abort reason and
  replay permission is never consulted.

The wrapper is built on top of `pRetry` and does not modify it. It never guesses HTTP
status codes — only the operation itself knows when it has committed.
*/
export default async function pRetryCommitted(input, options = {}) {
	const {
		onCommittedFailure,
		shouldRetry: userShouldRetry,
		shouldConsumeRetry: userShouldConsumeRetry,
		signal,
		...retryOptions
	} = options;

	if (onCommittedFailure !== undefined && typeof onCommittedFailure !== 'function') {
		throw new TypeError('Expected `onCommittedFailure` to be a function.');
	}

	const permitReplay = onCommittedFailure ?? (() => false);

	return pRetry(async attemptNumber => {
		let committed = false;

		// Fresh context for every attempt; the `committed` flag is closed over by this
		// attempt only, so it can never leak into the next attempt.
		const attempt = {
			attemptNumber,
			commit() {
				committed = true;
			},
		};

		try {
			return await input(attempt);
		} catch (error) {
			// The operation explicitly asked to abort; let pRetry unwrap the reason.
			if (error instanceof AbortError) {
				throw error;
			}

			if (!committed) {
				// Pre-commit failure: normal pRetry retry rules apply.
				throw error;
			}

			// AbortSignal always wins over replay permission.
			if (signal?.aborted) {
				throw abortWith(signal.reason ?? new Error('The operation was aborted.'));
			}

			let permitted = false;
			try {
				permitted = await permitReplay({error: toError(error), attemptNumber});
			} catch (permissionError) {
				// The caller could not confirm whether replay is safe; abort without retrying.
				throw abortWith(permissionError);
			}

			// Re-check after the async permission check: cancellation during the check still wins.
			if (signal?.aborted) {
				throw abortWith(signal.reason ?? new Error('The operation was aborted.'));
			}

			if (permitted) {
				// Explicit replay permission granted: let pRetry retry under its normal rules.
				throw error;
			}

			throw new UnknownResultError(error);
		}
	}, {
		...retryOptions,
		signal,
		shouldConsumeRetry(context) {
			// An unknown-result failure is terminal; it must not consume the retry budget.
			if (context.error instanceof UnknownResultError) {
				return false;
			}

			return userShouldConsumeRetry ? userShouldConsumeRetry(context) : true;
		},
		shouldRetry(context) {
			if (context.error instanceof UnknownResultError) {
				return false;
			}

			return userShouldRetry ? userShouldRetry(context) : true;
		},
	});
}
