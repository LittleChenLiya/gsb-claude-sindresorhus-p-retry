import test from 'ava';
import delay from 'delay';
import {pRetryBatch} from './index.js';

function deferred() {
	let doResolve;
	let doReject;
	const promise = new Promise((resolve, reject) => {
		doResolve = resolve;
		doReject = reject;
	});
	return {promise, resolve: doResolve, reject: doReject};
}

async function waitFor(condition, {timeout = 2000} = {}) {
	const start = Date.now();
	while (!condition()) {
		if (Date.now() - start > timeout) {
			throw new Error('waitFor timed out');
		}

		await delay(5);
	}
}

test('results are preserved in input order despite out-of-order completion', async t => {
	const aRelease = deferred();
	const inputs = [
		async () => {
			await aRelease.promise;
			return 'A';
		},
		async () => 'B',
		async () => 'C',
	];

	const batch = pRetryBatch(inputs, {concurrency: 3, retries: 0});
	aRelease.resolve();
	const results = await batch;
	t.deepEqual(results, ['A', 'B', 'C']);
});

test('concurrency 1 releases the slot during the failure callback', async t => {
	const events = [];
	const aFirstAttemptRelease = deferred();
	const aCallbackEntered = deferred();
	const aCallbackRelease = deferred();
	const bRan = deferred();
	const aRetryRelease = deferred();

	const a = async attemptNumber => {
		events.push(`a:${attemptNumber}:start`);
		if (attemptNumber === 1) {
			await aFirstAttemptRelease.promise;
			throw new Error('A failed');
		}

		await aRetryRelease.promise;
		return 'A';
	};

	const b = async () => {
		events.push('b:start');
		bRan.resolve();
		return 'B';
	};

	const batch = pRetryBatch([a, b], {
		concurrency: 1,
		retries: 2,
		minTimeout: 0,
		async onFailedAttempt(context) {
			if (context.attemptNumber === 1) {
				events.push('a:callback:enter');
				aCallbackEntered.resolve();
				await aCallbackRelease.promise;
				events.push('a:callback:exit');
			}
		},
	});

	// A holds the slot on its first attempt. Resolve it so A fails.
	aFirstAttemptRelease.resolve();
	await aCallbackEntered.promise; // A is now blocked in onFailedAttempt

	// The slot must be free; B acquires it and runs while A is blocked in the callback.
	await bRan.promise;
	t.true(events.includes('b:start'));
	// A is still blocked in the callback (we have not released it yet).
	t.false(events.includes('a:callback:exit'));

	// Release A's callback so A can retry.
	aCallbackRelease.resolve();
	aRetryRelease.resolve();

	const results = await batch;
	t.deepEqual(results, ['A', 'B']);
});

test('concurrency 1 releases the slot during backoff', async t => {
	const events = [];
	const aFirstFail = deferred();
	const bRan = deferred();

	const a = async attemptNumber => {
		events.push(`a:${attemptNumber}`);
		if (attemptNumber === 1) {
			await aFirstFail.promise;
			throw new Error('A failed');
		}

		return 'A';
	};

	const b = async () => {
		events.push('b');
		bRan.resolve();
		return 'B';
	};

	const batch = pRetryBatch([a, b], {
		concurrency: 1,
		retries: 2,
		minTimeout: 100,
		factor: 2,
		randomize: false,
	});

	aFirstFail.resolve();

	// A enters backoff (100ms). The slot must be free for B.
	await bRan.promise;
	t.true(events.includes('b'));

	const results = await batch;
	t.deepEqual(results, ['A', 'B']);
	t.true(events.indexOf('b') > events.indexOf('a:1'));
});

test('concurrency limits only function attempts', async t => {
	let active = 0;
	let maxActive = 0;
	const aRelease = deferred();

	const makeItem = (name, release) => async () => {
		active++;
		maxActive = Math.max(maxActive, active);
		await (release ? release.promise : delay(10));
		active--;
		return name;
	};

	const batch = pRetryBatch([
		makeItem('A', aRelease),
		makeItem('B'),
		makeItem('C'),
	], {concurrency: 2, retries: 0});

	await waitFor(() => maxActive === 2);
	t.is(maxActive, 2);

	aRelease.resolve();
	const results = await batch;
	t.deepEqual(results, ['A', 'B', 'C']);
});

test('abort does not start permit-pending items', async t => {
	const aStarted = deferred();
	const aRelease = deferred();
	let bCalled = false;

	const a = async () => {
		aStarted.resolve();
		await aRelease.promise;
		return 'A';
	};

	const b = async () => {
		bCalled = true;
		return 'B';
	};

	const controller = new AbortController();
	const batch = pRetryBatch([a, b], {
		concurrency: 1,
		signal: controller.signal,
		retries: 2,
		minTimeout: 0,
	});

	await aStarted.promise; // A holds the permit
	controller.abort(new Error('cancelled'));

	await t.throwsAsync(batch, {message: 'cancelled'});
	t.false(bCalled, 'B should never be called after abort');

	aRelease.resolve();
	await batch.drain();
	t.false(bCalled, 'B should still not be called after drain');
});

test('drain waits for in-flight attempts after abort', async t => {
	const aStarted = deferred();
	const aRelease = deferred();
	let aInFlight = false;

	const a = async () => {
		aInFlight = true;
		aStarted.resolve();
		await aRelease.promise;
		aInFlight = false;
		return 'A';
	};

	const controller = new AbortController();
	const batch = pRetryBatch([a], {
		concurrency: 1,
		signal: controller.signal,
		retries: 2,
		minTimeout: 0,
	});

	await aStarted.promise;
	controller.abort(new Error('cancelled'));
	await t.throwsAsync(batch, {message: 'cancelled'});

	t.true(aInFlight, 'A should still be in flight holding the permit');
	aRelease.resolve();
	await batch.drain();
	t.false(aInFlight, 'A should have settled after drain');
});

test('one item failure does not cancel other items', async t => {
	const bRelease = deferred();
	let bAttempts = 0;

	const a = async () => {
		throw new Error('A always fails');
	};

	const b = async () => {
		bAttempts++;
		await bRelease.promise;
		return 'B';
	};

	const batch = pRetryBatch([a, b], {concurrency: 1, retries: 0, minTimeout: 0});

	await t.throwsAsync(batch, {message: 'A always fails'});
	bRelease.resolve();
	await batch.drain();
	t.is(bAttempts, 1);
});

test('drain waits for all items to settle', async t => {
	const bRelease = deferred();
	let bSettled = false;

	const a = async () => {
		throw new Error('A fails');
	};

	const b = async () => {
		await bRelease.promise;
		bSettled = true;
		return 'B';
	};

	const batch = pRetryBatch([a, b], {concurrency: 1, retries: 0, minTimeout: 0});

	await t.throwsAsync(batch, {message: 'A fails'});
	t.false(bSettled, 'B should still be running');

	bRelease.resolve();
	await batch.drain();
	t.true(bSettled, 'B should have settled after drain');
});

test('empty inputs resolve to an empty array', async t => {
	const batch = pRetryBatch([], {concurrency: 2});
	const results = await batch;
	t.deepEqual(results, []);
	await batch.drain();
});

test('invalid inputs throw', t => {
	t.throws(() => pRetryBatch('not-an-array'), {message: /array/});
	t.throws(() => pRetryBatch([() => {}, 'not-a-function']), {message: /function/});
});

test('invalid concurrency throws', t => {
	t.throws(() => pRetryBatch([], {concurrency: 0}), {message: /concurrency.*1/});
	t.throws(() => pRetryBatch([], {concurrency: 1.5}), {message: /integer/});
	t.throws(() => pRetryBatch([], {concurrency: '2'}), {message: /number/});
	t.throws(() => pRetryBatch([], {concurrency: Number.NaN}), {message: /number/});
});

test('each item has independent retry state', async t => {
	const attempts = [];
	const inputs = [
		async attemptNumber => {
			attempts.push(`a:${attemptNumber}`);
			return attemptNumber === 2 ? 'A' : Promise.reject(new Error('fail'));
		},
		async attemptNumber => {
			attempts.push(`b:${attemptNumber}`);
			return attemptNumber === 3 ? 'B' : Promise.reject(new Error('fail'));
		},
	];

	const results = await pRetryBatch(inputs, {
		concurrency: 2,
		retries: 5,
		minTimeout: 0,
	});

	t.deepEqual(results, ['A', 'B']);
	t.deepEqual(attempts, ['a:1', 'b:1', 'a:2', 'b:2', 'b:3']);
});

test('abort during backoff cancels the wait', async t => {
	const controller = new AbortController();
	const start = Date.now();

	const batch = pRetryBatch([
		async () => {
			throw new Error('retry');
		},
	], {
		concurrency: 1,
		signal: controller.signal,
		retries: 5,
		minTimeout: 5000,
		factor: 2,
	});

	setTimeout(() => controller.abort(new Error('cancelled')), 50);
	await t.throwsAsync(batch, {message: 'cancelled'});
	t.true(Date.now() - start < 1000, 'should not wait for the long backoff');
});
