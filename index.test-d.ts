import {expectType} from 'tsd';
import pRetry, {AbortError, pRetryBatch, type Batch, type BatchResult, type RetryContext} from './index.js';

expectType<Promise<number>>(pRetry(async count => {
	expectType<number>(count);
	return 1;
}));
expectType<Promise<void>>(pRetry(() => {}, { // eslint-disable-line @typescript-eslint/no-empty-function
	onFailedAttempt(context) {
		expectType<RetryContext>(context);
		expectType<number>(context.attemptNumber);
		expectType<number>(context.retriesLeft);
		expectType<number>(context.retriesConsumed);
	},
}));
expectType<Promise<string>>(pRetry(() => 'foo', {
	retries: 5,
}));

expectType<Promise<string>>(pRetry(async () => 'value', {
	async shouldConsumeRetry(context) {
		expectType<RetryContext>(context);
		expectType<Error>(context.error);
		return true;
	},
	minTimeout: 0,
}));

const abortError = new AbortError('foo');
new AbortError(new Error('foo')); // eslint-disable-line no-new

expectType<AbortError>(abortError);

const batch = pRetryBatch([
	async () => 'a',
	async () => 'b',
], {
	concurrency: 1,
	retries: 2,
	onFailedAttempt(context) {
		expectType<number>(context.index);
		expectType<number>(context.attemptNumber);
	},
});

expectType<Batch<string>>(batch);
expectType<Promise<Array<BatchResult<string>>>>(batch.promise);
expectType<Array<BatchResult<string> | undefined>>(batch.results);
expectType<void>(batch.cancel(new Error('stop')));
expectType<Promise<void>>(batch.drain());
