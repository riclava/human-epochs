import type { Pool } from "pg";
import type { RequestHintCommand } from "../../contracts/learning.js";
import { getActivity, listActivities, requestHint } from "../../activities/activities.js";
import { readActivityDiscussion, sendActivityMessage, type ActivityMessageInput } from "./discussion.js";
import { startPractice } from "./practice.js";

export function createActivityService(pool: Pool) {
  return {
    listActivities: (learnerId: string) => listActivities(pool, learnerId),
    getActivity: (learnerId: string, activityId: string) => getActivity(pool, learnerId, activityId),
    requestHint: (learnerId: string, command: RequestHintCommand) => requestHint(pool, learnerId, command),
    startPractice: (learnerId: string, requestId: string) => startPractice(pool, learnerId, requestId),
    readDiscussion: (learnerId: string, activityId: string) => readActivityDiscussion(pool, { learnerId, activityId }),
    sendMessage: (learnerId: string, activityId: string, message: ActivityMessageInput) =>
      sendActivityMessage(pool, { learnerId, activityId }, message),
  };
}
