import { useCallback, useEffect, useState } from 'react'
import type { LearningGoal, LearningGoalCommand, LearningGoalList } from '../../../src/contracts/learning-goal'
import { HttpError, request } from './api'

// What a refused command tells the user. The server's message names the limit or the conflict.
async function refusal(error: unknown) {
  if (error instanceof HttpError && error.response) {
    const body = await error.response.json().catch(() => null) as { message?: string } | null
    if (body?.message) return body.message
  }
  return '暂时无法保存。请检查网络连接后重试。'
}

export function useLearningGoals(userId: string, onUnauthorized: () => void) {
  const [goals, setGoals] = useState<LearningGoal[] | null>(null)
  const [loadError, setLoadError] = useState(false)

  const load = useCallback(async (signal?: AbortSignal) => {
    try {
      const response = await request('/learning-goals', { headers: { 'X-User-Id': userId }, signal })
      setGoals((await response.json() as LearningGoalList).goals)
      setLoadError(false)
    } catch (error) {
      if (signal?.aborted) return
      if (error instanceof HttpError && error.status === 401) onUnauthorized()
      else setLoadError(true)
    }
  }, [userId, onUnauthorized])

  useEffect(() => {
    const controller = new AbortController()
    void load(controller.signal)
    return () => controller.abort()
  }, [load])

  // Runs one command and returns null on success, or the reason it was refused. A conflict reloads the list so the
  // next attempt starts from what the other device saved.
  const run = useCallback(async (command: LearningGoalCommand): Promise<string | null> => {
    try {
      const response = await request('/learning-goals/commands', {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'X-User-Id': userId }, body: JSON.stringify(command),
      })
      setGoals((await response.json() as LearningGoalList).goals)
      return null
    } catch (error) {
      if (error instanceof HttpError && error.status === 401) {
        onUnauthorized()
        return '登录状态已结束。'
      }
      if (error instanceof HttpError && (error.status === 409 || error.status === 404)) void load()
      return refusal(error)
    }
  }, [userId, onUnauthorized, load])

  return { goals, loadError, reload: load, run }
}
