import test from 'ava';
import pRetry, {pRetryBatch} from './index.js';

// A promise whose settlement is controlled manually by the test.
const deferred = () => Promise.withResolvers();

const tick = () => new Promise(resolve => {
	setTimeout(resolve, 5);
});

async function waitFor(condition) {
	for (let index = 0; index < 1000; index++) {
		if (condition()) {
			return;
		}

		await tick();
	}

	throw new Error('Timed out waiting for condition');
}

test('batch: concurrency 1 - permit released while A is stuck in failure callback, B succeeds, A retries after', async t => {
	const gate = deferred();
	const events = [];
	let aAttempts = 0;
	let aCallbackBlocked = false;

	const batch = pRetryBatch([
		async () => { // A
			aAttempts++;
			events.push('A:attempt:' + aAttempts);

			if (aAttempts === 1) {
				throw new Error('A failed once');
			}

			return 'A';
		},
		async () => { // B
			events.push('B:ran');
			return 'B';
		},
	], {
		concurrency: 1,
		retries: 2,
		minTimeout: 0,
		onFailedAttempt({index}) {
			events.push('failed:' + index);

			if (index === 0 && !aCallbackBlocked) {
				aCallbackBlocked = true;
				// A stays stuck here, without holding the permit.
				return gate.promise;
			}
		},
	});

	// B must be able to finish while A is still blocked in the failure callback.
	await waitFor(() => batch.results[1] !== undefined);
	t.deepEqual(batch.results[1], {status: 'fulfilled', value: 'B'});
	t.is(aAttempts, 1, 'A has not retried while its callback is blocked');
	t.is(batch.results[0], undefined, 'A has not settled yet');
	t.true(events.includes('failed:0'));
	t.true(events.includes('B:ran'));

	// Unblock A: it retries and succeeds.
	gate.resolve();
	const results = await batch.promise;

	// The final result has exactly one fixed slot per input item, in input order.
	t.is(results.length, 2);
	t.deepEqual(results, [
		{status: 'fulfilled', value: 'A'},
		{status: 'fulfilled', value: 'B'},
	]);
	t.is(aAttempts, 2);
	t.is(events[0], 'A:attempt:1');
	t.is(events.at(-1), 'A:attempt:2');
});

test('batch: backoff wait does not hold a permit', async t => {
	const events = [];
	let aAttempts = 0;

	const batch = pRetryBatch([
		async () => {
			aAttempts++;
			events.push('A:attempt:' + aAttempts);

			if (aAttempts === 1) {
				throw new Error('A failed once');
			}

			return 'A';
		},
		async () => {
			events.push('B:ran');
			return 'B';
		},
	], {
		concurrency: 1,
		retries: 1,
		minTimeout: 150,
	});

	const results = await batch.promise;

	t.deepEqual(results, [
		{status: 'fulfilled', value: 'A'},
		{status: 'fulfilled', value: 'B'},
	]);
	// B ran during the backoff wait of A, before the second attempt of A.
	t.deepEqual(events, ['A:attempt:1', 'B:ran', 'A:attempt:2']);
});

test('batch: results keep input order regardless of completion order', async t => {
	const batch = pRetryBatch([
		async () => {
			await new Promise(resolve => {
				setTimeout(resolve, 50);
			});
			return 'slow';
		},
		async () => 'fast',
	], {concurrency: 2, minTimeout: 0});

	const results = await batch.promise;

	t.deepEqual(results, [
		{status: 'fulfilled', value: 'slow'},
		{status: 'fulfilled', value: 'fast'},
	]);
});

test('batch: a failing item does not cancel the other items', async t => {
	const fixtureError = new Error('permanent failure');
	let bRuns = 0;

	const batch = pRetryBatch([
		async () => {
			throw fixtureError;
		},
		async () => {
			bRuns++;
			return 'B';
		},
	], {concurrency: 2, retries: 1, minTimeout: 0});

	const results = await batch.promise;

	t.is(results.length, 2);
	t.is(results[0].status, 'rejected');
	t.is(results[0].reason, fixtureError);
	t.deepEqual(results[1], {status: 'fulfilled', value: 'B'});
	t.is(bRuns, 1);
});

test('batch: cancel rejects permit-waiting items without calling their function, in-flight function keeps permit until drain', async t => {
	const gate = deferred();
	const cancelReason = new Error('cancelled by test');
	let aStarted = false;
	let aFinished = false;
	let bCalls = 0;

	const batch = pRetryBatch([
		async () => { // Non-cooperative: ignores cancellation.
			aStarted = true;
			const value = await gate.promise;
			aFinished = true;
			return value;
		},
		async () => {
			bCalls++;
			return 'B';
		},
	], {concurrency: 1, retries: 3, minTimeout: 0});

	await waitFor(() => aStarted);

	batch.cancel(cancelReason);

	// The permit-waiting item is rejected and its function is never called.
	await waitFor(() => batch.results[1] !== undefined);
	t.is(bCalls, 0);
	t.deepEqual(batch.results[1], {status: 'rejected', reason: cancelReason});

	// The in-flight function still holds its permit: drain() is pending.
	let drained = false;
	const drainPromise = (async () => {
		await batch.drain();
		drained = true;
	})();

	await tick();
	t.false(drained);
	t.false(aFinished);

	// Once the in-flight function settles, the permit is released and drain resolves.
	gate.resolve('A');
	await drainPromise;
	t.true(drained);
	t.true(aFinished);

	const results = await batch.promise;
	t.is(results.length, 2);
	t.deepEqual(results[0], {status: 'rejected', reason: cancelReason});
	t.deepEqual(results[1], {status: 'rejected', reason: cancelReason});

	// Releasing the permit after cancellation must not start the waiting item.
	t.is(bCalls, 0);
});

test('batch: cancelling before any attempt prevents all function calls', async t => {
	let calls = 0;
	const batch = pRetryBatch([
		async () => {
			calls++;
			return 'A';
		},
		async () => {
			calls++;
			return 'B';
		},
	], {concurrency: 2});

	batch.cancel();

	const results = await batch.promise;

	t.is(calls, 0);
	t.is(results.length, 2);
	t.true(results.every(result => result.status === 'rejected'));
});

test('batch: concurrency limits simultaneous function calls', async t => {
	let active = 0;
	let maxActive = 0;

	const task = async () => {
		active++;
		maxActive = Math.max(maxActive, active);
		await new Promise(resolve => {
			setTimeout(resolve, 20);
		});
		active--;
		return true;
	};

	const batch = pRetryBatch(Array.from({length: 5}, () => task), {concurrency: 2, minTimeout: 0});
	const results = await batch.promise;

	t.is(maxActive, 2);
	t.true(results.every(result => result.status === 'fulfilled'));
});

test('batch: retries are independent per item', async t => {
	const attempts = [0, 0];

	const batch = pRetryBatch([0, 1].map(index => async () => {
		attempts[index]++;

		if (attempts[index] <= index + 1) {
			throw new Error('fail ' + index);
		}

		return index;
	}), {concurrency: 2, retries: 5, minTimeout: 0});

	const results = await batch.promise;

	t.deepEqual(results, [
		{status: 'fulfilled', value: 0},
		{status: 'fulfilled', value: 1},
	]);
	t.deepEqual(attempts, [2, 3]);
});

test('batch: drain resolves immediately when idle', async t => {
	const batch = pRetryBatch([async () => 'A'], {concurrency: 1, minTimeout: 0});
	await batch.promise;
	await batch.drain();
	t.pass();
});

test('batch: empty task list resolves to an empty result array', async t => {
	const batch = pRetryBatch([], {concurrency: 1});
	t.deepEqual(await batch.promise, []);
	await batch.drain();
});

test('batch: user signal cancels the batch', async t => {
	const controller = new AbortController();
	const gate = deferred();
	let calls = 0;

	const batch = pRetryBatch([
		async () => {
			calls++;
			await gate.promise;
			return 'A';
		},
		async () => {
			calls++;
			return 'B';
		},
	], {concurrency: 1, signal: controller.signal, minTimeout: 0});

	await waitFor(() => calls === 1);
	controller.abort();

	// The in-flight non-cooperative call is not interrupted; let it settle.
	gate.resolve();

	const results = await batch.promise;
	t.is(calls, 1);
	t.true(results.every(result => result.status === 'rejected'));
});

test('batch: validates input', t => {
	t.throws(() => pRetryBatch(null), {instanceOf: TypeError});
	t.throws(() => pRetryBatch([1]), {instanceOf: TypeError});
	t.throws(() => pRetryBatch([], {concurrency: 0}), {instanceOf: TypeError});
	t.throws(() => pRetryBatch([], {concurrency: 1.5}), {instanceOf: TypeError});
	t.throws(() => pRetryBatch([], {concurrency: Number.NaN}), {instanceOf: TypeError});
});

test('batch: callbacks receive the item index', async t => {
	const seen = [];

	const batch = pRetryBatch([
		async () => {
			throw new Error('nope');
		},
	], {
		retries: 0,
		minTimeout: 0,
		onFailedAttempt(context) {
			seen.push(context.index);
		},
	});

	await batch.promise;
	t.deepEqual(seen, [0]);
});

test('batch: pRetry default export is unaffected', async t => {
	const value = await pRetry(async () => 'ok', {minTimeout: 0});
	t.is(value, 'ok');
});
