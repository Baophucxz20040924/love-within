import { registerProposalHandler } from '../proposal.service.js';
import { anniversaryHandler } from './anniversary.handler.js';
import { waterGoalHandler } from './waterGoal.handler.js';
import { savingsGoalHandler, savingsGoalUpdateHandler } from './savings.handler.js';

/** Register every dual-approval handler. Called once at app startup. */
export function registerAllProposalHandlers(): void {
  registerProposalHandler(anniversaryHandler);
  registerProposalHandler(waterGoalHandler);
  registerProposalHandler(savingsGoalHandler);
  registerProposalHandler(savingsGoalUpdateHandler);
}
