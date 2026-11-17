import { useNotifications } from './notifications'
import { invoke, isTauri } from './tauri'

export type FeedbackKind = 'bug' | 'idea'

export interface FeedbackSubmission {
  kind: FeedbackKind
  message: string
  contact?: string
  includeLog: boolean
}

export async function sendFeedback(input: FeedbackSubmission): Promise<void> {
  if (!isTauri()) {
    throw new Error('Отправка доступна только в настольной версии Nocturne')
  }
  await invoke('send_feedback', {
    kind: input.kind,
    message: input.message,
    contact: input.contact?.trim() || null,
    includeLog: input.includeLog,
  })
  void useNotifications.getState().refresh(true)
}
