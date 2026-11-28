import { useEffect, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { passwordMinLength, type AccountCommand } from '../../../src/contracts/session'
import { HttpError, request } from './api'
import type { WorkspacePageProps } from './workspace-pages'
import { EmailVerification } from './EmailVerification'

type Section = 'name' | 'password' | 'delete'
type Outcome = { section: Section; kind: 'error' | 'done'; text: string }

const failureText = (error: unknown, section: Section) => {
  if (error instanceof HttpError && error.status === 403) return '密码不正确。请重新输入。'
  if (error instanceof HttpError && error.status === 400) {
    return section === 'name' ? '名字不能为空，也不能超过 40 个字。' : `新密码至少 ${passwordMinLength} 位。`
  }
  return '暂时无法保存。请检查网络连接后重试。'
}

export function AccountView({ user, heading, onUnauthorized, onAccountChanged, onAccountDeleted }: WorkspacePageProps) {
  const [pending, setPending] = useState<Section | null>(null)
  const [outcome, setOutcome] = useState<Outcome | null>(null)
  const [confirming, setConfirming] = useState(false)
  const dialog = useRef<HTMLDialogElement>(null)
  useEffect(() => { if (confirming) dialog.current?.showModal() }, [confirming])

  async function run(section: Section, command: AccountCommand, form?: HTMLFormElement) {
    if (pending) return
    setPending(section)
    setOutcome(null)
    try {
      await request('/account/commands', {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'X-User-Id': user.id }, body: JSON.stringify(command),
      })
      if (section === 'delete') return onAccountDeleted()
      form?.reset()
      setOutcome({ section, kind: 'done', text: section === 'name' ? '名字已更新。' : '密码已更新。其他设备上的登录已退出。' })
      if (section === 'name') onAccountChanged()
    } catch (error) {
      if (error instanceof HttpError && error.status === 401) return onUnauthorized()
      setOutcome({ section, kind: 'error', text: failureText(error, section) })
    } finally {
      setPending(null)
    }
  }

  const value = (event: FormEvent<HTMLFormElement>, name: string) => String(new FormData(event.currentTarget).get(name) ?? '')
  const message = (section: Section) => outcome?.section === section
    ? <p id={`account-${section}-message`} role={outcome.kind === 'error' ? 'alert' : 'status'}
      className={outcome.kind === 'error' ? 'form-error' : 'form-done'}>{outcome.text}</p>
    : null
  const errorFor = (section: Section) => outcome?.section === section && outcome.kind === 'error'
  const describedBy = (section: Section) => errorFor(section) ? `account-${section}-message` : undefined

  return <div className="settings-content account-page">
    <header className="settings-heading">
      <h1 id={heading.id} tabIndex={-1}>{heading.text}</h1>
      <p>登录邮箱：{user.email}</p>
      <EmailVerification user={user} onUnauthorized={onUnauthorized} onVerified={onAccountChanged} />
    </header>
    <div className="settings-form">
      <section className="settings-section" aria-labelledby="account-name-title">
        <div className="settings-section-heading"><h2 id="account-name-title">名字</h2><p>显示在侧栏的账号区。</p></div>
        <form className="account-form" onSubmit={event => {
          event.preventDefault()
          void run('name', { operation: 'rename', displayName: value(event, 'displayName').trim() })
        }}>
          <label htmlFor="account-name">名字</label>
          <input id="account-name" name="displayName" required maxLength={40} defaultValue={user.displayName} autoComplete="nickname"
            aria-invalid={errorFor('name') || undefined} aria-describedby={describedBy('name')} />
          {message('name')}
          <button type="submit" disabled={!!pending}>{pending === 'name' ? '正在保存…' : '保存名字'}</button>
        </form>
      </section>
      <section className="settings-section" aria-labelledby="account-password-title">
        <div className="settings-section-heading"><h2 id="account-password-title">密码</h2><p>修改后，其他设备上的登录会退出，这台设备保持登录。</p></div>
        <form className="account-form" onSubmit={event => {
          event.preventDefault()
          const form = event.currentTarget
          void run('password', { operation: 'change_password', currentPassword: value(event, 'current'), newPassword: value(event, 'next') }, form)
        }}>
          <label htmlFor="account-current-password">当前密码</label>
          <input type="password" id="account-current-password" name="current" required maxLength={1024} autoComplete="current-password"
            aria-invalid={errorFor('password') || undefined} aria-describedby={describedBy('password')} />
          <label htmlFor="account-new-password">新密码</label>
          <input type="password" id="account-new-password" name="next" required minLength={passwordMinLength} maxLength={1024}
            autoComplete="new-password" aria-describedby="account-new-password-hint" />
          <p id="account-new-password-hint" className="field-hint">至少 {passwordMinLength} 位。</p>
          {message('password')}
          <button type="submit" disabled={!!pending}>{pending === 'password' ? '正在保存…' : '修改密码'}</button>
        </form>
      </section>
      <section className="settings-section" aria-labelledby="account-export-title">
        <div className="settings-section-heading"><h2 id="account-export-title">导出数据</h2>
          <p>下载一份 JSON 文件，包含你的对话、材料全文、记忆、学习目标和复习记录。</p></div>
        <div><a className="button-link" href="/api/account/export" download>下载我的数据</a></div>
      </section>
      <section className="settings-section" aria-labelledby="account-delete-title">
        <div className="settings-section-heading"><h2 id="account-delete-title">删除账号</h2>
          <p>你的对话、材料、记忆和复习记录会全部删除，无法恢复。</p></div>
        <div><button type="button" className="danger" onClick={() => { setOutcome(null); setConfirming(true) }}>删除账号…</button></div>
      </section>
    </div>
    <dialog ref={dialog} className="memory-dialog" aria-labelledby="account-delete-dialog-title"
      onCancel={event => { if (pending) event.preventDefault() }} onClose={() => { setConfirming(false); setOutcome(null) }}>
      <form className="account-form" onSubmit={event => {
        event.preventDefault()
        void run('delete', { operation: 'delete', password: value(event, 'password') })
      }}>
        <h2 id="account-delete-dialog-title">删除账号？</h2>
        <p>{user.email} 的对话、材料、记忆和复习记录会全部删除，无法恢复。请输入密码确认。</p>
        <label htmlFor="account-delete-password">密码</label>
        <input type="password" id="account-delete-password" name="password" required maxLength={1024} autoComplete="current-password"
          autoFocus aria-invalid={errorFor('delete') || undefined} aria-describedby={describedBy('delete')} />
        {message('delete')}
        <div className="memory-actions">
          <button type="button" disabled={!!pending} onClick={() => dialog.current?.close()}>取消</button>
          <button type="submit" className="danger" disabled={!!pending}>{pending === 'delete' ? '正在删除…' : '永久删除账号'}</button>
        </div>
      </form>
    </dialog>
  </div>
}
