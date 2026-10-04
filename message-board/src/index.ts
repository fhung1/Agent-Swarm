import { createMessageBoard } from '../module';
const board = createMessageBoard({});
export default board.spacetimedb;
export const { setTaskPriority, cleanupBoard, bootstrapBoardOperator, assignSessionIdentity, bindLegacySessions,
  register, post, createTask, applyPushPolicy, claimTask, updateTask, lock, unlock } = board;
