import process from 'node:process';
import test from 'ava';
import pRetry from './index.js';

const fixture = Symbol('fixture');

// Flush pending microtasks so deferred callbacks can be settled deterministically
// without relying on real long waits.
const flushMicrotasks = async (times = 20) => {
	for (let index = 0; index < times; index++) {
		await Promise.resolve();
	}
};

test('cancelCallbacksOnAbort rejects promptly when shouldRetry is stuck', async t => {
	const controller = new AbortController();
	const abortReason = new Error('cancelled');
	let attempts = 0;
	let resolveShouldRetry;
	const shouldRetryGate = new Promise(resolve => {
		resolveShouldRetry = resolve;
	});

	const promise = pRetry(async () => {
		attempts++;
		throw new Error('fail');
	}, {
		signal: controller.signal,
		cancelCallbacksOnAbort: true,
		retries: 5,
		minTimeout: 0,
		shouldRetry: () => shouldRetryGate,
	});

	// Let the first attempt fail and `shouldRetry` start pending.
	await flushMicrotasks();
	t.is(attempts, 1);

	controller.abort(abortReason);

	const error = await t.throwsAsync(promise);
	t.is(error, abortReason);

	// A late `true` can only be cleanup: no new attempt is started.
	resolveShouldRetry(true);
	await flushMicrotasks();
	t.is(attempts, 1);
});

test('cancelCallbacksOnAbort absorbs late callback rejection', async t => {
	const controller = new AbortController();
	let rejectShouldRetry;
	const shouldRetryGate = new Promise((resolve, reject) => {
		rejectShouldRetry = reject;
	});

	const unhandled = [];
	const onUnhandled = reason => {
		unhandled.push(reason);
	};

	process.on('unhandledRejection', onUnhandled);
	t.teardown(() => {
		process.off('unhandledRejection', onUnhandled);
	});

	const promise = pRetry(async () => {
		throw new Error('fail');
	}, {
		signal: controller.signal,
		cancelCallbacksOnAbort: true,
		retries: 5,
		minTimeout: 0,
		shouldRetry: () => shouldRetryGate,
	});

	await flushMicrotasks();
	controller.abort(new Error('cancelled'));
	await t.throwsAsync(promise);

	// The stuck callback rejects after the abort already settled the outer promise.
	rejectShouldRetry(new Error('late shouldRetry rejection'));

	// Give Node a macrotask turn to report any unhandled rejection.
	await new Promise(resolve => {
		setImmediate(resolve);
	});
	await flushMicrotasks();

	t.deepEqual(unhandled, []);
});

test('cancelCallbacksOnAbort keeps retry counts frozen at the abort snapshot', async t => {
	const controller = new AbortController();
	const contexts = [];
	let attempts = 0;
	let resolveShouldRetry;
	const shouldRetryGate = new Promise(resolve => {
		resolveShouldRetry = resolve;
	});

	const promise = pRetry(async () => {
		attempts++;
		throw new Error('fail');
	}, {
		signal: controller.signal,
		cancelCallbacksOnAbort: true,
		retries: 5,
		minTimeout: 0,
		onFailedAttempt(context) {
			contexts.push(context);
		},
		shouldRetry: () => shouldRetryGate,
	});

	await flushMicrotasks();
	controller.abort(new Error('cancelled'));
	await t.throwsAsync(promise);

	t.is(contexts.length, 1);
	t.is(contexts[0].attemptNumber, 1);
	t.is(contexts[0].retriesConsumed, 0);
	t.is(contexts[0].retriesLeft, 5);

	// Late settlement must not move the counts or fire more callbacks.
	resolveShouldRetry(true);
	await flushMicrotasks();

	t.is(attempts, 1);
	t.is(contexts.length, 1);
});

test('cancelCallbacksOnAbort cancels a stuck onFailedAttempt wait', async t => {
	const controller = new AbortController();
	const abortReason = new Error('cancelled');
	let attempts = 0;

	const promise = pRetry(async () => {
		attempts++;
		throw new Error('fail');
	}, {
		signal: controller.signal,
		cancelCallbacksOnAbort: true,
		retries: 5,
		minTimeout: 0,
		onFailedAttempt: () => new Promise(() => {}), // Never settles
	});

	await flushMicrotasks();
	controller.abort(abortReason);

	const error = await t.throwsAsync(promise);
	t.is(error, abortReason);
	t.is(attempts, 1);
});

test('cancelCallbacksOnAbort cancels a stuck shouldConsumeRetry wait', async t => {
	const controller = new AbortController();
	const abortReason = new Error('cancelled');
	let attempts = 0;
	let resolveShouldConsumeRetry;
	const shouldConsumeRetryGate = new Promise(resolve => {
		resolveShouldConsumeRetry = resolve;
	});

	const promise = pRetry(async () => {
		attempts++;
		throw new Error('fail');
	}, {
		signal: controller.signal,
		cancelCallbacksOnAbort: true,
		retries: 5,
		minTimeout: 0,
		shouldConsumeRetry: () => shouldConsumeRetryGate,
	});

	await flushMicrotasks();
	controller.abort(abortReason);

	const error = await t.throwsAsync(promise);
	t.is(error, abortReason);

	// A late `true` must not consume a retry or start a new attempt.
	resolveShouldConsumeRetry(true);
	await flushMicrotasks();
	t.is(attempts, 1);
});

test('callback errors preserve their cause chain', async t => {
	const rootCause = new Error('root cause');
	const callbackError = new Error('shouldRetry failed', {cause: rootCause});

	const error = await t.throwsAsync(pRetry(async () => {
		throw new Error('fail');
	}, {
		signal: new AbortController().signal,
		cancelCallbacksOnAbort: true,
		retries: 5,
		minTimeout: 0,
		shouldRetry() {
			throw callbackError;
		},
	}));

	t.is(error, callbackError);
	t.is(error.cause, rootCause);
});

test('default callback waiting is not interrupted by abort', async t => {
	const controller = new AbortController();
	let resolveShouldRetry;
	const shouldRetryGate = new Promise(resolve => {
		resolveShouldRetry = resolve;
	});
	const promise = pRetry(async () => {
		throw new Error('fail');
	}, {
		signal: controller.signal,
		retries: 5,
		minTimeout: 0,
		shouldRetry: () => shouldRetryGate,
	});

	let settled = false;
	const trackSettlement = async () => {
		try {
			await promise;
		} catch {
			// The rejection is asserted below.
		}

		settled = true;
	};

	trackSettlement();

	await flushMicrotasks();
	controller.abort(new Error('cancelled'));
	await flushMicrotasks();

	// Default mode: the abort does not cut the callback wait short.
	t.false(settled);

	// Once the callback settles, the pending abort takes effect.
	resolveShouldRetry(true);
	const error = await t.throwsAsync(promise);
	t.is(error.message, 'cancelled');
});

test('cancelCallbacksOnAbort does not change normal retry flow', async t => {
	let attempts = 0;

	const result = await pRetry(async () => {
		attempts++;
		if (attempts < 3) {
			throw new Error('fail');
		}

		return fixture;
	}, {
		signal: new AbortController().signal,
		cancelCallbacksOnAbort: true,
		retries: 5,
		minTimeout: 0,
	});

	t.is(result, fixture);
	t.is(attempts, 3);
});

test('throws on invalid cancelCallbacksOnAbort option', async t => {
	await t.throwsAsync(pRetry(async () => {}, {
		cancelCallbacksOnAbort: 'yes',
	}), {
		instanceOf: TypeError,
		message: 'Expected `cancelCallbacksOnAbort` to be a boolean.',
	});
});
