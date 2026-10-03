import { createMessageBoard } from '../module';
const board = createMessageBoard({});
export default board.spacetimedb;
export const { register, post, createTask, applyPushPolicy, claimTask, updateTask, lock, unlock } = board;
