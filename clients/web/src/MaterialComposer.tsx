import { attachmentLength, describeLabels, type ActiveDiscussion, type Attachment } from './material-draft'

const count = (value: number) => value.toLocaleString('zh-CN')

// Names a source after its first sentence, cut to a short label, when the user gives no name.
export function defaultLabel(text: string) {
  const firstLine = text.trim().split('\n')[0]?.trim() ?? ''
  const sentence = /^.+?[。！？.!?]/u.exec(firstLine)?.[0] ?? firstLine
  const characters = Array.from(sentence.replace(/[。！？.!?]$/u, ''))
  return characters.length > 20 ? characters.slice(0, 19).join('') + '…' : characters.join('') || '我的原文'
}

// Tells the user what the next message will carry: a new source, the continued discussion, or neither.
export function MaterialStatus({ attachment, discussion, leaveDiscussion, disabled, onRemove, onLeave, onContinue }: {
  attachment?: Attachment
  discussion: ActiveDiscussion | null
  leaveDiscussion: boolean
  disabled: boolean
  onRemove: () => void
  onLeave: () => void
  onContinue: () => void
}) {
  if (!attachment && !discussion) return null
  return <div className="material-status">
    {discussion && (leaveDiscussion
      ? <p><span>下一条消息不再讨论：{describeLabels(discussion.labels)}</span>
        <button type="button" disabled={disabled} onClick={onContinue}>继续讨论</button></p>
      : <p><span>接着讨论：{describeLabels(discussion.labels)}</span>
        <button type="button" disabled={disabled} onClick={onLeave}>结束讨论</button></p>)}
    {attachment && <p><span>{'materialId' in attachment ? '已选材料' : '已附原文'}：{attachment.label}（{count(attachmentLength(attachment))} 字）</span>
      <button type="button" disabled={disabled} onClick={onRemove} aria-label={`移除原文 ${attachment.label}`}>移除</button></p>}
  </div>
}
