import {expectType} from 'tsd';
import pRetryCommitted, {
	UnknownResultError,
	type CommittedAttemptContext,
	type CommittedFailureContext,
} from './committed.js';

expectType<Promise<string>>(pRetryCommitted(async attempt => {
	expectType<CommittedAttemptContext>(attempt);
	expectType<number>(attempt.attemptNumber);
	expectType<() => void>(attempt.commit);
	attempt.commit();
	return 'value';
}));

expectType<Promise<string>>(pRetryCommitted(async () => 'value', {
	onCommittedFailure(context) {
		expectType<CommittedFailureContext>(context);
		expectType<Error>(context.error);
		expectType<number>(context.attemptNumber);
		return false;
	},
}));

expectType<Promise<string>>(pRetryCommitted(async () => 'value', {
	async onCommittedFailure() {
		return true;
	},
}));

expectType<Promise<string>>(pRetryCommitted(async () => 'value', {
	retries: 3,
	minTimeout: 0,
}));

const unknownResult = new UnknownResultError(new Error('x'));
expectType<UnknownResultError>(unknownResult);
expectType<true>(unknownResult.unknownResult);
expectType<Error>(unknownResult.originalError);
