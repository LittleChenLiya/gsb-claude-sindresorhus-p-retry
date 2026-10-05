import isNetworkError from 'is-network-error';

function validateRetries(retries) {
	if (typeof retries === 'number') {
		if (retries < 0) {
			throw new TypeError('Expected `retries` to be a non-negative number.');
		}

		if (Number.isNaN(retries)) {
			throw new TypeError('Expected `retries` to be a valid number or Infinity, got NaN.');
		}

		if (Number.isFinite(retries) && !Number.isInteger(retries)) {
			throw new TypeError('Expected `retries` to be a non-negative integer or Infinity.');
		}
	} else if (retries !== undefined) {
		throw new TypeError('Expected `retries` to be a number or Infinity.');
	}
}

function validateNumberOption(name, value, {min = 0, allowInfinity = false} = {}) {
	if (value === undefined) {
		return;
	}

	if (typeof value !== 'number' || Number.isNaN(value)) {
		throw new TypeError(`Expected \`${name}\` to be a number${allowInfinity ? ' or Infinity' : ''}.`);
	}

	if (!allowInfinity && !Number.isFinite(value)) {
		throw new TypeError(`Expected \`${name}\` to be a finite number.`);
	}

	if (value < min) {
		throw new TypeError(`Expected \`${name}\` to be \u2265 ${min}.`);
	}
}

function validateBooleanOption(name, value) {
	if (value === undefined) {
		return;
	}

	if (typeof value !== 'boolean') {
		throw new TypeError(`Expected \`${name}\` to be a boolean.`);
	}
}

function validateFunctionOption(name, value) {
	if (value === undefined) {
		return;
	}

	if (typeof value !== 'function') {
		throw new TypeError(`Expected \`${name}\` to be a function.`);
	}
}

export class AbortError extends Error {
	constructor(message) {
		super();

		if (message instanceof Error) {
			this.originalError = message;
			({message} = message);
		} else {
			this.originalError = new Error(message);
			this.originalError.stack = this.stack;
		}

		this.name = 'AbortError';
		this.message = message;
	}
}

function calculateDelay(retriesConsumed, options) {
	const attempt = Math.max(1, retriesConsumed + 1);
	const random = options.randomize ? (Math.random() + 1) : 1;

	let timeout = Math.round(random * options.minTimeout * (options.factor ** (attempt - 1)));
	timeout = Math.min(timeout, options.maxTimeout);

	return timeout;
}

function calculateRemainingTime(start, max) {
	if (!Number.isFinite(max)) {
		return max;
	}

	return max - (performance.now() - start);
}

async function delayForRetry(delay, options) {
	if (delay <= 0) {
		return;
	}

	await new Promise((resolve, reject) => {
		const onAbort = () => {
			clearTimeout(timeoutToken);
			options.signal?.removeEventListener('abort', onAbort);
			reject(options.signal.reason);
		};

		const timeoutToken = setTimeout(() => {
			options.signal?.removeEventListener('abort', onAbort);
			resolve();
		}, delay);

		if (options.unref) {
			timeoutToken.unref?.();
		}

		options.signal?.addEventListener('abort', onAbort, {once: true});
	});
}

// Race a control callback against the abort signal.
//
// When `abortableCallbacks` is enabled and a signal is provided, aborting the
// signal while waiting for a callback terminates the wait: the returned promise
// rejects with the abort reason. The callback's eventual settlement is then
// ignored — it cannot start a new attempt or change the retry count — and a
// late rejection is swallowed so it never becomes an unhandled rejection.
//
// When the mode is disabled (the default), the callback wait is unaffected by
// the signal and runs to completion as before.
async function raceCallbackWithSignal(callbackPromise, options) {
	if (!options.abortableCallbacks || !options.signal) {
		return callbackPromise;
	}

	if (options.signal.aborted) {
		throw options.signal.reason;
	}

	let onAbort;
	const abortPromise = new Promise((_resolve, reject) => {
		onAbort = () => {
			reject(options.signal.reason);
		};
	});

	options.signal.addEventListener('abort', onAbort, {once: true});

	try {
		return await Promise.race([callbackPromise, abortPromise]);
	} finally {
		// The race attaches handlers to `callbackPromise`, so a late rejection is
		// still handled and never becomes an unhandled rejection.
		options.signal.removeEventListener('abort', onAbort);
	}
}

async function waitForCallback(callback, context, options) {
	return raceCallbackWithSignal(
		(async () => callback(context))(),
		options,
	);
}

async function onAttemptFailure({error, attemptNumber, retriesConsumed, startTime, options}) {
	const normalizedError = error instanceof Error
		? error
		: new TypeError(`Non-error was thrown: "${error}". You should only throw errors.`);

	if (normalizedError instanceof AbortError) {
		throw normalizedError.originalError;
	}

	const retriesLeft = Number.isFinite(options.retries)
		? Math.max(0, options.retries - retriesConsumed)
		: options.retries;

	const maxRetryTime = options.maxRetryTime ?? Number.POSITIVE_INFINITY;
	const delayTime = calculateDelay(retriesConsumed, options);
	const remainingTimeBeforeCallbacks = calculateRemainingTime(startTime, maxRetryTime);

	if (remainingTimeBeforeCallbacks <= 0) {
		const context = Object.freeze({
			error: normalizedError,
			attemptNumber,
			retriesLeft,
			retriesConsumed,
			retryDelay: 0,
		});

		await waitForCallback(options.onFailedAttempt, context, options);

		throw normalizedError;
	}

	const consumeRetryContext = Object.freeze({
		error: normalizedError,
		attemptNumber,
		retriesLeft,
		retriesConsumed,
		retryDelay: retriesLeft > 0 ? delayTime : 0,
	});

	const consumeRetry = await waitForCallback(options.shouldConsumeRetry, consumeRetryContext, options);
	const effectiveDelay = consumeRetry && retriesLeft > 0 ? delayTime : 0;
	const context = Object.freeze({
		error: normalizedError,
		attemptNumber,
		retriesLeft,
		retriesConsumed,
		retryDelay: effectiveDelay,
	});

	await waitForCallback(options.onFailedAttempt, context, options);

	if (calculateRemainingTime(startTime, maxRetryTime) <= 0) {
		throw normalizedError;
	}

	const remainingTime = calculateRemainingTime(startTime, maxRetryTime);

	if (remainingTime <= 0 || retriesLeft <= 0) {
		throw normalizedError;
	}

	if (normalizedError instanceof TypeError && !isNetworkError(normalizedError)) {
		throw normalizedError;
	}

	if (!await waitForCallback(options.shouldRetry, context, options)) {
		throw normalizedError;
	}

	const remainingTimeAfterShouldRetry = calculateRemainingTime(startTime, maxRetryTime);

	if (remainingTimeAfterShouldRetry <= 0) {
		throw normalizedError;
	}

	if (!consumeRetry) {
		options.signal?.throwIfAborted();
		return false;
	}

	const finalDelay = Math.min(effectiveDelay, remainingTimeAfterShouldRetry);

	options.signal?.throwIfAborted();

	await delayForRetry(finalDelay, options);

	options.signal?.throwIfAborted();

	return true;
}

export default async function pRetry(input, options = {}) {
	options = {...options};

	validateRetries(options.retries);

	if (Object.hasOwn(options, 'forever')) {
		throw new Error('The `forever` option is no longer supported. For many use-cases, you can set `retries: Infinity` instead.');
	}

	options.retries ??= 10;
	options.factor ??= 2;
	options.minTimeout ??= 1000;
	options.maxTimeout ??= Number.POSITIVE_INFINITY;
	options.maxRetryTime ??= Number.POSITIVE_INFINITY;
	options.randomize ??= false;
	options.onFailedAttempt ??= () => {};
	options.shouldRetry ??= () => true;
	options.shouldConsumeRetry ??= () => true;

	// Validate numeric options and normalize edge cases
	validateFunctionOption('onFailedAttempt', options.onFailedAttempt);
	validateFunctionOption('shouldRetry', options.shouldRetry);
	validateFunctionOption('shouldConsumeRetry', options.shouldConsumeRetry);
	validateNumberOption('factor', options.factor, {min: 0, allowInfinity: false});
	validateNumberOption('minTimeout', options.minTimeout, {min: 0, allowInfinity: false});
	validateNumberOption('maxTimeout', options.maxTimeout, {min: 0, allowInfinity: true});
	validateNumberOption('maxRetryTime', options.maxRetryTime, {min: 0, allowInfinity: true});
	validateBooleanOption('abortableCallbacks', options.abortableCallbacks);

	// Treat non-positive factor as 1 to avoid zero backoff or negative behavior
	if (!(options.factor > 0)) {
		options.factor = 1;
	}

	options.signal?.throwIfAborted();

	let attemptNumber = 0;
	let retriesConsumed = 0;
	const startTime = performance.now();

	while (Number.isFinite(options.retries) ? retriesConsumed <= options.retries : true) {
		attemptNumber++;

		try {
			options.signal?.throwIfAborted();

			const result = await input(attemptNumber);

			options.signal?.throwIfAborted();

			return result;
		} catch (error) {
			if (await onAttemptFailure({
				error,
				attemptNumber,
				retriesConsumed,
				startTime,
				options,
			})) {
				retriesConsumed++;
			}
		}
	}

	// Should not reach here, but in case it does, throw an error
	throw new Error('Retry attempts exhausted without throwing an error.');
}

export function makeRetriable(function_, options) {
	return function (...arguments_) {
		return pRetry(() => function_.apply(this, arguments_), options);
	};
}
