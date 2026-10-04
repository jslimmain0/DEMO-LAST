import { useEffect, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { AppShellTier1 } from '../app/AppShell'
import { useWorkspace } from '../app/WorkspaceContext'
import { EnvManagerPanel } from '../components/EnvManagerDialog'
import { SecretsPanel } from '../components/SecretsDialog'
import { useUnsavedNavigation } from '../components/UnsavedNavigation'
import { useEnvironment, useEnvironmentSaveStatus } from '../lib/environments'
import './resources.css'
import { PageHeader } from '../components/PageHeader'
import { AppIcon } from '../components/AppIcon'

export function Resources() {
  const { scopeKey } = useWorkspace()
  const [params, setParams] = useSearchParams()
  const environment = useEnvironment()
  const saveStatus = useEnvironmentSaveStatus()
  const tab = params.get('tab') === 'secrets' ? 'secrets' : 'environments'
  const [dirty, setDirty] = useState(false)
  useUnsavedNavigation({
    dirty,
    saving: saveStatus === 'pending' || saveStatus === 'saving',
    label: '적용하지 않은 자원 입력',
    blockedReason: saveStatus === 'error' ? '환경 변수를 저장하지 못했습니다. 다시 저장한 뒤 이동하세요. 현재 입력은 유지됩니다.' : undefined,
  })
  useEffect(() => {
    if (saveStatus === 'pending') void environment.flushEnvStore()
  }, [saveStatus, environment])
  const changeTab = (next: string) => {
    setParams(previous => { const nextParams = new URLSearchParams(previous); nextParams.set('tab', next); return nextParams })
  }
  return <AppShellTier1><section className="fl-resources" aria-label="환경과 시크릿 관리">
    <PageHeader title="환경 · 시크릿" description="환경별 설정과 안전하게 보관할 값을 관리합니다."><div className="fl-section-tabs" role="tablist" aria-label="자원 종류"><button role="tab" id="environment-tab" aria-controls="resource-content" aria-selected={tab === 'environments'} onClick={() => changeTab('environments')}><AppIcon name="sliders" size={16} />환경 변수</button><button role="tab" id="secrets-tab" aria-controls="resource-content" aria-selected={tab === 'secrets'} onClick={() => changeTab('secrets')}><AppIcon name="key" size={16} />시크릿</button></div></PageHeader>
    <div key={`${scopeKey}:${tab}`} id="resource-content" role="tabpanel" aria-labelledby={tab === 'environments' ? 'environment-tab' : 'secrets-tab'} className="fl-resource-content">{tab === 'environments' ? <EnvManagerPanel compact onDraftChange={setDirty} /> : <SecretsPanel compact onDraftChange={setDirty} />}</div>
  </section></AppShellTier1>
}
