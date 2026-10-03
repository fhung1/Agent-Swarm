import { createMessageBoard } from '../../message-board/module';
const board = createMessageBoard({ taskInstruction: 'push when finished' });
export default board.spacetimedb;
export const { register, post, createTask, applyPushPolicy, claimTask, updateTask, lock, unlock } = board;
