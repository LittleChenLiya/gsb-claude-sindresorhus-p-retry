# p-retry

> Retry a promise-returning or async function

It does exponential backoff and supports custom retry strategies for failed operations.

## Install

```sh
npm install p-retry
```

## Usage

```js
import pRetry, {AbortError} from 'p-retry';

const run = async () => {
	const response = await fetch('https://sindresorhus.com/unicorn');

	// Abort retrying if the resource doesn't exist
	if (response.status === 404) {
		throw new AbortError(response.statusText);
	}

	return response.blob();
};

console.log(await pRetry(run, {retries: 5}));
```

## API

### pRetry(input, options?)

Returns a `Promise` that is fulfilled when calling `input` returns a fulfilled promise. If calling `input` returns a rejected promise, `input` is called again until the max retries are reached, it then rejects with the last rejection reason.

Does not retry on most `TypeErrors`, with the exception of network errors. This is done on a best case basis as different browsers have different [messages](https://developer.mozilla.org/en-US/docs/Web/API/Fetch_API/Using_Fetch#Checking_that_the_fetch_was_successful) to indicate this. See [whatwg/fetch#526 (comment)](https://github.com/whatwg/fetch/issues/526#issuecomment-554604080)

Non-network `TypeError`s always abort retries, even if `shouldConsumeRetry` or `shouldRetry` would otherwise allow another attempt.

#### input

Type: `Function`

Receives the number of attempts as the first argument and is expected to return a `Promise` or any value.

#### options

Type: `object`

##### onFailedAttempt(context)

Type: `Function`

Callback invoked on each failure. Receives a context object containing the error and retry state information.

The function is called _after_ `shouldConsumeRetry` and _before_ `shouldRetry`, for all errors _except_ `AbortError`.

If the function throws, all retries will be aborted and the original promise will reject with the thrown error.

```js
import pRetry from 'p-retry';

const run = async () => {
	const response = await fetch('https://sindresorhus.com/unicorn');

	if (!response.ok) {
		throw new Error(response.statusText);
	}

	return response.json();
};

const result = await pRetry(run, {
	onFailedAttempt: ({error, attemptNumber, retriesLeft, retriesConsumed, retryDelay}) => {
		console.log(`Attempt ${attemptNumber} failed. Retrying in ${retryDelay}ms. ${retriesLeft} retries left.`);
		// 1st request => Attempt 1 failed. Retrying in 1000ms. 5 retries left.
		// 2nd request => Attempt 2 failed. Retrying in 2000ms. 4 retries left.
		// …
	},
	retries: 5
});

console.log(result);
```

The `context` object contains:
- `error` - The error that was thrown
- `attemptNumber` - The attempt number (starts at 1)
- `retriesLeft` - Number of retries remaining
- `retriesConsumed` - Number of retries consumed so far
- `retryDelay` - The delay in milliseconds before the next retry (based on `minTimeout`, `factor`, `maxTimeout`, and `randomize`). This is `0` when the retry is skipped or when no retry will occur based on the checks completed before the current callback runs.

The `onFailedAttempt` function can return a promise. For example, to add a [delay](https://github.com/sindresorhus/delay):

```js
import pRetry from 'p-retry';
import delay from 'delay';

const run = async () => { … };

const result = await pRetry(run, {
	onFailedAttempt: async () => {
		console.log('Waiting for 1 second before retrying');
		await delay(1000);
	}
});
```

##### shouldRetry(context)

Type: `Function`

Decide if a retry should occur based on context. Returning `true` triggers a retry, `false` aborts with the error.

The function is called _after_ `onFailedAttempt` and `shouldConsumeRetry`.

The function is _not_ called on `AbortError`, `TypeError` (except network errors), or if `retries` or `maxRetryTime` are exhausted.

If the function throws, all retries will be aborted and the original promise will reject with the thrown error.

```js
import pRetry from 'p-retry';

const run = async () => { … };

const result = await pRetry(run, {
	shouldRetry: ({error, attemptNumber, retriesLeft}) => !(error instanceof CustomError)
});
```

In the example above, the operation will be retried unless the error is an instance of `CustomError`.

##### shouldConsumeRetry(context)

Type: `Function`

Decide if this failure should consume a retry from the `retries` budget.

When `false` is returned, the failure will not consume a retry or increment backoff values, but is still subject to `maxRetryTime`.

The function is called _before_ `onFailedAttempt` and `shouldRetry`.

The function is _not_ called on `AbortError`.

If the function throws, all retries will be aborted and the original promise will reject with the thrown error.

```js
import pRetry from 'p-retry';

const run = async () => { … };

const result = await pRetry(run, {
	retries: 2,
	shouldConsumeRetry: ({error, retriesLeft}) => !(error instanceof RateLimitError),
});
```

In the example above, `RateLimitError`s will not decrement the available `retries`.

##### retries

Type: `number`\
Default: `10`

The maximum amount of times to retry the operation. Must be a non-negative integer or `Infinity`.

##### factor

Type: `number`\
Default: `2`

The exponential factor to use.

##### minTimeout

Type: `number`\
Default: `1000`

The number of milliseconds before starting the first retry.

Set this to `0` to retry immediately with no delay.

##### maxTimeout

Type: `number`\
Default: `Infinity`

The maximum number of milliseconds between two retries.

##### randomize

Type: `boolean`\
Default: `false`

Randomizes the timeouts by multiplying with a factor between 1 and 2.

##### maxRetryTime

Type: `number`\
Default: `Infinity`

The maximum time (in milliseconds) that the retried operation is allowed to run.

Measured with a monotonic clock (`performance.now()`) so system clock adjustments do not affect the limit.

##### signal

Type: [`AbortSignal`](https://developer.mozilla.org/en-US/docs/Web/API/AbortSignal)

You can abort retrying using [`AbortController`](https://developer.mozilla.org/en-US/docs/Web/API/AbortController).

```js
import pRetry from 'p-retry';

const run = async () => { … };
const controller = new AbortController();

cancelButton.addEventListener('click', () => {
	controller.abort(new Error('User clicked cancel button'));
});

try {
	await pRetry(run, {signal: controller.signal});
} catch (error) {
	console.log(error.message);
	//=> 'User clicked cancel button'
}
```

##### unref

Type: `boolean`\
Default: `false`

Prevents retry timeouts from keeping the process alive.

Only affects platforms with a `.unref()` method on timeouts, such as Node.js.

### makeRetriable(function, options?)

Wrap a function so that each call is automatically retried on failure.

```js
import {makeRetriable} from 'p-retry';

const fetchWithRetry = makeRetriable(fetch, {retries: 5});

const response = await fetchWithRetry('https://sindresorhus.com/unicorn');
```

### pRetryCommitted(input, options?)

Retry wrapper for operations that may have committed before they fail.

A retry is only safe when you know the operation had no side effects. Some operations — a payment, an email send, a database write — reach the remote service and commit, but the connection drops before the response comes back. Retrying blindly would commit twice; not retrying leaves the failure to the caller.

`pRetryCommitted` makes the boundary explicit:

- The operation receives an `attempt` context. Call `attempt.commit()` the moment the operation's side effects have left the process (for example, right after a `fetch` resolves, before reading the response).
- A failure _before_ `commit()` is retried under the exact same rules as `pRetry` (`shouldRetry`, `shouldConsumeRetry`, `retries`, `maxRetryTime`, …).
- A failure _after_ `commit()` rejects with an `UnknownResultError` (marked with `unknownResult: true`) and is **not** retried unless the caller explicitly grants replay permission through `onCommittedFailure`.
- Each attempt gets a fresh context, so the committed state never leaks from one attempt to the next.
- An `AbortSignal` always wins: when the signal is aborted, the promise rejects with the abort reason and replay permission is never consulted.

The wrapper is built on top of `pRetry` and does not modify it. It never guesses HTTP status codes — only the operation itself knows when it has committed.

```js
import pRetryCommitted from 'p-retry/committed';
```

#### input

Type: `Function`

Receives an `attempt` context with:

- `attemptNumber` - The attempt number (starts at 1)
- `commit()` - Mark the current attempt as committed. Call it once, right after the operation's side effects have been sent, before the outcome is known.

The function is expected to return a `Promise` or any value.

#### options

Type: `object`

All [`pRetry` options](#pRetryinput-options) are passed through, plus:

##### onCommittedFailure(context)

Type: `Function`

Called when an attempt fails after having committed. Return `true` to allow one more replay, `false` (the default) to reject with an `UnknownResultError`. The function can be async — its result is awaited before retrying. If it throws (or rejects), retrying is aborted with that error.

An aborted `AbortSignal` always wins over this callback: when the signal is aborted, the promise rejects with the abort reason and the callback is never consulted, even if it would grant permission.

The `context` object contains:

- `error` - The error thrown by the operation
- `attemptNumber` - The attempt number that failed

```js
const result = await pRetryCommitted(payOrder, {
	retries: 3,
	onCommittedFailure: async ({error, attemptNumber}) => {
		// Ask the user, or a higher-level policy, for an explicit replay decision.
		return await askUser(`Payment failed after sending (attempt ${attemptNumber}). Retrying may double-charge. Retry?`);
	},
});
```

### UnknownResultError

Thrown when an operation fails after it may have committed and replay was not permitted.

- `name` - Always `'UnknownResultError'`
- `unknownResult` - Always `true`
- `originalError` - The error thrown by the operation

#### Example 1: payment (non-idempotent)

```js
import pRetryCommitted from 'p-retry/committed';

async function payOrder(attempt) {
	const response = await fetch('/api/pay', {
		method: 'POST',
		body: JSON.stringify({orderId}),
	});

	// The request has reached the server; the outcome is no longer locally knowable.
	attempt.commit();

	if (!response.ok) {
		throw new Error(`Payment failed: ${response.statusText}`);
	}

	return response.json();
}

const result = await pRetryCommitted(payOrder, {
	retries: 2,
	onCommittedFailure: async () => await confirmWithUser('Retry payment? It may be charged twice.'),
});
```

#### Example 2: sending an email

```js
import pRetryCommitted from 'p-retry/committed';

async function sendEmail(attempt) {
	const response = await fetch('/api/send-email', {
		method: 'POST',
		body: JSON.stringify(message),
	});

	// The email may already be sent; a lost response must not send it again without permission.
	attempt.commit();

	if (!response.ok) {
		throw new Error(`Email failed: ${response.statusText}`);
	}

	return {sent: true};
}

await pRetryCommitted(sendEmail, {
	retries: 2,
	onCommittedFailure: async () => await confirmWithUser('Retry sending? The email may already have been sent.'),
});
```

### AbortError(message)
### AbortError(error)

Abort retrying and reject the promise. No callback functions will be called.

### message

Type: `string`

An error message.

### error

Type: `Error`

A custom error.

## Tip

You can pass arguments to the function being retried by wrapping it in an inline arrow function:

```js
import pRetry from 'p-retry';

const run = async emoji => {
	// …
};

// Without arguments
await pRetry(run, {retries: 5});

// With arguments
await pRetry(() => run('🦄'), {retries: 5});
```

## FAQ

### How do I mock timers when testing with this package?

The package uses `setTimeout` and `clearTimeout` from the global scope, so you can use the [Node.js test timer mocking](https://nodejs.org/api/test.html#class-mocktimers) or a package like [`sinon`](https://github.com/sinonjs/sinon).

### How do I stop retries when the process receives SIGINT (Ctrl+C)?

Use an [`AbortController`](https://developer.mozilla.org/en-US/docs/Web/API/AbortController) to signal cancellation on SIGINT, and pass its `signal` to `pRetry`:

```js
import pRetry from 'p-retry';

const controller = new AbortController();

process.once('SIGINT', () => {
	controller.abort(new Error('SIGINT received'));
});

try {
	await pRetry(run, {signal: controller.signal});
} catch (error) {
	console.log('Retry stopped due to:', error.message);
}
```

The package does not handle process signals itself to avoid global side effects.

## Related

- [p-timeout](https://github.com/sindresorhus/p-timeout) - Timeout a promise after a specified amount of time
- [More…](https://github.com/sindresorhus/promise-fun)
