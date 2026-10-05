import test from 'ava';
import pRetry from '../index.js';

const fixtureError = new Error('fixture');

// Poll until `predicate` is true, without relying on real long waits.
const waitFor = async predicate => {
	while (!predicate()) {
		await new Promise(resolve => {
			setImmediate(resolve);
		});
	}
};

test('abort during stuck shouldRetry terminates the wait promptly', async t => {
	const controller = new AbortController();
	let inputCalls = 0;
	let shouldRetryCalls = 0;
	let resolveShouldRetry;

	const promise = pRetry(async () => {
		inputCalls++;
		throw new Error('fail');
	}, {
		signal: controller.signal,
		abortableCallbacks: true,
		retries: 5,
		minTimeout: 0,
		shouldRetry() {
			shouldRetryCalls++;
			return new Promise(resolve => {
				resolveShouldRetry = resolve;
			});
		},
	});

	await waitFor(() => shouldRetryCalls === 1);

	controller.abort(fixtureError);

	const error = await t.throwsAsync(promise, {is: fixtureError});
	t.is(error, fixtureError);
	t.is(inputCalls, 1);
	t.is(shouldRetryCalls, 1);

	// The late resolution is only cleanup: no new attempt, no extra callback.
	resolveShouldRetry(true);
	await new Promise(resolve => {
		setImmediate(resolve);
	});

	t.is(inputCalls, 1);
	t.is(shouldRetryCalls, 1);
});

test('abort during stuck shouldConsumeRetry terminates the wait promptly', async t => {
	const controller = new AbortController();
	let inputCalls = 0;
	let shouldConsumeRetryCalls = 0;
	let onFailedAttemptCalls = 0;
	let shouldRetryCalls = 0;
	let resolveShouldConsumeRetry;

	const promise = pRetry(async () => {
		inputCalls++;
		throw new Error('fail');
	}, {
		signal: controller.signal,
		abortableCallbacks: true,
		retries: 5,
		minTimeout: 0,
		shouldConsumeRetry() {
			shouldConsumeRetryCalls++;
			return new Promise(resolve => {
				resolveShouldConsumeRetry = resolve;
			});
		},
		onFailedAttempt() {
			onFailedAttemptCalls++;
		},
		shouldRetry() {
			shouldRetryCalls++;
			return true;
		},
	});

	await waitFor(() => shouldConsumeRetryCalls === 1);

	controller.abort(fixtureError);

	await t.throwsAsync(promise, {is: fixtureError});
	t.is(inputCalls, 1);
	t.is(shouldConsumeRetryCalls, 1);
	t.is(onFailedAttemptCalls, 0);
	t.is(shouldRetryCalls, 0);

	// Late resolution cannot start a new attempt or call downstream callbacks.
	resolveShouldConsumeRetry(true);
	await new Promise(resolve => {
		setImmediate(resolve);
	});

	t.is(inputCalls, 1);
	t.is(shouldConsumeRetryCalls, 1);
	t.is(onFailedAttemptCalls, 0);
	t.is(shouldRetryCalls, 0);
});

test('abort during stuck onFailedAttempt terminates the wait promptly', async t => {
	const controller = new AbortController();
	let inputCalls = 0;
	let onFailedAttemptCalls = 0;
	let shouldRetryCalls = 0;
	let resolveOnFailedAttempt;

	const promise = pRetry(async () => {
		inputCalls++;
		throw new Error('fail');
	}, {
		signal: controller.signal,
		abortableCallbacks: true,
		retries: 5,
		minTimeout: 0,
		onFailedAttempt() {
			onFailedAttemptCalls++;
			return new Promise(resolve => {
				resolveOnFailedAttempt = resolve;
			});
		},
		shouldRetry() {
			shouldRetryCalls++;
			return true;
		},
	});

	await waitFor(() => onFailedAttemptCalls === 1);

	controller.abort(fixtureError);

	await t.throwsAsync(promise, {is: fixtureError});
	t.is(inputCalls, 1);
	t.is(onFailedAttemptCalls, 1);
	t.is(shouldRetryCalls, 0);

	resolveOnFailedAttempt();
	await new Promise(resolve => {
		setImmediate(resolve);
	});

	t.is(inputCalls, 1);
	t.is(onFailedAttemptCalls, 1);
	t.is(shouldRetryCalls, 0);
});

test('late callback rejection after abort does not become an unhandled rejection', async t => {
	const controller = new AbortController();
	let rejectShouldRetry;

	const promise = pRetry(async () => {
		throw new Error('fail');
	}, {
		signal: controller.signal,
		abortableCallbacks: true,
		shouldRetry() {
			return new Promise((resolve, reject) => {
				rejectShouldRetry = reject;
			});
		},
	});

	await waitFor(() => typeof rejectShouldRetry === 'function');

	controller.abort(fixtureError);

	await t.throwsAsync(promise, {is: fixtureError});

	// Rejecting after the abort must not surface as an unhandled rejection.
	rejectShouldRetry(new Error('late rejection'));
	await new Promise(resolve => {
		setImmediate(resolve);
	});

	t.pass();
});

test('default behavior is unchanged: abort does not terminate callback wait', async t => {
	const controller = new AbortController();
	let inputCalls = 0;
	let shouldRetryCalls = 0;
	let resolveShouldRetry;

	const promise = pRetry(async () => {
		inputCalls++;
		throw new Error('fail');
	}, {
		signal: controller.signal,
		retries: 2,
		minTimeout: 0,
		shouldRetry() {
			shouldRetryCalls++;
			return new Promise(resolve => {
				resolveShouldRetry = resolve;
			});
		},
	});

	await waitFor(() => shouldRetryCalls === 1);

	controller.abort(fixtureError);

	// Without `abortableCallbacks`, the callback wait is not terminated by the
	// abort. The callback still decides: resolving false aborts with the
	// original error rather than the abort reason.
	resolveShouldRetry(false);

	const error = await t.throwsAsync(promise, {message: 'fail'});
	t.is(error.message, 'fail');
	t.is(inputCalls, 1);
	t.is(shouldRetryCalls, 1);
});

test('abortableCallbacks without a signal has no effect', async t => {
	let inputCalls = 0;
	let shouldRetryCalls = 0;
	let resolveShouldRetry;

	const promise = pRetry(async () => {
		inputCalls++;
		throw new Error('fail');
	}, {
		abortableCallbacks: true,
		retries: 2,
		minTimeout: 0,
		shouldRetry() {
			shouldRetryCalls++;
			return new Promise(resolve => {
				resolveShouldRetry = resolve;
			});
		},
	});

	await waitFor(() => shouldRetryCalls === 1);

	resolveShouldRetry(false);

	await t.throwsAsync(promise, {message: 'fail'});
	t.is(inputCalls, 1);
	t.is(shouldRetryCalls, 1);
});

test('callback exception preserves its cause', async t => {
	const cause = new Error('cause');
	const callbackError = new Error('callback failed', {cause});

	const error = await t.throwsAsync(pRetry(async () => {
		throw new Error('input');
	}, {
		abortableCallbacks: true,
		shouldRetry() {
			throw callbackError;
		},
	}));

	t.is(error, callbackError);
	t.is(error.cause, cause);
});

test('throws on invalid abortableCallbacks option', async t => {
	await t.throwsAsync(pRetry(async () => {}, {
		abortableCallbacks: 'yes',
	}), {
		message: 'Expected `abortableCallbacks` to be a boolean.',
	});
});

test('retry count is snapshotted at termination', async t => {
	const controller = new AbortController();
	const contexts = [];
	let resolveShouldRetry;

	const promise = pRetry(async () => {
		throw new Error('fail');
	}, {
		signal: controller.signal,
		abortableCallbacks: true,
		retries: 5,
		minTimeout: 0,
		onFailedAttempt(context) {
			contexts.push(context);
		},
		shouldRetry() {
			return new Promise(resolve => {
				resolveShouldRetry = resolve;
			});
		},
	});

	await waitFor(() => typeof resolveShouldRetry === 'function');

	controller.abort(fixtureError);

	await t.throwsAsync(promise, {is: fixtureError});

	// The completed attempt record is not rolled back and no new attempts start.
	t.is(contexts.length, 1);
	t.is(contexts[0].attemptNumber, 1);
	t.is(contexts[0].retriesConsumed, 0);
	t.is(contexts[0].retriesLeft, 5);

	resolveShouldRetry(true);
	await new Promise(resolve => {
		setImmediate(resolve);
	});

	t.is(contexts.length, 1);
});
