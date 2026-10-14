import { useQuery } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { useAuth } from '../auth/AuthContext'
import { desktopApi } from '../auth/desktop'
import { desktopUpdateStatusKey, setUpdateNotice, updateNoticeChanged, updateNoticeKey, updateNoticeVisible } from '../lib/desktopUpdateNotice'
import { ui } from '../design/ui'
import { AppIcon } from './AppIcon'

export function DesktopUpdateNotice({ onOpen }: { onOpen: () => void }) {
  const { desktop } = useAuth()
  const status = useQuery({ queryKey: desktopUpdateStatusKey, queryFn: desktopApi.updateStatus, enabled: !!desktop,
    retry: false, staleTime: 30_000, refetchInterval: desktop ? 60_000 : false, refetchIntervalInBackground: false })
  const [, setRevision] = useState(0)
  useEffect(() => {
    if (!desktop) return
    const refresh = () => setRevision(value => value + 1)
    const timer = window.setInterval(refresh, 60_000)
    window.addEventListener('storage', refresh)
    window.addEventListener(updateNoticeChanged, refresh)
    return () => { window.clearInterval(timer); window.removeEventListener('storage', refresh); window.removeEventListener(updateNoticeChanged, refresh) }
  }, [desktop])
  const info = status.data
  if (!desktop || status.isError || !info || (!info.loginRequired && !['available', 'ready'].includes(info.phase))) return null
  const key = updateNoticeKey(desktop, info)
  if (!updateNoticeVisible(key)) return null
  const label = info.loginRequired ? '업데이트 완료 · 다시 로그인' : `새 버전 ${info.availableVersion}`
  return <section className="fl-update-notice" aria-label="앱 업데이트 알림">
    <button className="fl-update-notice-open" onClick={onOpen} title={`${label} · 업데이트 보기`} aria-label={`${label} · 업데이트 보기`}>
      <AppIcon name={info.loginRequired ? 'user' : 'download'} size={17} /><span><strong role="status">{label}</strong><small>{info.loginRequired ? '회사 계정 로그인이 필요합니다' : info.phase === 'ready' ? '설치 준비 완료 · 직접 설치' : '변경 내용과 설치 안내 보기'}</small></span>
    </button>
    <div className="fl-update-notice-options">
      <button style={ui.mini} onClick={() => setUpdateNotice(key, Date.now() + 86_400_000)}>내일 다시 알림</button>
      {!info.loginRequired && <button style={ui.mini} onClick={() => setUpdateNotice(key, 'hidden')}>이번 버전 숨김</button>}
    </div>
  </section>
}
