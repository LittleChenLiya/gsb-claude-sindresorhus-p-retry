import {describe, it} from 'node:test';
import assert from 'node:assert/strict';
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

// Return the rejection error, or throw if the promise fulfills.
const rejects = async promise => {
	try {
		await promise;
	} catch (error) {
		return error;
	}

	throw new Error('Expected promise to reject');
};

describe('abortableCallbacks', () => {
	it('abort during stuck shouldRetry terminates the wait promptly', async () => {
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

		await assert.rejects(promise, fixtureError);
		assert.equal(inputCalls, 1);
		assert.equal(shouldRetryCalls, 1);

		// The late resolution is only cleanup: no new attempt, no extra callback.
		resolveShouldRetry(true);
		await new Promise(resolve => {
			setImmediate(resolve);
		});

		assert.equal(inputCalls, 1);
		assert.equal(shouldRetryCalls, 1);
	});

	it('abort during stuck shouldConsumeRetry terminates the wait promptly', async () => {
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

		await assert.rejects(promise, fixtureError);
		assert.equal(inputCalls, 1);
		assert.equal(shouldConsumeRetryCalls, 1);
		assert.equal(onFailedAttemptCalls, 0);
		assert.equal(shouldRetryCalls, 0);

		// Late resolution cannot start a new attempt or call downstream callbacks.
		resolveShouldConsumeRetry(true);
		await new Promise(resolve => {
			setImmediate(resolve);
		});

		assert.equal(inputCalls, 1);
		assert.equal(shouldConsumeRetryCalls, 1);
		assert.equal(onFailedAttemptCalls, 0);
		assert.equal(shouldRetryCalls, 0);
	});

	it('abort during stuck onFailedAttempt terminates the wait promptly', async () => {
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

		await assert.rejects(promise, fixtureError);
		assert.equal(inputCalls, 1);
		assert.equal(onFailedAttemptCalls, 1);
		assert.equal(shouldRetryCalls, 0);

		resolveOnFailedAttempt();
		await new Promise(resolve => {
			setImmediate(resolve);
		});

		assert.equal(inputCalls, 1);
		assert.equal(onFailedAttemptCalls, 1);
		assert.equal(shouldRetryCalls, 0);
	});

	it('late callback rejection after abort does not become an unhandled rejection', async () => {
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

		await assert.rejects(promise, fixtureError);

		// Rejecting after the abort must not surface as an unhandled rejection.
		rejectShouldRetry(new Error('late rejection'));
		await new Promise(resolve => {
			setImmediate(resolve);
		});
	});

	it('default behavior is unchanged: abort does not terminate callback wait', async () => {
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

		const error = await rejects(promise);
		assert.equal(error.message, 'fail');
		assert.equal(inputCalls, 1);
		assert.equal(shouldRetryCalls, 1);
	});

	it('abortableCallbacks without a signal has no effect', async () => {
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

		await assert.rejects(promise, {message: 'fail'});
		assert.equal(inputCalls, 1);
		assert.equal(shouldRetryCalls, 1);
	});

	it('callback exception preserves its cause', async () => {
		const cause = new Error('cause');
		const callbackError = new Error('callback failed', {cause});

		const error = await rejects(pRetry(async () => {
			throw new Error('input');
		}, {
			abortableCallbacks: true,
			shouldRetry() {
				throw callbackError;
			},
		}));

		assert.equal(error, callbackError);
		assert.equal(error.cause, cause);
	});

	it('throws on invalid abortableCallbacks option', async () => {
		await assert.rejects(pRetry(async () => {}, {
			abortableCallbacks: 'yes',
		}), {
			message: 'Expected `abortableCallbacks` to be a boolean.',
		});
	});

	it('retry count is snapshotted at termination', async () => {
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

		await assert.rejects(promise, fixtureError);

		// The completed attempt record is not rolled back and no new attempts start.
		assert.equal(contexts.length, 1);
		assert.equal(contexts[0].attemptNumber, 1);
		assert.equal(contexts[0].retriesConsumed, 0);
		assert.equal(contexts[0].retriesLeft, 5);

		resolveShouldRetry(true);
		await new Promise(resolve => {
			setImmediate(resolve);
		});

		assert.equal(contexts.length, 1);
	});
});
