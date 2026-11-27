import type { Pool } from "pg";
import type { RequestHintCommand } from "../../contracts/activity.js";
import { getActivity, listActivities, requestHint } from "../../activities/activities.js";
import { readActivityConversation, sendActivityMessage, type ActivityMessageInput } from "./conversation.js";
import { startDiscussionActivity } from "./discussion-activities.js";

export function createActivityService(pool: Pool) {
  return {
    listActivities: (userId: string) => listActivities(pool, userId),
    getActivity: (userId: string, activityId: string) => getActivity(pool, userId, activityId),
    requestHint: (userId: string, command: RequestHintCommand) => requestHint(pool, userId, command),
    startDiscussionActivity: (userId: string, requestId: string) => startDiscussionActivity(pool, userId, requestId),
    readConversation: (userId: string, activityId: string) => readActivityConversation(pool, { userId, activityId }),
    sendMessage: (userId: string, activityId: string, message: ActivityMessageInput) =>
      sendActivityMessage(pool, { userId, activityId }, message),
  };
}
