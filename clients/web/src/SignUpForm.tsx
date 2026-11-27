import { useEffect, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { passwordMinLength } from '../../../src/contracts/session'
import { HttpError, request } from './api'

const signUpErrors: Record<number | 'unavailable', { text: string; field?: 'email' | 'password' }> = {
  409: { text: '这个邮箱已经注册。请直接登录，或换一个邮箱。', field: 'email' },
  400: { text: `请检查邮箱格式，名字不超过 40 个字，密码至少 ${passwordMinLength} 位。`, field: 'email' },
  429: { text: '注册太频繁。请一小时后再试。' },
  403: { text: '暂未开放注册。请联系部署方开通账号。' },
  unavailable: { text: '暂时无法注册。请检查网络连接后重试。' },
}

// Creating an account signs the new user in, so success hands over to the same session check as signing in.
export function SignUpForm({ onSuccess, onSignIn }: { onSuccess: () => void; onSignIn: () => void }) {
  const [error, setError] = useState<keyof typeof signUpErrors | null>(null)
  const [pending, setPending] = useState(false)
  const title = useRef<HTMLHeadingElement>(null)
  const email = useRef<HTMLInputElement>(null)
  const submitButton = useRef<HTMLButtonElement>(null)
  const problem = error === null ? null : signUpErrors[error]!

  useEffect(() => { title.current?.focus() }, [])
  useEffect(() => {
    if (problem?.field === 'email') email.current?.focus()
    else if (problem) submitButton.current?.focus()
  }, [problem])

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (pending) return
    const form = new FormData(event.currentTarget)
    setPending(true)
    setError(null)
    try {
      await request('/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: String(form.get('email')).trim(), displayName: String(form.get('displayName')).trim(), password: form.get('password'),
        }),
      })
      onSuccess()
    } catch (cause) {
      setError(cause instanceof HttpError && cause.status in signUpErrors ? cause.status : 'unavailable')
      setPending(false)
    }
  }

  const invalid = (field: 'email' | 'password') => problem?.field === field || (error === 400 && field === 'password') || undefined
  const described = (field: 'email' | 'password') => invalid(field) ? 'sign-up-error' : undefined
  return <form onSubmit={submit} onChange={() => setError(null)} aria-busy={pending}>
    <h1 id="login-title" ref={title} tabIndex={-1}>注册</h1>
    <p className="form-intro">注册后即可开始对话，对话、材料和记忆只有你自己能看到。</p>
    <label htmlFor="sign-up-email">邮箱</label>
    <input ref={email} type="email" id="sign-up-email" name="email" required autoComplete="username" maxLength={254}
      placeholder="name@example.com" readOnly={pending} aria-invalid={invalid('email')} aria-describedby={described('email')} />
    <label htmlFor="sign-up-name">名字</label>
    <input id="sign-up-name" name="displayName" required autoComplete="nickname" maxLength={40} readOnly={pending} />
    <label htmlFor="sign-up-password">密码</label>
    <input type="password" id="sign-up-password" name="password" required autoComplete="new-password" minLength={passwordMinLength}
      maxLength={1024} readOnly={pending} aria-invalid={invalid('password')}
      aria-describedby={['sign-up-password-hint', described('password')].filter(Boolean).join(' ')} />
    <p id="sign-up-password-hint" className="field-hint">至少 {passwordMinLength} 位。</p>
    {problem && <p id="sign-up-error" className="form-error" role="alert">{problem.text}</p>}
    <button ref={submitButton} type="submit" className="primary" disabled={pending}>{pending ? '正在创建账号…' : '创建账号'}</button>
    <p className="login-switch">已有账号？<button type="button" className="link-button" onClick={onSignIn}>登录</button></p>
  </form>
}
