import test from 'node:test';
import assert from 'node:assert/strict';
import pRetryCommitted, {UnknownResultError} from './committed.js';

test('retries a pre-commit failure under the normal p-retry rules', async () => {
	let calls = 0;

	const result = await pRetryCommitted(async attempt => {
		calls++;
		assert.equal(attempt.attemptNumber, calls);

		if (calls === 1) {
			throw new Error('boom before commit');
		}

		attempt.commit();
		return 'ok';
	}, {
		minTimeout: 0,
		retries: 2,
	});

	assert.equal(result, 'ok');
	assert.equal(calls, 2);
});

test('a post-commit failure rejects with an unknown-result error and one call', async () => {
	let calls = 0;
	let permissionAsked = 0;
	const failure = new Error('connection lost after send');

	await assert.rejects(
		pRetryCommitted(async attempt => {
			calls++;
			attempt.commit();
			throw failure;
		}, {
			minTimeout: 0,
			onCommittedFailure({error, attemptNumber}) {
				permissionAsked++;
				assert.equal(attemptNumber, 1);
				assert.equal(error, failure);
				return false;
			},
		}),
		error => error instanceof UnknownResultError
			&& error.unknownResult === true
			&& error.originalError === failure,
	);

	assert.equal(calls, 1);
	assert.equal(permissionAsked, 1);
});

test('a post-commit failure is retried only after explicit replay permission', async () => {
	let calls = 0;
	const failure = new Error('connection lost after send');

	const result = await pRetryCommitted(async attempt => {
		calls++;

		if (calls === 1) {
			attempt.commit();
			throw failure;
		}

		return 'recovered';
	}, {
		minTimeout: 0,
		retries: 2,
		onCommittedFailure: async () => true,
	});

	assert.equal(result, 'recovered');
	assert.equal(calls, 2);
});

test('replay permission defaults to off when the callback is omitted', async () => {
	let calls = 0;

	await assert.rejects(
		pRetryCommitted(async attempt => {
			calls++;
			attempt.commit();
			throw new Error('post-commit');
		}, {minTimeout: 0}),
		UnknownResultError,
	);

	assert.equal(calls, 1);
});

test('an aborted signal overrides replay permission', async () => {
	const controller = new AbortController();
	let calls = 0;
	let permissionAsked = 0;

	const promise = pRetryCommitted(async attempt => {
		calls++;
		attempt.commit();
		controller.abort(new Error('cancelled by user'));
		throw new Error('post-commit failure');
	}, {
		signal: controller.signal,
		minTimeout: 0,
		async onCommittedFailure() {
			permissionAsked++;
			return true; // Permission says replay, but the abort must win.
		},
	});

	await assert.rejects(promise, /cancelled by user/);
	assert.equal(calls, 1);
	assert.equal(permissionAsked, 0);
});

test('an abort during the async permission check overrides a granted permission', async () => {
	const controller = new AbortController();
	let calls = 0;

	const promise = pRetryCommitted(async attempt => {
		calls++;
		attempt.commit();
		throw new Error('post-commit failure');
	}, {
		signal: controller.signal,
		minTimeout: 0,
		async onCommittedFailure() {
			controller.abort(new Error('aborted while waiting for permission'));
			await Promise.resolve();
			return true;
		},
	});

	await assert.rejects(promise, /aborted while waiting for permission/);
	assert.equal(calls, 1);
});

test('an async permission rejection aborts without retrying', async () => {
	let calls = 0;
	const permissionError = new Error('permission service unavailable');

	await assert.rejects(
		pRetryCommitted(async attempt => {
			calls++;
			attempt.commit();
			throw new Error('post-commit failure');
		}, {
			minTimeout: 0,
			async onCommittedFailure() {
				throw permissionError;
			},
		}),
		permissionError,
	);

	assert.equal(calls, 1);
});

test('commit state is isolated per attempt', async () => {
	let calls = 0;
	let permissionCalls = 0;

	const result = await pRetryCommitted(async attempt => {
		calls++;

		if (calls === 1) {
			attempt.commit();
			throw new Error('committed failure');
		}

		if (calls === 2) {
			// This attempt never committed; it must be retried under normal rules.
			throw new Error('pre-commit failure');
		}

		return 'done';
	}, {
		minTimeout: 0,
		retries: 3,
		async onCommittedFailure() {
			permissionCalls++;
			return true;
		},
	});

	assert.equal(result, 'done');
	assert.equal(calls, 3);
	assert.equal(permissionCalls, 1);
});

test('pre-commit failures still respect p-retry retry rules', async () => {
	let calls = 0;

	await assert.rejects(
		pRetryCommitted(async () => {
			calls++;
			throw new TypeError('non-network type error');
		}, {minTimeout: 0}),
		{name: 'TypeError'},
	);

	assert.equal(calls, 1);
});

test('onFailedAttempt still receives the p-retry context for unknown-result failures', async () => {
	let failedAttempts = 0;

	await assert.rejects(
		pRetryCommitted(async attempt => {
			attempt.commit();
			throw new Error('post-commit');
		}, {
			minTimeout: 0,
			onFailedAttempt(context) {
				failedAttempts++;
				assert.equal(context.attemptNumber, 1);
				assert.equal(context.retryDelay, 0);
			},
		}),
		UnknownResultError,
	);

	assert.equal(failedAttempts, 1);
});

test('a successful committed operation returns its value', async () => {
	const result = await pRetryCommitted(async attempt => {
		attempt.commit();
		return 'ok';
	}, {});

	assert.equal(result, 'ok');
});
