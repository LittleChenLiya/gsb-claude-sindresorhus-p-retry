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

		await options.onFailedAttempt(context);

		throw normalizedError;
	}

	const consumeRetryContext = Object.freeze({
		error: normalizedError,
		attemptNumber,
		retriesLeft,
		retriesConsumed,
		retryDelay: retriesLeft > 0 ? delayTime : 0,
	});

	const consumeRetry = await options.shouldConsumeRetry(consumeRetryContext);
	const effectiveDelay = consumeRetry && retriesLeft > 0 ? delayTime : 0;
	const context = Object.freeze({
		error: normalizedError,
		attemptNumber,
		retriesLeft,
		retriesConsumed,
		retryDelay: effectiveDelay,
	});

	await options.onFailedAttempt(context);

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

	if (!await options.shouldRetry(context)) {
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

function createSemaphore(concurrency) {
	let activeCount = 0;
	const waitQueue = [];

	return {
		acquire(signal) {
			if (signal?.aborted) {
				return Promise.reject(signal.reason);
			}

			if (activeCount < concurrency) {
				activeCount++;
				return Promise.resolve();
			}

			return new Promise((resolve, reject) => {
				const waiter = {resolve, reject};
				waitQueue.push(waiter);

				signal?.addEventListener('abort', () => {
					const index = waitQueue.indexOf(waiter);
					if (index !== -1) {
						waitQueue.splice(index, 1);
						reject(signal.reason);
					}
				}, {once: true});
			});
		},

		release() {
			activeCount--;

			while (waitQueue.length > 0 && activeCount < concurrency) {
				const waiter = waitQueue.shift();
				activeCount++;
				waiter.resolve();
			}
		},
	};
}

async function runItemRetry({input, options, semaphore}) {
	let attemptNumber = 0;
	let retriesConsumed = 0;
	const startTime = performance.now();

	while (Number.isFinite(options.retries) ? retriesConsumed <= options.retries : true) {
		options.signal?.throwIfAborted();
		await semaphore.acquire(options.signal);
		attemptNumber++;

		let result;
		try {
			options.signal?.throwIfAborted();
			result = await input(attemptNumber);
			options.signal?.throwIfAborted();
		} catch (error) {
			// Release the permit before running any failure handling so that
			// backoff and failure callbacks never occupy a slot.
			semaphore.release();

			if (await onAttemptFailure({
				error,
				attemptNumber,
				retriesConsumed,
				startTime,
				options,
			})) {
				retriesConsumed++;
			}

			continue;
		}

		// Release the permit before returning so the slot is freed immediately.
		semaphore.release();
		return result;
	}

	throw new Error('Retry attempts exhausted without throwing an error.');
}

function validateBatchInputs(inputs) {
	if (!Array.isArray(inputs)) {
		throw new TypeError('Expected `inputs` to be an array of functions.');
	}

	for (const [index, input] of inputs.entries()) {
		if (typeof input !== 'function') {
			throw new TypeError(`Expected item at index ${index} to be a function, got ${typeof input}.`);
		}
	}
}

function validateConcurrency(concurrency) {
	if (concurrency === undefined) {
		return;
	}

	if (typeof concurrency !== 'number' || Number.isNaN(concurrency)) {
		throw new TypeError('Expected `concurrency` to be a number or Infinity.');
	}

	if (concurrency < 1) {
		throw new TypeError('Expected `concurrency` to be ≥ 1.');
	}

	if (Number.isFinite(concurrency) && !Number.isInteger(concurrency)) {
		throw new TypeError('Expected `concurrency` to be an integer or Infinity.');
	}
}

function normalizeBatchOptions(options) {
	options = {...options};

	validateRetries(options.retries);

	if (Object.hasOwn(options, 'forever')) {
		throw new Error('The `forever` option is no longer supported. For many use-cases, you can set `retries: Infinity` instead.');
	}

	validateConcurrency(options.concurrency);

	options.concurrency ??= Number.POSITIVE_INFINITY;
	options.retries ??= 10;
	options.factor ??= 2;
	options.minTimeout ??= 1000;
	options.maxTimeout ??= Number.POSITIVE_INFINITY;
	options.maxRetryTime ??= Number.POSITIVE_INFINITY;
	options.randomize ??= false;
	options.onFailedAttempt ??= () => {};
	options.shouldRetry ??= () => true;
	options.shouldConsumeRetry ??= () => true;

	validateFunctionOption('onFailedAttempt', options.onFailedAttempt);
	validateFunctionOption('shouldRetry', options.shouldRetry);
	validateFunctionOption('shouldConsumeRetry', options.shouldConsumeRetry);
	validateNumberOption('factor', options.factor, {min: 0, allowInfinity: false});
	validateNumberOption('minTimeout', options.minTimeout, {min: 0, allowInfinity: false});
	validateNumberOption('maxTimeout', options.maxTimeout, {min: 0, allowInfinity: true});
	validateNumberOption('maxRetryTime', options.maxRetryTime, {min: 0, allowInfinity: true});

	if (!(options.factor > 0)) {
		options.factor = 1;
	}

	return options;
}

function createBatchPromise(itemPromises, results, signal) {
	const batchPromise = new Promise((resolve, reject) => {
		let settled = false;

		const onAbort = () => {
			if (settled) {
				return;
			}

			settled = true;
			reject(signal.reason);
		};

		signal?.addEventListener('abort', onAbort, {once: true});

		(async () => {
			try {
				await Promise.all(itemPromises);
			} catch (error) {
				if (settled) {
					return;
				}

				settled = true;
				signal?.removeEventListener('abort', onAbort);
				reject(error);
				return;
			}

			if (settled) {
				return;
			}

			settled = true;
			signal?.removeEventListener('abort', onAbort);
			resolve(results);
		})();
	});

	batchPromise.drain = async () => {
		await Promise.allSettled(itemPromises);
	};

	return batchPromise;
}

export function pRetryBatch(inputs, options = {}) {
	validateBatchInputs(inputs);
	options = normalizeBatchOptions(options);

	options.signal?.throwIfAborted();

	const semaphore = createSemaphore(options.concurrency);
	const results = Array.from({length: inputs.length});

	const itemPromises = inputs.map(async (input, index) => {
		results[index] = await runItemRetry({
			input,
			options,
			semaphore,
		});
	});

	return createBatchPromise(itemPromises, results, options.signal);
}
