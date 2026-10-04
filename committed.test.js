import test from 'node:test';
import assert from 'node:assert/strict';
import pRetryCommitted, {
	UnknownResultError,
	isUnknownResultError,
} from './committed.js';

const fastOptions = {retries: 5, minTimeout: 1, factor: 1};

const capture = async promise => {
	try {
		await promise;
	} catch (error) {
		return error;
	}

	throw new Error('Expected the promise to reject.');
};

test('fails once before committing, then succeeds: 2 calls, normal retry conditions', async () => {
	let calls = 0;

	const result = await pRetryCommitted(async attempt => {
		calls++;
		assert.equal(attempt.committed, false);

		if (calls === 1) {
			// Fails before markCommitted(): safe to retry.
			throw new Error('connection reset before send');
		}

		attempt.markCommitted();
		return 'ok';
	}, fastOptions);

	assert.equal(result, 'ok');
	assert.equal(calls, 2);
});

test('fails after committing without replay permission: 1 call, unknown-result error', async () => {
	let calls = 0;
	const original = new Error('response stream died');

	const error = await capture(pRetryCommitted(async attempt => {
		calls++;
		attempt.markCommitted();
		throw original;
	}, fastOptions));

	assert.ok(error instanceof UnknownResultError);
	assert.equal(error.unknownResult, true);
	assert.equal(isUnknownResultError(error), true);
	assert.equal(error.cause, original);
	assert.equal(error.attemptNumber, 1);
	assert.equal(calls, 1); // Never retried automatically.
});

test('committed failure is retried only with explicit replay permission', async () => {
	let calls = 0;

	const result = await pRetryCommitted(async attempt => {
		calls++;
		attempt.markCommitted();

		if (calls === 1) {
			throw new Error('timeout after send');
		}

		return 'replayed-ok';
	}, {
		...fastOptions,
		shouldReplay: () => true,
	});

	assert.equal(result, 'replayed-ok');
	assert.equal(calls, 2); // Second call happens only after explicit permission.
});

test('async replay permission denial: 1 call, unknown-result error', async () => {
	let calls = 0;
	let permissionChecks = 0;

	const error = await capture(pRetryCommitted(async attempt => {
		calls++;
		attempt.markCommitted();
		throw new Error('unknown outcome');
	}, {
		...fastOptions,
		shouldReplay: async () => {
			permissionChecks++;
			await new Promise(resolve => {
				setTimeout(resolve, 10);
			});

			return false;
		},
	}));

	assert.ok(error instanceof UnknownResultError);
	assert.equal(error.unknownResult, true);
	assert.equal(permissionChecks, 1);
	assert.equal(calls, 1);
});

test('abort wins over replay permission: cancellation is never overridden', async () => {
	let calls = 0;
	const controller = new AbortController();
	const reason = new Error('cancelled by user');

	const error = await capture(pRetryCommitted(async attempt => {
		calls++;
		attempt.markCommitted();
		controller.abort(reason);
		throw new Error('timeout after send');
	}, {
		...fastOptions,
		signal: controller.signal,
		shouldReplay: () => true, // Permission granted, but abort must still win.
	}));

	assert.equal(error, reason);
	assert.equal(calls, 1);
});

test('abort during a pending async replay permission still wins', async () => {
	let calls = 0;
	const controller = new AbortController();
	const reason = new Error('cancelled while deciding');

	const error = await capture(pRetryCommitted(async attempt => {
		calls++;
		attempt.markCommitted();
		throw new Error('timeout after send');
	}, {
		...fastOptions,
		signal: controller.signal,
		shouldReplay: async () => {
			await new Promise(resolve => {
				setTimeout(resolve, 20);
			});

			controller.abort(reason);
			return true;
		},
	}));

	assert.equal(error, reason);
	assert.equal(calls, 1);
});

test('commit state is isolated per attempt and never leaks', async () => {
	let calls = 0;
	const committedAtStart = [];

	const result = await pRetryCommitted(async attempt => {
		calls++;
		// Every attempt must start uncommitted, even if a previous attempt committed.
		committedAtStart.push(attempt.committed);
		attempt.markCommitted();

		if (calls === 1) {
			throw new Error('unknown outcome on first attempt');
		}

		return 'ok';
	}, {
		...fastOptions,
		shouldReplay: () => true,
	});

	assert.equal(result, 'ok');
	assert.equal(calls, 2);
	assert.deepEqual(committedAtStart, [false, false]);
});

test('pre-commit failures keep p-retry semantics: non-network TypeError aborts', async () => {
	let calls = 0;

	const error = await capture(pRetryCommitted(async () => {
		calls++;
		throw new TypeError('bug before commit');
	}, fastOptions));

	assert.ok(error instanceof TypeError);
	assert.equal(calls, 1);
});

test('invalid shouldReplay option is rejected', async () => {
	const error = await capture(pRetryCommitted(async () => 'x', {shouldReplay: 'yes'}));
	assert.ok(error instanceof TypeError);
});
