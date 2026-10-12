import { useEffect, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { AppShellTier1 } from '../app/AppShell'
import { useWorkspace } from '../app/WorkspaceContext'
import { EnvironmentManagement } from '../components/EnvManagerDialog'
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
    label: '적용하지 않은 자원 입력',
  })
  useEffect(() => {
    if (saveStatus === 'pending') void environment.flushEnvStore()
  }, [saveStatus, environment])
  const changeTab = (next: string) => {
    setParams(previous => { const nextParams = new URLSearchParams(previous); nextParams.set('tab', next); return nextParams })
  }
  return <AppShellTier1><section className="fl-resources" aria-label="환경과 시크릿 관리">
    <PageHeader title={tab === 'environments' ? '환경 변수' : '시크릿'} description={tab === 'environments' ? '내 PC와 서버의 환경을 함께 관리합니다. 실행할 때는 출처와 환경을 선택하세요.' : '시크릿은 서버 공통 자원입니다. 저장된 값은 표시되지 않습니다.'}><div className="fl-section-tabs" role="tablist" aria-label="자원 종류"><button role="tab" id="environment-tab" aria-controls="resource-content" aria-selected={tab === 'environments'} onClick={() => changeTab('environments')}><AppIcon name="sliders" size={16} />환경 변수</button><button role="tab" id="secrets-tab" aria-controls="resource-content" aria-selected={tab === 'secrets'} onClick={() => changeTab('secrets')}><AppIcon name="key" size={16} />시크릿</button></div></PageHeader>
    <div key={`${scopeKey}:${tab}`} id="resource-content" role="tabpanel" aria-labelledby={tab === 'environments' ? 'environment-tab' : 'secrets-tab'} className="fl-resource-content">{tab === 'environments' ? <EnvironmentManagement onDraftChange={setDirty} /> : <SecretsPanel compact onDraftChange={setDirty} />}</div>
  </section></AppShellTier1>
}
